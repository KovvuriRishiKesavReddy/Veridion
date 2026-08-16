const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');

const router = express.Router();

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:4100';

// notifyGrnConfirmed: fire-and-forget HTTP call to ai-service's Agent 5 trigger. If
// ai-service is down or unreachable, this must NEVER fail the GRN submission — the
// GRN is already safely in Postgres; the vendor risk score update is a separate
// concern, same pattern as the RabbitMQ publish in invoices.js.
async function notifyGrnConfirmed(poId, grnId) {
  try {
    const res = await fetch(`${AI_SERVICE_URL}/agents/vendor-risk/on-grn-confirmed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ po_id: poId, grn_id: grnId })
    });
    if (!res.ok) console.error(`on-grn-confirmed call failed (${res.status}) for PO ${poId} — GRN itself still succeeded.`);
  } catch (err) {
    console.error(`Could not reach ai-service for on-grn-confirmed (GRN itself still succeeded):`, err.message);
  }
}

// POST /api/grn (warehouse)
// Fulfillment is tracked CUMULATIVELY across every GRN recorded against a PO — not just
// the latest single delivery. This is what lets a warehouse team close out a shortfall:
// PO agreed 100 -> GRN #1 records 90 (partially_fulfilled, 10 remaining) -> GRN #2 records
// the remaining 10 -> cumulative total now 100 -> PO flips to fulfilled automatically.
router.post('/', requireAuth, requireRole('warehouse'), async (req, res) => {
  const { po_id, received_quantity, received_date, warehouse_notes, expected_next_delivery_date, next_delivery_notes } = req.body;
  if (!po_id || received_quantity === undefined || !received_date) {
    return res.status(400).json({ error: 'po_id, received_quantity, received_date are required' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock the PO row so two concurrent GRN submissions against the same PO can't both
    // read the same "prior total" and produce an inconsistent cumulative fulfillment status.
    const poRes = await client.query(`SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [po_id]);
    const po = poRes.rows[0];
    if (!po || po.company_id !== req.user.company_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'PO not found' });
    }
    if (po.fulfillment_status === 'fulfilled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This PO is already fully fulfilled — no further GRNs needed.' });
    }

    const priorRes = await client.query(
      `SELECT COALESCE(SUM(received_quantity), 0) as prior_total FROM goods_receipt_notes WHERE po_id = $1`,
      [po_id]
    );
    const priorTotal = Number(priorRes.rows[0].prior_total);
    const receivedNum = Number(received_quantity);
    const agreedNum = Number(po.agreed_quantity);
    const newTotal = priorTotal + receivedNum;

    const isShortfall = newTotal < agreedNum;   // still remaining after this delivery
    const isOverage = newTotal > agreedNum;      // cumulative total exceeds what was agreed
    const discrepancyFlag = isShortfall || isOverage;
    const fulfillmentStatus = isShortfall ? 'partially_fulfilled' : 'fulfilled';
    const remainingAfter = agreedNum - newTotal; // negative once in overage territory

    const grnRes = await client.query(
      `INSERT INTO goods_receipt_notes
        (po_id, received_quantity, received_date, warehouse_notes, recorded_by, discrepancy_flag, expected_next_delivery_date, next_delivery_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        po_id, received_quantity, received_date, warehouse_notes || null, req.user.id, discrepancyFlag,
        isShortfall ? (expected_next_delivery_date || null) : null,
        isShortfall ? (next_delivery_notes || null) : null
      ]
    );
    await client.query(`UPDATE purchase_orders SET fulfillment_status=$1 WHERE id=$2`, [fulfillmentStatus, po_id]);
    await client.query('COMMIT');

    res.status(201).json({
      ...grnRes.rows[0],
      agreed_quantity: po.agreed_quantity,
      cumulative_received: newTotal,
      remaining_quantity: remainingAfter > 0 ? remainingAfter : 0,
      variance_quantity: newTotal - agreedNum, // cumulative variance: negative = still short, positive = overage, 0 = exact
      is_overage: isOverage,
      fulfillment_status: fulfillmentStatus
    });

    // Fire-and-forget, after the response — this is Agent 5's on-grn-confirmed trigger
    // (updates the vendor's running on_time_delivery_pct). Never blocks or fails the
    // GRN submission itself if ai-service happens to be down.
    notifyGrnConfirmed(po_id, grnRes.rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not record GRN' });
  } finally {
    client.release();
  }
});

// GET /api/grn/mine (warehouse) — this role's own submission history
router.get('/mine', requireAuth, requireRole('warehouse'), async (req, res) => {
  const result = await db.query(
    `SELECT g.*, po.agreed_quantity FROM goods_receipt_notes g
     JOIN purchase_orders po ON po.id = g.po_id
     WHERE po.company_id = $1 AND g.recorded_by = $2
     ORDER BY g.received_date DESC`,
    [req.user.company_id, req.user.id]
  );
  res.json(result.rows);
});

// GET /api/grn/company — every GRN across the whole company. No price fields at all —
// GRNs never carry pricing to begin with.
router.get('/company', requireAuth, requireRole('company_admin', 'procurement', 'finance', 'warehouse'), async (req, res) => {
  const result = await db.query(
    `SELECT g.*, po.agreed_quantity, po.fulfillment_status, po.requirement_id,
            v.company_name as vendor_name, r.title as requirement_title,
            u.name as recorded_by_name,
            SUM(g.received_quantity) OVER (PARTITION BY g.po_id ORDER BY g.received_date ASC, g.id ASC) as cumulative_received
     FROM goods_receipt_notes g
     JOIN purchase_orders po ON po.id = g.po_id
     JOIN vendors v ON v.id = po.vendor_id
     JOIN requirements r ON r.id = po.requirement_id
     JOIN users u ON u.id = g.recorded_by
     WHERE po.company_id = $1
     ORDER BY g.received_date DESC`,
    [req.user.company_id]
  );
  // variance_quantity is against the CUMULATIVE total after this delivery, not this
  // single row alone — otherwise a second delivery that closes out a shortfall (e.g.
  // "10" after an earlier "90") would misleadingly show as massively short on its own.
  const rows = result.rows.map(r => ({
    ...r,
    variance_quantity: Number(r.cumulative_received) - Number(r.agreed_quantity)
  }));
  res.json(rows);
});

// GET /api/grn/vendor — every GRN recorded against this vendor's own POs.
router.get('/vendor', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const result = await db.query(
    `SELECT g.*, po.agreed_quantity, po.fulfillment_status, po.company_id,
            c.name as company_name, r.title as requirement_title,
            SUM(g.received_quantity) OVER (PARTITION BY g.po_id ORDER BY g.received_date ASC, g.id ASC) as cumulative_received
     FROM goods_receipt_notes g
     JOIN purchase_orders po ON po.id = g.po_id
     JOIN companies c ON c.id = po.company_id
     JOIN requirements r ON r.id = po.requirement_id
     WHERE po.vendor_id = $1
     ORDER BY g.received_date DESC`,
    [req.user.vendor_id]
  );
  const rows = result.rows.map(r => ({
    ...r,
    variance_quantity: Number(r.cumulative_received) - Number(r.agreed_quantity)
  }));
  res.json(rows);
});

module.exports = router;

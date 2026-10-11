const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { notifyVendor, notifyCompanyRole, safely } = require('../utils/notify');
const { removeInvoiceRecord } = require('../utils/invoiceLifecycle');

const router = express.Router();

// GRN corrections -- a support-style request flow for a goods receipt note entered by mistake.
// GRNs are an audit record: never edited, never deleted. A correction request says WHICH GRN
// is wrong and WHY; a different person reviews it; approval VOIDS the GRN (it stays on the record,
// struck from every total) so the correct receipt can be entered afresh.
//
//   raise:   Warehouse or Procurement
//   review:  Procurement or Company Admin -- never the person who raised it
//   rules:   only the most recent active GRN on a PO can be corrected (void newest-first, so no
//            later GRN was ever computed against a receipt that no longer counts); nothing can
//            be corrected once an invoice on the PO is paid.
const REQUESTERS = ['warehouse', 'procurement'];
const REVIEWERS = ['procurement', 'company_admin'];
const MIN_REASON = 10;

async function loadGrnForCompany(q, grnId, companyId, { lock = false } = {}) {
  if (!/^\d+$/.test(String(grnId))) return null;
  const r = await q.query(
    `SELECT g.*, po.company_id, po.vendor_id, po.agreed_quantity, po.fulfillment_status, po.requirement_id
     FROM goods_receipt_notes g JOIN purchase_orders po ON po.id = g.po_id
     WHERE g.id = $1 AND po.company_id = $2 ${lock ? 'FOR UPDATE OF g' : ''}`,
    [grnId, companyId]
  );
  return r.rows[0] || null;
}

// Returns an error string if this GRN cannot be corrected right now, else null.
async function correctionBlocker(q, grn) {
  if (grn.voided_at) return 'This GRN has already been voided.';
  const paid = await q.query(`SELECT 1 FROM invoices WHERE po_id = $1 AND status = 'paid' LIMIT 1`, [grn.po_id]);
  if (paid.rows.length) return 'An invoice on this purchase order has already been paid, so its goods receipts can no longer be corrected here.';
  const latest = await q.query(
    `SELECT id FROM goods_receipt_notes WHERE po_id = $1 AND voided_at IS NULL ORDER BY id DESC LIMIT 1`, [grn.po_id]);
  if (latest.rows[0] && latest.rows[0].id !== grn.id) {
    return `Only the most recent goods receipt on a purchase order can be corrected. GRN #${latest.rows[0].id} was recorded after this one — correct that first.`;
  }
  return null;
}

// GET /api/grn-corrections -- every request for the caller's company, newest first, with enough
// context (PO, vendor, quantities) to review it without opening anything else.
router.get('/', requireAuth, requireRole(...REQUESTERS, 'company_admin'), async (req, res) => {
  const result = await db.query(
    `SELECT c.*, g.received_quantity, g.received_date, g.voided_at, po.agreed_quantity, po.fulfillment_status,
            r.title AS requirement_title, r.unit, v.company_name AS vendor_name
     FROM grn_correction_requests c
     JOIN goods_receipt_notes g ON g.id = c.grn_id
     JOIN purchase_orders po ON po.id = c.po_id
     JOIN requirements r ON r.id = po.requirement_id
     JOIN vendors v ON v.id = po.vendor_id
     WHERE c.company_id = $1
     ORDER BY (c.status = 'pending') DESC, c.created_at DESC, c.id DESC`,
    [req.user.company_id]
  );
  res.json(result.rows);
});

// POST /api/grn-corrections { grn_id, reason }
router.post('/', requireAuth, requireRole(...REQUESTERS), requireApprovedCompany, async (req, res) => {
  const { grn_id, reason } = req.body;
  if (!grn_id) return res.status(400).json({ error: 'grn_id is required' });
  if (!reason || String(reason).trim().length < MIN_REASON) {
    return res.status(400).json({ error: `Please explain what is wrong with this GRN (at least ${MIN_REASON} characters) — the reviewer sees exactly this.` });
  }
  const grn = await loadGrnForCompany(db, grn_id, req.user.company_id);
  if (!grn) return res.status(404).json({ error: 'GRN not found' });
  const blocker = await correctionBlocker(db, grn);
  if (blocker) return res.status(409).json({ error: blocker });

  const nameRes = await db.query(`SELECT name FROM users WHERE id = $1`, [req.user.id]);
  const name = nameRes.rows[0]?.name || req.user.role;
  let row;
  try {
    const ins = await db.query(
      `INSERT INTO grn_correction_requests (grn_id, po_id, company_id, requested_by, requested_by_name, requested_by_role, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [grn.id, grn.po_id, req.user.company_id, req.user.id, name, req.user.role, String(reason).trim()]
    );
    row = ins.rows[0];
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A correction request is already open for this GRN.' });
    throw err;
  }
  res.status(201).json(row);

  safely(notifyCompanyRole(req.user.company_id, REVIEWERS, 'grn_correction_requested',
    `${name} (${req.user.role}) asked to correct GRN #${grn.id} on purchase order #${grn.po_id}: "${String(reason).trim().slice(0, 120)}"`, row.id, 'grn_correction'), 'grn_correction_requested');
});

// POST /api/grn-corrections/:id/approve { note? }
router.post('/:id/approve', requireAuth, requireRole(...REVIEWERS), requireApprovedCompany, async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: 'Request not found' });
  const client = await db.getClient();
  let outcome;
  try {
    await client.query('BEGIN');
    const rr = await client.query(`SELECT * FROM grn_correction_requests WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, req.user.company_id]);
    const request = rr.rows[0];
    if (!request) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found' }); }
    if (request.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: `This request was already ${request.status}.` }); }
    if (request.requested_by === req.user.id) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'You raised this request, so someone else has to review it.' }); }

    // Lock the PO the same way GRN entry does, so a concurrent GRN can't slip in mid-void.
    const poRes = await client.query(`SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE`, [request.po_id]);
    const po = poRes.rows[0];
    const grn = await loadGrnForCompany(client, request.grn_id, req.user.company_id, { lock: true });
    const blocker = grn ? await correctionBlocker(client, grn) : 'GRN not found';
    if (blocker) { await client.query('ROLLBACK'); return res.status(409).json({ error: blocker }); }

    await client.query(
      `UPDATE goods_receipt_notes SET voided_at = now(), voided_by = $1, void_reason = $2 WHERE id = $3`,
      [req.user.id, request.reason, grn.id]
    );
    // Recompute the PO's fulfilment from the GRNs that still count.
    const sumRes = await client.query(
      `SELECT COALESCE(SUM(received_quantity), 0) AS total FROM goods_receipt_notes WHERE po_id = $1 AND voided_at IS NULL`, [po.id]);
    const total = Number(sumRes.rows[0].total);
    const agreed = Number(po.agreed_quantity);
    const status = total <= 0 ? 'pending' : total < agreed ? 'partially_fulfilled' : 'fulfilled';
    await client.query(`UPDATE purchase_orders SET fulfillment_status = $1 WHERE id = $2`, [status, po.id]);

    // Invoices on this PO that are not paid were checked against the receipts as they stood: pull
    // them back with the standard withdraw sequence so the vendor resubmits against the corrected
    // quantities and they go through verification afresh (re-running the AI pipeline on the
    // same invoice would duplicate its fraud flags and score events).
    const invRes = await client.query(`SELECT id, invoice_number FROM invoices WHERE po_id = $1 AND status <> 'paid'`, [po.id]);
    for (const inv of invRes.rows) await removeInvoiceRecord(client, inv.id);

    const note = req.body.note ? String(req.body.note).trim() : null;
    const upd = await client.query(
      `UPDATE grn_correction_requests SET status = 'approved', reviewed_by = $1, reviewed_by_name = (SELECT name FROM users WHERE id = $1), reviewed_at = now(), review_note = $2
       WHERE id = $3 RETURNING *`, [req.user.id, note, request.id]);
    await client.query('COMMIT');
    outcome = { request: upd.rows[0], grn, po, status, total, withdrawn: invRes.rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('grn correction approve failed:', err);
    return res.status(500).json({ error: 'Could not approve the correction' });
  } finally {
    client.release();
  }
  res.json({ ...outcome.request, fulfillment_status: outcome.status, received_total: outcome.total, invoices_withdrawn: outcome.withdrawn.length });

  safely((async () => {
    const { request, grn, po, withdrawn } = outcome;
    await notifyCompanyRole(req.user.company_id, ['warehouse', 'procurement'], 'grn_correction_approved',
      `GRN #${grn.id} on purchase order #${po.id} was voided (${request.reviewed_by_name}). Record the correct receipt on GRN Entry.`, request.id, 'grn_correction');
    await notifyVendor(po.vendor_id, 'grn_voided',
      `GRN #${grn.id} on purchase order #${po.id} was entered in error and has been voided; the buyer will record the correct receipt.${withdrawn.length ? ' Your invoice for this order was withdrawn so it can be re-checked — please resubmit it once the corrected receipt is in.' : ''}`, po.id, 'po');
    if (withdrawn.length) {
      await notifyCompanyRole(req.user.company_id, 'finance', 'invoice_withdrawn_grn',
        `Invoice ${withdrawn.map(i => i.invoice_number || '#' + i.id).join(', ')} on purchase order #${po.id} was withdrawn because GRN #${grn.id} was voided. The vendor will resubmit.`, po.id, 'po');
    }
  })(), 'grn_correction_approved');
});

// POST /api/grn-corrections/:id/reject { note }
router.post('/:id/reject', requireAuth, requireRole(...REVIEWERS), requireApprovedCompany, async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: 'Request not found' });
  const note = req.body.note ? String(req.body.note).trim() : '';
  if (note.length < 3) return res.status(400).json({ error: 'Please say why the request is rejected — the requester sees this.' });
  const rr = await db.query(`SELECT * FROM grn_correction_requests WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
  const request = rr.rows[0];
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.requested_by === req.user.id) return res.status(403).json({ error: 'You raised this request, so someone else has to review it.' });
  const upd = await db.query(
    `UPDATE grn_correction_requests SET status = 'rejected', reviewed_by = $1, reviewed_by_name = (SELECT name FROM users WHERE id = $1), reviewed_at = now(), review_note = $2
     WHERE id = $3 AND status = 'pending' RETURNING *`, [req.user.id, note, request.id]);
  if (!upd.rows[0]) return res.status(409).json({ error: `This request was already ${request.status}.` });
  res.json(upd.rows[0]);
  safely(notifyCompanyRole(req.user.company_id, request.requested_by_role, 'grn_correction_rejected',
    `Your correction request for GRN #${request.grn_id} was rejected: "${note.slice(0, 120)}"`, request.id, 'grn_correction'), 'grn_correction_rejected');
});

module.exports = router;

const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const FINANCIAL_FIELDS = ['agreed_price', 'cumulative_invoiced_amount'];

function stripFinancials(po) {
  const stripped = { ...po };
  for (const field of FINANCIAL_FIELDS) delete stripped[field];
  return stripped;
}

// Every PO listing includes received_so_far and remaining_quantity, computed from the
// SUM of every GRN recorded against it — this is what lets the frontend show "480/500,
// 20 remaining" instead of just a status word.
const GRN_SUM_JOIN = `
  LEFT JOIN (
    SELECT po_id, SUM(received_quantity) as total_received
    FROM goods_receipt_notes GROUP BY po_id
  ) grn_totals ON grn_totals.po_id = po.id
`;

// GET /api/purchase-orders/mine — vendors get their own POs; company-side roles
// (company_admin/procurement/finance/warehouse) get every PO for their company.
router.get('/mine', requireAuth, async (req, res) => {
  let rows;
  if (req.user.role === 'vendor') {
    const result = await db.query(
      `SELECT po.*, r.title as requirement_title, COALESCE(grn_totals.total_received, 0) as received_so_far
       FROM purchase_orders po
       JOIN requirements r ON r.id = po.requirement_id
       ${GRN_SUM_JOIN}
       WHERE po.vendor_id = $1 ORDER BY po.created_at DESC`,
      [req.user.vendor_id]
    );
    rows = result.rows;
  } else if (['company_admin', 'procurement', 'finance', 'warehouse'].includes(req.user.role)) {
    const result = await db.query(
      `SELECT po.*, r.title as requirement_title, v.company_name as vendor_name,
              COALESCE(grn_totals.total_received, 0) as received_so_far
       FROM purchase_orders po
       JOIN requirements r ON r.id = po.requirement_id
       JOIN vendors v ON v.id = po.vendor_id
       ${GRN_SUM_JOIN}
       WHERE po.company_id = $1 ORDER BY po.created_at DESC`,
      [req.user.company_id]
    );
    rows = req.user.role === 'warehouse' ? result.rows.map(stripFinancials) : result.rows;
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }
  rows = rows.map(po => ({
    ...po,
    remaining_quantity: Math.max(0, Number(po.agreed_quantity) - Number(po.received_so_far))
  }));
  res.json(rows);
});

// GET /api/purchase-orders/:id — warehouse role gets price/financial fields stripped server-side
router.get('/:id', requireAuth, async (req, res) => {
  const result = await db.query(
    `SELECT po.*, COALESCE(grn_totals.total_received, 0) as received_so_far
     FROM purchase_orders po ${GRN_SUM_JOIN} WHERE po.id = $1`,
    [req.params.id]
  );
  const po = result.rows[0];
  if (!po) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'vendor' && po.vendor_id !== req.user.vendor_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role !== 'vendor' && req.user.role !== 'platform_admin' && po.company_id !== req.user.company_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  po.remaining_quantity = Math.max(0, Number(po.agreed_quantity) - Number(po.received_so_far));
  if (req.user.role === 'warehouse') return res.json(stripFinancials(po));
  res.json(po);
});

// GET /api/purchase-orders/:id/document — download the generated PO PDF, auth-scoped same as above
router.get('/:id/document', requireAuth, async (req, res) => {
  const result = await db.query(`SELECT * FROM purchase_orders WHERE id = $1`, [req.params.id]);
  const po = result.rows[0];
  if (!po || !po.po_document_path) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'vendor' && po.vendor_id !== req.user.vendor_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role !== 'vendor' && req.user.role !== 'platform_admin' && po.company_id !== req.user.company_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'warehouse') return res.status(403).json({ error: 'Warehouse role cannot view PO documents (contains pricing)' });

  res.sendFile(path.resolve(po.po_document_path));
});

// GET /api/purchase-orders/:id/grns — every GRN recorded against this PO, in order, with
// a running cumulative total after each one — so a multi-delivery PO (e.g. 90 then 10)
// shows how the fulfillment closed out step by step, not just a final snapshot.
router.get('/:id/grns', requireAuth, async (req, res) => {
  const poResult = await db.query(`SELECT * FROM purchase_orders WHERE id = $1`, [req.params.id]);
  const po = poResult.rows[0];
  if (!po) return res.status(404).json({ error: 'Not found' });

  if (req.user.role === 'vendor' && po.vendor_id !== req.user.vendor_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role !== 'vendor' && req.user.role !== 'platform_admin' && po.company_id !== req.user.company_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const grnResult = await db.query(
    `SELECT * FROM goods_receipt_notes WHERE po_id = $1 ORDER BY received_date ASC, id ASC`,
    [req.params.id]
  );

  let running = 0;
  const grnsWithRunningTotal = grnResult.rows.map(g => {
    running += Number(g.received_quantity);
    return { ...g, cumulative_received: running, variance_quantity: running - Number(po.agreed_quantity) };
  });

  res.json({
    po_id: po.id,
    agreed_quantity: po.agreed_quantity,
    fulfillment_status: po.fulfillment_status,
    received_so_far: running,
    remaining_quantity: Math.max(0, Number(po.agreed_quantity) - running),
    grns: grnsWithRunningTotal
  });
});

module.exports = router;

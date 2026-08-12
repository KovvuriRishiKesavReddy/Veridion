const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const FINANCIAL_FIELDS = ['agreed_price', 'cumulative_invoiced_amount'];

// GET /api/purchase-orders/mine (vendor) — accepted POs for this vendor
router.get('/mine', requireAuth, async (req, res) => {
  if (req.user.role !== 'vendor') return res.status(403).json({ error: 'Vendor only' });
  const result = await db.query(
    `SELECT * FROM purchase_orders WHERE vendor_id = $1 ORDER BY created_at DESC`,
    [req.user.vendor_id]
  );
  res.json(result.rows);
});

// GET /api/purchase-orders/:id — warehouse role gets price/financial fields stripped server-side
router.get('/:id', requireAuth, async (req, res) => {
  const result = await db.query(`SELECT * FROM purchase_orders WHERE id = $1`, [req.params.id]);
  const po = result.rows[0];
  if (!po) return res.status(404).json({ error: 'Not found' });

  // scope check: vendors only see their own PO, company roles only their own company's PO
  if (req.user.role === 'vendor' && po.vendor_id !== req.user.vendor_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role !== 'vendor' && req.user.role !== 'platform_admin' && po.company_id !== req.user.company_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.user.role === 'warehouse') {
    const stripped = { ...po };
    for (const field of FINANCIAL_FIELDS) delete stripped[field];
    return res.json(stripped);
  }

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
  // Warehouse role cannot see price fields at all, and the PO PDF contains price — deny outright.
  if (req.user.role === 'warehouse') return res.status(403).json({ error: 'Warehouse role cannot view PO documents (contains pricing)' });

  res.sendFile(path.resolve(po.po_document_path));
});

module.exports = router;

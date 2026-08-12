const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const router = express.Router();

// POST /api/grn (warehouse)
router.post('/', requireAuth, requireRole('warehouse'), async (req, res) => {
  const { po_id, received_quantity, received_date, warehouse_notes, expected_next_delivery_date, next_delivery_notes } = req.body;
  if (!po_id || received_quantity === undefined || !received_date) {
    return res.status(400).json({ error: 'po_id, received_quantity, received_date are required' });
  }

  const poRes = await db.query(`SELECT * FROM purchase_orders WHERE id = $1`, [po_id]);
  const po = poRes.rows[0];
  if (!po || po.company_id !== req.user.company_id) return res.status(404).json({ error: 'PO not found' });

  const isShortfall = Number(received_quantity) < Number(po.agreed_quantity);
  const fulfillmentStatus = isShortfall ? 'partially_fulfilled' : 'fulfilled';

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const grnRes = await client.query(
      `INSERT INTO goods_receipt_notes
        (po_id, received_quantity, received_date, warehouse_notes, recorded_by, discrepancy_flag, expected_next_delivery_date, next_delivery_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        po_id, received_quantity, received_date, warehouse_notes || null, req.user.id, isShortfall,
        isShortfall ? (expected_next_delivery_date || null) : null,
        isShortfall ? (next_delivery_notes || null) : null
      ]
    );
    await client.query(`UPDATE purchase_orders SET fulfillment_status=$1 WHERE id=$2`, [fulfillmentStatus, po_id]);
    await client.query('COMMIT');
    res.status(201).json(grnRes.rows[0]);
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
    `SELECT g.* FROM goods_receipt_notes g
     JOIN purchase_orders po ON po.id = g.po_id
     WHERE po.company_id = $1 AND g.recorded_by = $2
     ORDER BY g.received_date DESC`,
    [req.user.company_id, req.user.id]
  );
  res.json(result.rows);
});

module.exports = router;

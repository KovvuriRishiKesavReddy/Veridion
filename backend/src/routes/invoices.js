const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const upload = require('../utils/upload');

const router = express.Router();

// POST /api/invoices (vendor) — nothing AI-related happens yet; Flow 2 wires this to RabbitMQ
router.post('/', requireAuth, requireRole('vendor'), upload.single('invoice_file'), async (req, res) => {
  const { po_id, grn_id, invoice_number, invoice_amount, gst_amount, gstin_on_invoice, due_date } = req.body;
  if (!po_id || !invoice_amount) return res.status(400).json({ error: 'po_id and invoice_amount are required' });

  const poRes = await db.query(`SELECT * FROM purchase_orders WHERE id = $1 AND vendor_id = $2`, [po_id, req.user.vendor_id]);
  if (!poRes.rows[0]) return res.status(404).json({ error: 'PO not found for this vendor' });

  const filePath = req.file ? req.file.path : null;

  const result = await db.query(
    `INSERT INTO invoices (po_id, grn_id, vendor_id, invoice_number, invoice_amount, gst_amount, gstin_on_invoice, invoice_file_path, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [po_id, grn_id || null, req.user.vendor_id, invoice_number || null, invoice_amount, gst_amount || null, gstin_on_invoice || null, filePath, due_date || null]
  );

  // Flow 2 will: publish { invoice_id: result.rows[0].id } to RabbitMQ 'invoice.submitted' here.

  res.status(201).json(result.rows[0]);
});

// GET /api/invoices/mine (vendor)
router.get('/mine', requireAuth, requireRole('vendor'), async (req, res) => {
  const result = await db.query(
    `SELECT * FROM invoices WHERE vendor_id = $1 ORDER BY submitted_at DESC`,
    [req.user.vendor_id]
  );
  res.json(result.rows);
});

module.exports = router;

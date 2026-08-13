const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const upload = require('../utils/upload');

const router = express.Router();

// POST /api/invoices (vendor)
// Flow 1 rule (deliberately simple, ahead of the AI verification pipeline in Flow 2):
// an invoice can only be submitted once the PO is FULLY fulfilled — no invoicing against
// a PO that's still pending or partially_fulfilled — and only once per PO. This keeps the
// "invoice = confirms a completed delivery" story honest before any AI double-checks it.
router.post('/', requireAuth, requireRole('vendor'), upload.single('invoice_file'), async (req, res) => {
  const { po_id, grn_id, invoice_number, invoice_amount, gst_amount, gstin_on_invoice, due_date } = req.body;
  if (!po_id || !invoice_amount) return res.status(400).json({ error: 'po_id and invoice_amount are required' });

  const poRes = await db.query(`SELECT * FROM purchase_orders WHERE id = $1 AND vendor_id = $2`, [po_id, req.user.vendor_id]);
  const po = poRes.rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found for this vendor' });

  if (po.fulfillment_status !== 'fulfilled') {
    return res.status(400).json({
      error: `Cannot submit an invoice yet — this PO is still '${po.fulfillment_status}'. Wait until the full agreed quantity has been received before invoicing.`
    });
  }

  const existingRes = await db.query(`SELECT id FROM invoices WHERE po_id = $1`, [po_id]);
  if (existingRes.rows[0]) {
    return res.status(409).json({ error: 'An invoice has already been submitted for this PO.' });
  }

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

// GET /api/invoices/eligible-pos (vendor) — POs that are fully fulfilled and don't
// already have an invoice against them. This is exactly what the invoice upload form
// should offer, and what the vendor dashboard's "Ready to Invoice" section is built from.
router.get('/eligible-pos', requireAuth, requireRole('vendor'), async (req, res) => {
  const result = await db.query(
    `SELECT po.*, r.title as requirement_title
     FROM purchase_orders po
     JOIN requirements r ON r.id = po.requirement_id
     WHERE po.vendor_id = $1
       AND po.fulfillment_status = 'fulfilled'
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = po.id)
     ORDER BY po.created_at DESC`,
    [req.user.vendor_id]
  );
  res.json(result.rows);
});

// GET /api/invoices/company (finance, company_admin) — every invoice submitted against
// this company's POs. This is the missing piece: previously there was no way for anyone
// on the company side to even see an invoice existed, let alone act on it.
router.get('/company', requireAuth, requireRole('finance', 'company_admin'), async (req, res) => {
  const result = await db.query(
    `SELECT inv.*, v.company_name as vendor_name, po.agreed_price, po.agreed_quantity, r.title as requirement_title
     FROM invoices inv
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN vendors v ON v.id = inv.vendor_id
     JOIN requirements r ON r.id = po.requirement_id
     WHERE po.company_id = $1
     ORDER BY inv.submitted_at DESC`,
    [req.user.company_id]
  );
  res.json(result.rows);
});

// POST /api/invoices/:id/mark-paid (finance) — the actual "pay the bill" action that
// was completely missing before. No payments table exists yet in Flow 1 (that's the
// full `payments` table from later flows) — for now this just moves the invoice's own
// status to 'paid', which is enough to close the loop end to end.
router.post('/:id/mark-paid', requireAuth, requireRole('finance'), async (req, res) => {
  const invRes = await db.query(
    `SELECT inv.* FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id WHERE inv.id = $1 AND po.company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  const invoice = invRes.rows[0];
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'paid') return res.status(409).json({ error: 'Already marked as paid' });

  const result = await db.query(
    `UPDATE invoices SET status='paid' WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  res.json(result.rows[0]);
});

module.exports = router;

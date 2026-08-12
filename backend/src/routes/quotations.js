const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { generatePoPdf } = require('../utils/pdf');

const router = express.Router();

// POST /api/quotations (vendor)
router.post('/', requireAuth, requireRole('vendor'), async (req, res) => {
  const { requirement_id, price, delivery_days, notes } = req.body;
  if (!requirement_id || !price || !delivery_days) {
    return res.status(400).json({ error: 'requirement_id, price, delivery_days are required' });
  }
  if (!req.user.vendor_id) return res.status(403).json({ error: 'No vendor profile for this user' });

  const reqCheck = await db.query(`SELECT id, status FROM requirements WHERE id = $1`, [requirement_id]);
  if (!reqCheck.rows[0] || reqCheck.rows[0].status !== 'open') {
    return res.status(404).json({ error: 'Requirement not open or not found' });
  }

  const result = await db.query(
    `INSERT INTO quotations (requirement_id, vendor_id, price, delivery_days, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [requirement_id, req.user.vendor_id, price, delivery_days, notes || null]
  );
  res.status(201).json(result.rows[0]);
});

// GET /api/quotations/mine (vendor)
router.get('/mine', requireAuth, requireRole('vendor'), async (req, res) => {
  const result = await db.query(
    `SELECT q.*, r.title as requirement_title FROM quotations q
     JOIN requirements r ON r.id = q.requirement_id
     WHERE q.vendor_id = $1 ORDER BY q.submitted_at DESC`,
    [req.user.vendor_id]
  );
  res.json(result.rows);
});

// POST /api/quotations/:id/accept (procurement) — transactional: select quotation, create PO, generate PDF
router.post('/:id/accept', requireAuth, requireRole('procurement', 'company_admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const qRes = await client.query(
      `SELECT q.*, r.company_id, r.title as requirement_title, r.category, r.quantity as requirement_quantity, r.deadline
       FROM quotations q JOIN requirements r ON r.id = q.requirement_id
       WHERE q.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    const quotation = qRes.rows[0];
    if (!quotation) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Quotation not found' }); }
    if (quotation.company_id !== req.user.company_id) {
      await client.query('ROLLBACK'); return res.status(403).json({ error: 'Not your requirement' });
    }
    if (quotation.status !== 'submitted') {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'Quotation already decided' });
    }

    await client.query(`UPDATE quotations SET status='selected' WHERE id=$1`, [quotation.id]);
    await client.query(
      `UPDATE quotations SET status='rejected' WHERE requirement_id=$1 AND id != $2 AND status='submitted'`,
      [quotation.requirement_id, quotation.id]
    );
    await client.query(`UPDATE requirements SET status='closed' WHERE id=$1`, [quotation.requirement_id]);

    const poRes = await client.query(
      `INSERT INTO purchase_orders (requirement_id, quotation_id, vendor_id, company_id, agreed_price, agreed_quantity, agreed_delivery_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        quotation.requirement_id, quotation.id, quotation.vendor_id, quotation.company_id,
        quotation.price, quotation.requirement_quantity, quotation.deadline
      ]
    );
    const po = poRes.rows[0];

    const vendorRes = await client.query(`SELECT * FROM vendors WHERE id=$1`, [quotation.vendor_id]);
    const companyRes = await client.query(`SELECT * FROM companies WHERE id=$1`, [quotation.company_id]);

    await client.query('COMMIT');

    // PDF generation happens after commit — a PDF write failure shouldn't roll back the PO
    let pdfPath = null;
    try {
      pdfPath = await generatePoPdf(po, { title: quotation.requirement_title, category: quotation.category }, vendorRes.rows[0], companyRes.rows[0]);
      await db.query(`UPDATE purchase_orders SET po_document_path=$1 WHERE id=$2`, [pdfPath, po.id]);
    } catch (pdfErr) {
      console.error('PO PDF generation failed (PO still created):', pdfErr.message);
    }

    res.status(201).json({ ...po, po_document_path: pdfPath });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not accept quotation' });
  } finally {
    client.release();
  }
});

module.exports = router;

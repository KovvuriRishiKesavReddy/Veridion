const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { generatePoPdf } = require('../utils/pdf');
const { syncPurchaseOrderNode } = require('../utils/neo4jSync');
const { notifyVendor, notifyCompanyRole, safely } = require('../utils/notify');

const router = express.Router();

// POST /api/quotations (vendor)
router.post('/', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const { requirement_id, price, delivery_days, notes } = req.body;
  if (!requirement_id || !price || !delivery_days) {
    return res.status(400).json({ error: 'requirement_id, price, delivery_days are required' });
  }
  if (!req.user.vendor_id) return res.status(403).json({ error: 'No vendor profile for this user' });

  const reqCheck = await db.query(`SELECT r.id, r.status, r.title, r.company_id, c.name AS company_name
     FROM requirements r JOIN companies c ON c.id = r.company_id WHERE r.id = $1`, [requirement_id]);
  if (!reqCheck.rows[0] || reqCheck.rows[0].status !== 'open') {
    return res.status(404).json({ error: 'Requirement not open or not found' });
  }

  const result = await db.query(
    `INSERT INTO quotations (requirement_id, vendor_id, price, delivery_days, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [requirement_id, req.user.vendor_id, price, delivery_days, notes || null]
  );
  res.status(201).json(result.rows[0]);

  // Flow 6: tell Procurement a new quotation arrived — naming the vendor and the company
  // the requirement belongs to, so the message is unambiguous. Fire-and-forget, after the
  // response, so it can never fail the submission.
  safely((async () => {
    const reqRow = reqCheck.rows[0];
    const vRes = await db.query(`SELECT company_name FROM vendors WHERE id = $1`, [req.user.vendor_id]);
    const vendorName = vRes.rows[0]?.company_name || 'A vendor';
    await notifyCompanyRole(reqRow.company_id, 'procurement', 'quotation_received',
      `${vendorName} submitted a quotation for "${reqRow.title}" (${reqRow.company_name}): ₹${result.rows[0].price}, delivery in ${result.rows[0].delivery_days} days.`,
      result.rows[0].id, 'quotation');
  })(), 'quotation_received');
});

// PUT /api/quotations/:id (vendor) -- lets the vendor update their OWN quotation's price and/or
// delivery_days after submission, which is what makes the pre-award thread actually DO
// something rather than being a chat log next to a frozen number. Procurement never edits a
// quotation directly -- they see whatever the vendor currently has set and accept it (the
// /accept route below reads quotation.price / delivery_days fresh at acceptance, so the last
// negotiated numbers are what become the PO). Locked the moment it is no longer 'submitted':
// the number on record must never move after a decision.
router.put('/:id', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const { price, delivery_days } = req.body;
  if ((price == null || price === '') && (delivery_days == null || delivery_days === '')) {
    return res.status(400).json({ error: 'Provide price and/or delivery_days to update.' });
  }
  const newPrice = price == null || price === '' ? null : Number(price);
  const newDays = delivery_days == null || delivery_days === '' ? null : Number(delivery_days);
  if (newPrice !== null && !(newPrice > 0)) return res.status(400).json({ error: 'price must be a positive number' });
  if (newDays !== null && !(Number.isInteger(newDays) && newDays >= 1)) return res.status(400).json({ error: 'delivery_days must be a whole number of days (1 or more)' });
  if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ error: 'Quotation not found' });

  // One atomic UPDATE guarded on status, so an update can never slip in after Procurement
  // accepts (the status check and the write happen in the same statement).
  const result = await db.query(
    `UPDATE quotations SET price = COALESCE($1, price), delivery_days = COALESCE($2, delivery_days)
     WHERE id = $3 AND vendor_id = $4 AND status = 'submitted' RETURNING *`,
    [newPrice, newDays, req.params.id, req.user.vendor_id]
  );
  if (!result.rows[0]) {
    const exists = await db.query(`SELECT status FROM quotations WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.user.vendor_id]);
    if (!exists.rows[0]) return res.status(404).json({ error: 'Quotation not found' });
    return res.status(400).json({ error: 'Can only update a quotation while it is still awaiting a decision.' });
  }
  res.json(result.rows[0]);

  // Tell Procurement the number moved (fire-and-forget).
  safely((async () => {
    const info = await db.query(
      `SELECT r.company_id, r.title, v.company_name FROM quotations q JOIN requirements r ON r.id = q.requirement_id
       JOIN vendors v ON v.id = q.vendor_id WHERE q.id = $1`, [req.params.id]);
    const row = info.rows[0];
    if (!row) return;
    await notifyCompanyRole(row.company_id, 'procurement', 'quotation_updated',
      `${row.company_name} updated their quotation for "${row.title}": now ₹${result.rows[0].price}, delivery in ${result.rows[0].delivery_days} days.`,
      result.rows[0].id, 'quotation');
  })(), 'quotation_updated');
});

// GET /api/quotations/mine (vendor)
router.get('/mine', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const result = await db.query(
    `SELECT q.*, r.title as requirement_title FROM quotations q
     JOIN requirements r ON r.id = q.requirement_id
     WHERE q.vendor_id = $1 ORDER BY q.submitted_at DESC`,
    [req.user.vendor_id]
  );
  res.json(result.rows);
});

// POST /api/quotations/:id/accept (procurement) — transactional: select quotation, create PO, generate PDF
router.post('/:id/accept', requireAuth, requireRole('procurement'), requireApprovedCompany, async (req, res) => {
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
    // RETURNING so we know exactly which vendors just lost, to notify them after commit.
    const rejectedRes = await client.query(
      `UPDATE quotations SET status='rejected' WHERE requirement_id=$1 AND id != $2 AND status='submitted'
       RETURNING id, vendor_id`,
      [quotation.requirement_id, quotation.id]
    );
    await client.query(`UPDATE requirements SET status='closed' WHERE id=$1`, [quotation.requirement_id]);

    // agreed_delivery_date = today (acceptance date) + the vendor's own quoted delivery_days.
    // This was previously (incorrectly) set to the requirement's deadline, which has nothing
    // to do with what the vendor actually promised in their quotation.
    // agreed_delivery_date = today (acceptance date, in the server's local calendar)
    // + the vendor's quoted delivery_days. Computed with pure Y/M/D arithmetic via
    // Date.UTC so the result never depends on local-vs-UTC conversion at all — no
    // .toISOString() applied to a locally-constructed Date, which is what caused the
    // off-by-one-day bug in timezones ahead of UTC (e.g. IST).
    const now = new Date();
    const deliveryDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + Number(quotation.delivery_days)));
    const agreedDeliveryDateStr = deliveryDate.toISOString().slice(0, 10); // YYYY-MM-DD

    const poRes = await client.query(
      `INSERT INTO purchase_orders (requirement_id, quotation_id, vendor_id, company_id, agreed_price, agreed_quantity, agreed_delivery_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        quotation.requirement_id, quotation.id, quotation.vendor_id, quotation.company_id,
        quotation.price, quotation.requirement_quantity, agreedDeliveryDateStr
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
    syncPurchaseOrderNode(po);

    // Flow 6: tell the vendor their quotation was accepted. Fire-and-forget, AFTER the PO is
    // committed and the response is already sent — the notification is a courtesy layer on
    // top of a completed action, never a dependency of it. notifyVendor() can reject (e.g. a
    // DB hiccup), so the .catch keeps that from becoming an unhandled rejection.
    const companyName = companyRes.rows[0]?.name || 'the company';
    notifyVendor(
      po.vendor_id,
      'quotation_accepted',
      `${companyName} accepted your quotation for "${quotation.requirement_title}"! A purchase order has been created.`,
      po.id,
      'po'
    ).catch(err => console.error('[notify] quotation_accepted notification failed (PO unaffected):', err.message));

    // Warehouse can now expect this delivery.
    safely(notifyCompanyRole(po.company_id, 'warehouse', 'po_created',
      `New purchase order #${po.id} for "${quotation.requirement_title}" from ${vendorRes.rows[0]?.company_name || 'the vendor'} — expected by ${agreedDeliveryDateStr}. Ready to receive against.`,
      po.id, 'po'), 'po_created');

    // Every other vendor who had quoted on this requirement is told they were not selected.
    // One failure never affects the others (each call has its own .catch).
    for (const rej of rejectedRes.rows) {
      notifyVendor(
        rej.vendor_id,
        'quotation_rejected',
        `${companyName} did not select your quotation for "${quotation.requirement_title}".`,
        rej.id,
        'quotation'
      ).catch(err => console.error('[notify] quotation_rejected notification failed:', err.message));
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not accept quotation' });
  } finally {
    client.release();
  }
});

// GET /api/quotations/company (procurement) — every still-open (submitted) quotation
// across ALL of this company's requirements in one place, so Procurement can see and
// act on what's waiting without picking a requirement first each time.
router.get('/company', requireAuth, requireRole('procurement'), async (req, res) => {
  const result = await db.query(
    `SELECT q.*, r.title as requirement_title, r.category, r.deadline as requirement_deadline,
            v.company_name as vendor_name, v.verification_status
     FROM quotations q
     JOIN requirements r ON r.id = q.requirement_id
     JOIN vendors v ON v.id = q.vendor_id
     WHERE r.company_id = $1 AND q.status = 'submitted'
     ORDER BY q.submitted_at ASC`,
    [req.user.company_id]
  );
  res.json(result.rows);
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const upload = require('../utils/upload');
const { publishInvoiceSubmitted } = require('../utils/queue');
const { syncInvoiceNode } = require('../utils/neo4jSync');

const router = express.Router();

// POST /api/invoices (vendor)
// Flow 1 rule (deliberately simple, ahead of the AI verification pipeline in Flow 2):
// an invoice can only be submitted once the PO is FULLY fulfilled — no invoicing against
// a PO that's still pending or partially_fulfilled — and only once per PO. This keeps the
// "invoice = confirms a completed delivery" story honest before any AI double-checks it.
router.post('/', requireAuth, requireRole('vendor'), requireVerifiedVendor, upload.single('invoice_file'), async (req, res) => {
  const { po_id, grn_id, invoice_number, invoice_amount, invoice_quantity, gst_amount, gstin_on_invoice, due_date } = req.body;
  if (!po_id || !invoice_amount) return res.status(400).json({ error: 'po_id and invoice_amount are required' });
  if (!req.file) {
    return res.status(400).json({ error: 'An invoice document upload is required — this is what OCR/Matching actually verifies, not just the form fields.' });
  }

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
    `INSERT INTO invoices (po_id, grn_id, vendor_id, invoice_number, invoice_amount, invoice_quantity, gst_amount, gstin_on_invoice, invoice_file_path, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [po_id, grn_id || null, req.user.vendor_id, invoice_number || null, invoice_amount, invoice_quantity || null, gst_amount || null, gstin_on_invoice || null, filePath, due_date || null]
  );

  // Fire-and-forget: this kicks off the AI verification pipeline (OCR -> Matching +
  // Compliance -> the Context Gate) in the ai-service. Never awaited in a way that could
  // fail the response — the invoice is already safely stored regardless of queue health.
  publishInvoiceSubmitted(result.rows[0].id);
  syncInvoiceNode(result.rows[0]);

  res.status(201).json(result.rows[0]);
});

// GET /api/invoices/mine (vendor)
router.get('/mine', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const result = await db.query(
    `SELECT inv.*, r.title as requirement_title,
            d.final_decision, d.final_score, d.reasoning_text as decision_reasoning
     FROM invoices inv
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN requirements r ON r.id = po.requirement_id
     LEFT JOIN LATERAL (
       SELECT * FROM decisions WHERE decisions.invoice_id = inv.id ORDER BY id DESC LIMIT 1
     ) d ON true
     WHERE inv.vendor_id = $1 ORDER BY inv.submitted_at DESC`,
    [req.user.vendor_id]
  );
  res.json(result.rows);
});

// GET /api/invoices/eligible-pos (vendor) — POs that are fully fulfilled and don't
// already have an invoice against them. This is exactly what the invoice upload form
// should offer, and what the vendor dashboard's "Ready to Invoice" section is built from.
// Includes received_so_far — the SUM across every GRN recorded (e.g. 90 + 10 = 100) —
// so the invoice quantity reflects what was actually, cumulatively confirmed received,
// not just the PO's original agreed_quantity (which would be wrong in an overage case).
router.get('/eligible-pos', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const result = await db.query(
    `SELECT po.*, r.title as requirement_title,
            COALESCE((SELECT SUM(received_quantity) FROM goods_receipt_notes WHERE po_id = po.id), 0) as received_so_far
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

// GET /api/invoices/company (finance) — every invoice submitted against
// this company's POs. This is the missing piece: previously there was no way for anyone
// on the company side to even see an invoice existed, let alone act on it.
router.get('/company', requireAuth, requireRole('finance'), async (req, res) => {
  const result = await db.query(
    `SELECT inv.*, v.company_name as vendor_name, po.agreed_price, po.agreed_quantity, r.title as requirement_title,
            d.final_decision, d.final_score, d.reasoning_text as decision_reasoning
     FROM invoices inv
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN vendors v ON v.id = inv.vendor_id
     JOIN requirements r ON r.id = po.requirement_id
     LEFT JOIN LATERAL (
       SELECT * FROM decisions WHERE decisions.invoice_id = inv.id ORDER BY id DESC LIMIT 1
     ) d ON true
     WHERE po.company_id = $1
     ORDER BY inv.submitted_at DESC`,
    [req.user.company_id]
  );
  res.json(result.rows);
});

// POST /api/invoices/:id/mark-paid (finance) — the actual "pay the bill" action. This
// now REQUIRES the Context Gate's decision to be 'auto_approved' before it will let
// Finance pay — a flagged invoice must be reviewed (Invoice Review page shows exactly
// why) before payment can proceed. This is the whole point of Part 3.6's principle:
// "the AI recommends, the company always decides" — Finance still makes the final
// click, but the system's assessment is a hard gate, not just a suggestion on screen.
// No payments table exists yet in Flow 1 — this moves the invoice's own status to 'paid'.
router.post('/:id/mark-paid', requireAuth, requireRole('finance'), requireApprovedCompany, async (req, res) => {
  const invRes = await db.query(
    `SELECT inv.* FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id WHERE inv.id = $1 AND po.company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  const invoice = invRes.rows[0];
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'paid') return res.status(409).json({ error: 'Already marked as paid' });

  const decisionRes = await db.query(
    `SELECT * FROM decisions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`,
    [req.params.id]
  );
  const decision = decisionRes.rows[0];
  if (!decision) {
    return res.status(400).json({ error: 'AI verification has not run on this invoice yet — cannot approve payment until it has a decision.' });
  }
  if (decision.final_decision !== 'auto_approved') {
    return res.status(400).json({
      error: `This invoice was ${decision.final_decision} by verification, not auto-approved. Review it on the Invoice Review page before payment can proceed.`
    });
  }

  const result = await db.query(
    `UPDATE invoices SET status='paid' WHERE id=$1 RETURNING *`,
    [req.params.id]
  );
  res.json(result.rows[0]);
});

// POST /api/invoices/:id/override-and-pay (finance) — the human override path for a
// flagged/suspicious invoice. The Context Gate's automatic gate on mark-paid is
// deliberate and stays exactly as strict as before; this is a SEPARATE, explicit
// action that requires a reason on record — "the AI recommends, the company always
// decides" (Part 3.6) means Finance can still choose to pay a flagged invoice after
// reviewing why it was flagged, but that choice is logged, not silent. Every override
// is written to invoice_overrides for audit — matching the doc's own agent_overrides
// design (Part 2.3/3.4), which also feeds the monthly gate-tuning review once that's
// built.
router.post('/:id/override-and-pay', requireAuth, requireRole('finance'), requireApprovedCompany, async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: 'A reason is required to override a flagged decision — this goes on the audit record.' });
  }

  const invRes = await db.query(
    `SELECT inv.* FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id WHERE inv.id = $1 AND po.company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  const invoice = invRes.rows[0];
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'paid') return res.status(409).json({ error: 'Already marked as paid' });

  const decisionRes = await db.query(`SELECT * FROM decisions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [req.params.id]);
  const decision = decisionRes.rows[0];
  if (!decision) {
    return res.status(400).json({ error: 'AI verification has not run on this invoice yet.' });
  }
  if (decision.final_decision === 'auto_approved') {
    return res.status(400).json({ error: 'This invoice was already auto-approved — use the normal Approve Payment action, an override is only for flagged/suspicious invoices.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE invoices SET status='paid' WHERE id=$1`, [req.params.id]);
    await client.query(
      `INSERT INTO invoice_overrides (invoice_id, decision_id, overridden_by, reason) VALUES ($1,$2,$3,$4)`,
      [req.params.id, decision.id, req.user.id, reason.trim()]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Could not process override' });
  } finally {
    client.release();
  }

  const updated = await db.query(`SELECT * FROM invoices WHERE id = $1`, [req.params.id]);
  res.json(updated.rows[0]);
});

// GET /api/invoices/:id/review (finance) — the invoice plus everything
// the AI pipeline produced for it: OCR extraction, matching results, compliance check,
// and the Context Gate's final decision with its reasoning. This is what the Invoice
// Review page renders.
router.get('/:id/review', requireAuth, requireRole('finance'), async (req, res) => {
  const invRes = await db.query(
    `SELECT inv.*, v.company_name as vendor_name, po.agreed_price, po.agreed_quantity, r.title as requirement_title
     FROM invoices inv
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN vendors v ON v.id = inv.vendor_id
     JOIN requirements r ON r.id = po.requirement_id
     WHERE inv.id = $1 AND po.company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  const invoice = invRes.rows[0];
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  const [extraction, matching, compliance, decision, fraudFlags, vendorRisk, overrides] = await Promise.all([
    db.query(`SELECT * FROM document_extractions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [req.params.id]),
    db.query(`SELECT * FROM matching_results WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [req.params.id]),
    db.query(`SELECT * FROM compliance_checks WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [req.params.id]),
    db.query(`SELECT * FROM decisions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [req.params.id]),
    db.query(`SELECT * FROM fraud_flags WHERE invoice_id = $1 ORDER BY id DESC`, [req.params.id]),
    db.query(`SELECT * FROM vendor_risk_scores WHERE company_id = $1 AND vendor_id = $2`, [req.user.company_id, invoice.vendor_id]),
    db.query(`SELECT o.*, u.name as overridden_by_name FROM invoice_overrides o JOIN users u ON u.id = o.overridden_by WHERE o.invoice_id = $1 ORDER BY o.id DESC`, [req.params.id])
  ]);

  res.json({
    invoice,
    document_extraction: extraction.rows[0] || null,
    matching_result: matching.rows[0] || null,
    compliance_check: compliance.rows[0] || null,
    decision: decision.rows[0] || null,
    fraud_flags: fraudFlags.rows,
    vendor_risk: vendorRisk.rows[0] || null,
    overrides: overrides.rows
  });
});

// DELETE /api/invoices/:id (vendor) — withdraw a flagged or suspicious invoice so it can
// be corrected and resubmitted. This closes a real gap: Flow 1's "one invoice per PO"
// rule has no other resolution path yet (the full dispute/vendor_communications flow is
// Flow 4). Deliberately restricted to flagged/suspicious only — an auto_approved or paid
// invoice can never be withdrawn this way; that would defeat the whole point of the gate.
router.delete('/:id', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const invRes = await db.query(`SELECT * FROM invoices WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.user.vendor_id]);
  const invoice = invRes.rows[0];
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  if (!['flagged', 'suspicious'].includes(invoice.status)) {
    return res.status(400).json({ error: `Cannot withdraw an invoice with status '${invoice.status}' — only flagged or suspicious invoices can be withdrawn and resubmitted.` });
  }

  await db.query(`DELETE FROM invoices WHERE id = $1`, [req.params.id]);
  res.json({ withdrawn: true, po_id: invoice.po_id });
});

module.exports = router;

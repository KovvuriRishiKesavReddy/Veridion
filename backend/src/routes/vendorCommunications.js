const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { callAiService } = require('../utils/aiService');

const router = express.Router();

// GET /api/vendor-communications (finance) — every dispute against this company's
// invoices, optionally filtered by ?status=pending_send|sent. This is what
// disputes.html lists. Scoped to the finance user's own company via the
// invoice -> po -> company_id join, same pattern as GET /api/invoices/company.
router.get('/', requireAuth, requireRole('finance'), async (req, res) => {
  const { status } = req.query;
  const params = [req.user.company_id];
  let sql = `
    SELECT vc.*, inv.invoice_number, inv.invoice_amount, v.company_name as vendor_name, r.title as requirement_title
    FROM vendor_communications vc
    JOIN invoices inv ON inv.id = vc.invoice_id
    JOIN purchase_orders po ON po.id = inv.po_id
    JOIN vendors v ON v.id = vc.vendor_id
    JOIN requirements r ON r.id = po.requirement_id
    WHERE po.company_id = $1`;
  if (status) {
    params.push(status);
    sql += ` AND vc.status = $${params.length}`;
  }
  sql += ' ORDER BY vc.created_at DESC';
  const result = await db.query(sql, params);
  res.json(result.rows);
});

// GET /api/vendor-communications/mine (vendor) — this vendor's own disputes, across
// every company they've worked with. Powers vendor/disputes.html.
router.get('/mine', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const result = await db.query(
    `SELECT vc.*, inv.invoice_number, inv.invoice_amount, r.title as requirement_title, c.name as company_name
     FROM vendor_communications vc
     JOIN invoices inv ON inv.id = vc.invoice_id
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN requirements r ON r.id = po.requirement_id
     JOIN companies c ON c.id = po.company_id
     WHERE vc.vendor_id = $1
     ORDER BY vc.created_at DESC`,
    [req.user.vendor_id]
  );
  res.json(result.rows);
});

// PUT /api/vendor-communications/:id (finance) — edit the AI-drafted message before
// sending. Only while still pending_send — once sent, the message is what the vendor
// actually saw, and editing it after the fact would misrepresent that record.
router.put('/:id', requireAuth, requireRole('finance'), requireApprovedCompany, async (req, res) => {
  const { draft_text } = req.body;
  if (!draft_text || !draft_text.trim()) {
    return res.status(400).json({ error: 'draft_text is required' });
  }

  const checkRes = await db.query(
    `SELECT vc.* FROM vendor_communications vc
     JOIN invoices inv ON inv.id = vc.invoice_id
     JOIN purchase_orders po ON po.id = inv.po_id
     WHERE vc.id = $1 AND po.company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  const comm = checkRes.rows[0];
  if (!comm) return res.status(404).json({ error: 'Dispute not found' });
  if (comm.status !== 'pending_send') {
    return res.status(400).json({ error: 'Can only edit a dispute message before it has been sent.' });
  }

  const result = await db.query(
    `UPDATE vendor_communications SET draft_text = $1 WHERE id = $2 RETURNING *`,
    [draft_text.trim(), req.params.id]
  );
  res.json(result.rows[0]);
});

// POST /api/vendor-communications/:id/send (finance) — sends the (possibly edited)
// message to the vendor. From this point the vendor can see it and respond.
router.post('/:id/send', requireAuth, requireRole('finance'), requireApprovedCompany, async (req, res) => {
  const checkRes = await db.query(
    `SELECT vc.* FROM vendor_communications vc
     JOIN invoices inv ON inv.id = vc.invoice_id
     JOIN purchase_orders po ON po.id = inv.po_id
     WHERE vc.id = $1 AND po.company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  const comm = checkRes.rows[0];
  if (!comm) return res.status(404).json({ error: 'Dispute not found' });
  if (comm.status === 'sent') return res.status(409).json({ error: 'Already sent.' });

  const result = await db.query(
    `UPDATE vendor_communications SET status = 'sent', sent_by = $1, sent_at = now() WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  res.json(result.rows[0]);
});

// POST /api/vendor-communications/:id/respond (vendor) — the vendor's response to a
// sent dispute (Part 8.1: "Shows any dispute flagged against them... so they can
// respond"). Can be called again to update the response right up until Finance
// resolves it.
router.post('/:id/respond', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const { response } = req.body;
  if (!response || !response.trim()) {
    return res.status(400).json({ error: 'response is required' });
  }

  const checkRes = await db.query(`SELECT * FROM vendor_communications WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.user.vendor_id]);
  const comm = checkRes.rows[0];
  if (!comm) return res.status(404).json({ error: 'Dispute not found' });
  if (comm.status !== 'sent') return res.status(400).json({ error: 'This dispute has not been sent to you yet.' });
  if (comm.resolved) return res.status(400).json({ error: 'This dispute has already been resolved.' });

  const result = await db.query(
    `UPDATE vendor_communications SET vendor_response = $1, vendor_responded_at = now() WHERE id = $2 RETURNING *`,
    [response.trim(), req.params.id]
  );
  res.json(result.rows[0]);
});

// POST /api/vendor-communications/:id/resolve (finance) — closes out the dispute.
// Requires it to have been sent first (an unsent draft was never a real dispute the
// vendor experienced). Calculates resolution_time_hours from sent_at, and feeds Agent
// 5's dispute_rate metric via the ai-service — every resolved dispute is itself the
// "bad" outcome being counted (Part 5.5's onDisputeResolved: was_disputed is always
// true here, since resolving this record only happens because a dispute occurred at
// all), scoped to this company/vendor pair exactly like every other vendor_risk_scores
// update (Part 5.7.1's isolation principle).
router.post('/:id/resolve', requireAuth, requireRole('finance'), requireApprovedCompany, async (req, res) => {
  const checkRes = await db.query(
    `SELECT vc.* FROM vendor_communications vc
     JOIN invoices inv ON inv.id = vc.invoice_id
     JOIN purchase_orders po ON po.id = inv.po_id
     WHERE vc.id = $1 AND po.company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  const comm = checkRes.rows[0];
  if (!comm) return res.status(404).json({ error: 'Dispute not found' });
  if (comm.status !== 'sent') return res.status(400).json({ error: 'Cannot resolve a dispute that has not been sent yet.' });
  if (comm.resolved) return res.status(409).json({ error: 'Already resolved.' });

  const resolutionTimeHours = (Date.now() - new Date(comm.sent_at).getTime()) / (1000 * 60 * 60);

  const result = await db.query(
    `UPDATE vendor_communications
     SET resolved = true, resolution_time_hours = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 RETURNING *`,
    [resolutionTimeHours, req.user.id, req.params.id]
  );

  // Fire-and-forget-ish but awaited for a clean response; a failure here must never
  // block the resolution itself from being recorded — the dispute record is already
  // committed above regardless of whether the vendor-risk update succeeds.
  try {
    await callAiService('/agents/vendor-risk/on-dispute-resolved', {
      company_id: req.user.company_id,
      vendor_id: comm.vendor_id,
      was_disputed: true
    });
  } catch (err) {
    console.error(`Could not update vendor risk score after resolving dispute ${req.params.id}:`, err.message);
  }

  res.json(result.rows[0]);
});

module.exports = router;

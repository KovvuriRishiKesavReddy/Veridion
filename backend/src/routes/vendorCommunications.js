const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { callAiService } = require('../utils/aiService');

const router = express.Router();

// Every listing/detail query needs the same "display these fields, but fall back to
// the snapshot if the invoice was withdrawn (invoice_id is now NULL)" shape, and the
// same message-thread subquery. Shared here so the two GET routes below can't drift.
const MESSAGES_SUBQUERY = `
  COALESCE((
    SELECT json_agg(json_build_object('id', dm.id, 'sender_role', dm.sender_role, 'sender_name', dm.sender_name, 'message', dm.message, 'created_at', dm.created_at) ORDER BY dm.created_at ASC)
    FROM dispute_messages dm WHERE dm.vendor_communication_id = vc.id
  ), '[]'::json) AS messages`;

// GET /api/vendor-communications (finance) — every dispute against this company,
// optionally filtered by ?status=pending_send|sent. This is what disputes.html lists.
// Scoped directly by vc.company_id (captured on the row at creation time, see
// vendorCommunication.js) rather than joining through invoices -> purchase_orders —
// that join chain breaks the moment an invoice is withdrawn (invoice_id becomes NULL),
// which is exactly the bug this replaces: a resolved dispute used to disappear
// entirely once its invoice was withdrawn for resubmission. LEFT JOIN to invoices so a
// withdrawn dispute still returns a row; invoice_number/vendor_name fall back to the
// snapshot captured when the dispute was created. Includes the invoice's
// final_decision (only available while the invoice still exists) so the UI can badge
// a dispute that came from a suspicious/fraud-review case, and the full messages
// thread (see dispute_messages) ordered oldest-first.
router.get('/', requireAuth, requireRole('finance'), async (req, res) => {
  const { status } = req.query;
  const params = [req.user.company_id];
  let sql = `
    SELECT vc.*,
      COALESCE(inv.invoice_number, vc.invoice_number_snapshot) as invoice_number,
      inv.invoice_amount,
      COALESCE(v.company_name, vc.vendor_name_snapshot) as vendor_name,
      r.title as requirement_title,
      (vc.invoice_id IS NULL) as invoice_withdrawn,
      (SELECT d.final_decision FROM decisions d WHERE d.invoice_id = inv.id ORDER BY d.id DESC LIMIT 1) as final_decision,
      ${MESSAGES_SUBQUERY}
    FROM vendor_communications vc
    LEFT JOIN invoices inv ON inv.id = vc.invoice_id
    LEFT JOIN purchase_orders po ON po.id = inv.po_id
    LEFT JOIN requirements r ON r.id = po.requirement_id
    LEFT JOIN vendors v ON v.id = vc.vendor_id
    WHERE vc.company_id = $1`;
  if (status) {
    params.push(status);
    sql += ` AND vc.status = $${params.length}`;
  }
  sql += ' ORDER BY vc.created_at DESC';
  const result = await db.query(sql, params);
  res.json(result.rows);
});

// GET /api/vendor-communications/mine (vendor) — this vendor's own disputes, across
// every company they've worked with. Powers vendor/disputes.html. Same LEFT JOIN /
// snapshot-fallback / messages-thread shape as above, scoped by vc.vendor_id (a real
// foreign key that's never nulled out, unlike invoice_id).
router.get('/mine', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const result = await db.query(
    `SELECT vc.*,
       COALESCE(inv.invoice_number, vc.invoice_number_snapshot) as invoice_number,
       inv.invoice_amount,
       r.title as requirement_title,
       COALESCE(c.name, 'a previous buyer') as company_name,
       (vc.invoice_id IS NULL) as invoice_withdrawn,
       ${MESSAGES_SUBQUERY}
     FROM vendor_communications vc
     LEFT JOIN invoices inv ON inv.id = vc.invoice_id
     LEFT JOIN purchase_orders po ON po.id = inv.po_id
     LEFT JOIN requirements r ON r.id = po.requirement_id
     LEFT JOIN companies c ON c.id = vc.company_id
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

  const checkRes = await db.query(`SELECT * FROM vendor_communications WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
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
  const checkRes = await db.query(`SELECT * FROM vendor_communications WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
  const comm = checkRes.rows[0];
  if (!comm) return res.status(404).json({ error: 'Dispute not found' });
  if (comm.status === 'sent') return res.status(409).json({ error: 'Already sent.' });

  const result = await db.query(
    `UPDATE vendor_communications SET status = 'sent', sent_by = $1, sent_at = now() WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.id]
  );
  res.json(result.rows[0]);
});

// POST /api/vendor-communications/:id/respond (vendor) — the vendor's message in the
// conversation (Part 8.1: "Shows any dispute flagged against them... so they can
// respond"). Inserts a NEW, individual message every time — deliberately NOT an
// update to a single field. The vendor can send as many separate follow-up messages
// as they need (e.g. "here's the corrected invoice" as one message, then "also
// attaching our GST certificate" as another) and Finance sees each one distinctly,
// with its own timestamp and the vendor's company name, instead of only ever seeing
// whatever the vendor typed most recently with every earlier reply silently gone.
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

  const vendorRes = await db.query(`SELECT company_name FROM vendors WHERE id = $1`, [req.user.vendor_id]);
  const senderName = vendorRes.rows[0]?.company_name || comm.vendor_name_snapshot || 'Vendor';

  const result = await db.query(
    `INSERT INTO dispute_messages (vendor_communication_id, sender_role, sender_name, message) VALUES ($1, 'vendor', $2, $3) RETURNING *`,
    [req.params.id, senderName, response.trim()]
  );
  res.json(result.rows[0]);
});

// POST /api/vendor-communications/:id/message (finance) — Finance's own side of the
// same conversation. Previously only the vendor could send individual messages;
// Finance was stuck editing/resending the ORIGINAL draft, with no way to actually
// reply to something the vendor said. This is a genuine two-way thread now: Finance
// can ask a follow-up, acknowledge a corrected invoice, or say the dispute is being
// looked at — with their own name and timestamp, same as the vendor's messages.
// Requires the dispute to already be sent (nothing to converse about in a draft still
// sitting in Finance's own review queue) and not yet resolved (a resolved dispute is
// closed, not reopened by messaging into it).
router.post('/:id/message', requireAuth, requireRole('finance'), requireApprovedCompany, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const checkRes = await db.query(`SELECT * FROM vendor_communications WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
  const comm = checkRes.rows[0];
  if (!comm) return res.status(404).json({ error: 'Dispute not found' });
  if (comm.status !== 'sent') return res.status(400).json({ error: 'Can only message the vendor after this dispute has been sent to them.' });
  if (comm.resolved) return res.status(400).json({ error: 'This dispute has already been resolved.' });

  const userRes = await db.query(`SELECT name FROM users WHERE id = $1`, [req.user.id]);
  const senderName = userRes.rows[0]?.name || 'Finance';

  const result = await db.query(
    `INSERT INTO dispute_messages (vendor_communication_id, sender_role, sender_name, message) VALUES ($1, 'finance', $2, $3) RETURNING *`,
    [req.params.id, senderName, message.trim()]
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
  const checkRes = await db.query(`SELECT * FROM vendor_communications WHERE id = $1 AND company_id = $2`, [req.params.id, req.user.company_id]);
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

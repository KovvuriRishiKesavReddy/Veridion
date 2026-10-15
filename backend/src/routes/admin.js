const express = require('express');
const { sendStoredFile } = require('../utils/storage');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const { notifyVendor, notifyCompanyRole, safely } = require('../utils/notify');
const { syncVendorNode, detachVendorIdentity } = require('../utils/neo4jSync');
const { callAiService } = require('../utils/aiService');

const router = express.Router();

// GET /api/admin/vendors — every vendor on the platform, for verification review.
// This is the piece Flow 1 was missing entirely: a freshly-registered vendor (or the
// seeded 'pending' one) had no path to ever become verified — verification_status
// could only ever be changed by hand in the database.
router.get('/vendors', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(
    `SELECT v.*, u.email, u.name as contact_name
     FROM vendors v JOIN users u ON u.id = v.user_id
     ORDER BY v.created_at DESC`
  );
  res.json(result.rows);
});

// GET /api/admin/vendors/:id/proof-document — the actual uploaded business
// registration proof. Approving/rejecting a vendor without ever being able to see
// what they submitted made "verification" a rubber stamp — this closes that gap.
router.get('/vendors/:id/proof-document', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(`SELECT business_reg_proof_path FROM vendors WHERE id = $1`, [req.params.id]);
  const vendor = result.rows[0];
  if (!vendor || !vendor.business_reg_proof_path) return res.status(404).json({ error: 'No proof document on file' });
  await sendStoredFile(res, vendor.business_reg_proof_path);
});

// GET /api/admin/vendors/:id/pan-proof-document — the uploaded PAN card document.
router.get('/vendors/:id/pan-proof-document', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(`SELECT pan_proof_path FROM vendors WHERE id = $1`, [req.params.id]);
  const vendor = result.rows[0];
  if (!vendor || !vendor.pan_proof_path) return res.status(404).json({ error: 'No PAN proof document on file' });
  await sendStoredFile(res, vendor.pan_proof_path);
});

// POST /api/admin/vendors/:id/verify — approve or reject a vendor's registration.
router.post('/vendors/:id/verify', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const { status } = req.body;
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "status must be 'verified' or 'rejected'" });
  }
  const result = await db.query(
    `UPDATE vendors SET verification_status = $1 WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Vendor not found' });

  // Keep the fraud graph in step with the verification decision. Rejecting/revoking a
  // vendor removes its bank-account/address edges, so it can no longer cause OTHER vendors
  // to be flagged as sharing an identity with it (this was the "shell company still shows
  // fraud after I revoked it" bug -- Neo4j was never told). Re-verifying restores the edges
  // from Postgres. Fire-and-forget like every other graph write; fraud.js also filters
  // rejected vendors against Postgres, so a failed graph write can't resurrect the flag.
  const v = result.rows[0];
  if (status === 'rejected') {
    detachVendorIdentity(v.id);
  } else {
    syncVendorNode({ id: v.id, company_name: v.company_name, gstin: v.gstin, bank_account_number: v.bank_account_number, address: v.address });
  }

  res.json(result.rows[0]);
  safely(notifyVendor(result.rows[0].id, status === 'verified' ? 'account_verified' : 'account_rejected',
    status === 'verified'
      ? 'Your Veridion vendor account has been verified. You can now browse requirements and submit quotations.'
      : 'Your Veridion vendor account verification was rejected. Please review your registration details and documents.',
    result.rows[0].id, 'account'), 'vendor verification');
});

// GET /api/admin/fraud-flags — every fraud flag raised across the whole platform,
// unresolved first. This is the destination Prompt 3.4 refers to: a high-severity
// fraud finding routes an invoice to 'suspicious' status and lands here for a human
// with cross-company authority to review — never auto-resolved by the gate itself.
router.get('/fraud-flags', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(
    `SELECT ff.*, v.company_name as vendor_name,
            COALESCE(inv.invoice_number, ff.invoice_number_snapshot) AS invoice_number,
            COALESCE(inv.invoice_amount, ff.invoice_amount_snapshot) AS invoice_amount,
            COALESCE(ff.invoice_id, ff.invoice_ref_snapshot) AS invoice_ref,
            (ff.invoice_id IS NULL AND ff.invoice_ref_snapshot IS NOT NULL) AS invoice_withdrawn,
            inv.status AS invoice_status
     FROM fraud_flags ff
     JOIN vendors v ON v.id = ff.vendor_id
     LEFT JOIN invoices inv ON inv.id = ff.invoice_id
     ORDER BY ff.resolved ASC, ff.created_at DESC`
  );
  res.json(result.rows);
});

// POST /api/admin/fraud-flags/:id/resolve — mark a flag as reviewed, and RE-RUN the
// Context Gate decision for that invoice once every flag on it is resolved. Previously
// this only flipped fraud_flags.resolved, so the invoice kept its old 'suspicious'
// decision and Finance (whose mark-paid gate reads decisions.final_decision) never saw
// the outcome of the admin's review.
//
// The re-run does NOT blindly approve anything: it runs the normal decision stage again, with
// two rules (see fraud.js / decide.js): a flag type the admin already resolved for this
// invoice is not raised again (that review is final for that signal), and the vendor's
// risk score isn't charged a second bad event for the same invoice. Matching, Compliance
// and Vendor Risk still count, so the result can legitimately be auto_approved OR flagged.
// Waits on any other still-open flag on the same invoice before re-running.
//
// The re-run happens IN THE BACKGROUND (this response never waits on ai-service): on a
// free-tier host ai-service may be asleep and take a minute to wake, and resolving a flag
// must stay instant and must never fail because of it. Finance is notified by the same
// idempotent hook a first-time decision uses. Calling this endpoint again on an
// already-resolved flag simply retries the re-run (the UPDATE is idempotent), which is
// what the "Re-run decision" button on the Fraud Review page does.
async function rerunDecisionInBackground(invoiceId) {
  if (process.env.AI_SERVICE_URL) {
    try { await fetch(`${process.env.AI_SERVICE_URL}/health`); } catch (e) { /* best-effort wake-up only */ }
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await callAiService('/agents/redecide-after-fraud-review', { invoice_id: invoiceId }, { timeoutMs: 90000 });
    if (out) return;
    if (attempt === 1) await new Promise(r => setTimeout(r, 5000));
  }
  console.error(`[admin] decision re-run for invoice ${invoiceId} failed after fraud-flag resolution — use "Re-run decision" on the Fraud Review page to retry`);
}

router.post('/fraud-flags/:id/resolve', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(`UPDATE fraud_flags SET resolved = true WHERE id = $1 RETURNING *`, [req.params.id]);
  const flag = result.rows[0];
  if (!flag) return res.status(404).json({ error: 'Fraud flag not found' });

  const rerun = { queued: false, reason: null };
  try {
    if (!flag.invoice_id) {
      rerun.reason = 'the invoice was withdrawn';
    } else {
      const invRes = await db.query(`SELECT status FROM invoices WHERE id = $1`, [flag.invoice_id]);
      const open = await db.query(`SELECT COUNT(*)::int AS n FROM fraud_flags WHERE invoice_id = $1 AND resolved = false`, [flag.invoice_id]);
      if (!invRes.rows[0]) rerun.reason = 'the invoice no longer exists';
      else if (!['suspicious', 'flagged'].includes(invRes.rows[0].status)) rerun.reason = `the invoice is already '${invRes.rows[0].status}'`;
      else if (open.rows[0].n > 0) rerun.reason = `${open.rows[0].n} other fraud flag(s) on this invoice are still open`;
      else {
        rerun.queued = true;
        safely(rerunDecisionInBackground(flag.invoice_id), 'fraud-resolve decision re-run');
      }
    }
  } catch (err) {
    console.error('[admin] could not evaluate decision re-run after resolving flag', flag.id, err.message);
    rerun.reason = 'could not check the invoice state';
  }
  res.json({ ...flag, rerun });
});

// GET /api/admin/companies — every company registered on the platform, for approval
// review — mirrors GET /api/admin/vendors. Companies now go through the same
// human-gated approval as vendors (see migration 006_comapany_approval.sql): a
// company_admin gets a valid login the instant they register, but requireApprovedCompany
// blocks every real action (posting requirements, inviting teammates, accepting
// quotations, recording GRNs, approving payments) until a Platform Admin approves them
// here.
router.get('/companies', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(
    `SELECT c.*, u.name as admin_name, u.email as admin_email
     FROM companies c LEFT JOIN users u ON u.id = c.created_by
     ORDER BY c.created_at DESC`
  );
  res.json(result.rows);
});

// GET /api/admin/companies/:id/proof-document — the uploaded company registration proof.
router.get('/companies/:id/proof-document', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(`SELECT registration_proof_path FROM companies WHERE id = $1`, [req.params.id]);
  const company = result.rows[0];
  if (!company || !company.registration_proof_path) return res.status(404).json({ error: 'No proof document on file' });
  await sendStoredFile(res, company.registration_proof_path);
});

// POST /api/admin/companies/:id/approve — approve or reject a company's registration.
// Mirrors POST /api/admin/vendors/:id/verify exactly. Approving/rejecting without ever
// viewing the submitted registration_proof_path would make this a rubber stamp — the
// proof-document route above exists for exactly that reason, same as vendors.
router.post('/companies/:id/approve', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
  }
  const result = await db.query(
    `UPDATE companies SET approval_status = $1 WHERE id = $2 RETURNING *`,
    [status, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json(result.rows[0]);
  safely(notifyCompanyRole(result.rows[0].id, 'company_admin', status === 'approved' ? 'company_approved' : 'company_rejected',
    status === 'approved'
      ? `${result.rows[0].name} has been approved on Veridion. You can now invite your team and start posting requirements.`
      : `${result.rows[0].name}'s Veridion registration was rejected. Please review your company details and documents.`,
    result.rows[0].id, 'account'), 'company approval');
});

// GET /api/admin/overrides/monthly — aggregated override count per month, platform-wide.
// invoice_overrides already exists (005_registration_hardening.sql) and is written to by
// invoices.js's /override-and-pay route — this just surfaces what's already being recorded,
// per Part 2.3/3.4's "this feeds the monthly gate-tuning review" comment in that file.
router.get('/overrides/monthly', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(
    `SELECT to_char(o.overridden_at, 'YYYY-MM') AS month,
            COUNT(*) AS override_count,
            COUNT(DISTINCT o.overridden_by) AS distinct_reviewers,
            json_agg(json_build_object(
              'invoice_id', o.invoice_id, 'reason', o.reason,
              'overridden_by', u.name, 'overridden_at', o.overridden_at
            ) ORDER BY o.overridden_at DESC) AS entries
     FROM invoice_overrides o
     JOIN users u ON u.id = o.overridden_by
     GROUP BY to_char(o.overridden_at, 'YYYY-MM')
     ORDER BY month DESC`
  );
  res.json(result.rows);
});

// GET /api/admin/overrides/count — just the running total, polled every few seconds by the
// navbar's Override Log dot. Deliberately not the /overrides/monthly route above: that one
// builds a full json_agg per month and is meant for the page itself, not a tight polling loop.
router.get('/overrides/count', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(`SELECT COUNT(*) AS count FROM invoice_overrides`);
  res.json({ count: Number(result.rows[0].count) });
});

module.exports = router;

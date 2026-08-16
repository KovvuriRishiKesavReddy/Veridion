const express = require('express');
const path = require('path');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

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
  res.sendFile(path.resolve(vendor.business_reg_proof_path));
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
  res.json(result.rows[0]);
});

// GET /api/admin/fraud-flags — every fraud flag raised across the whole platform,
// unresolved first. This is the destination Prompt 3.4 refers to: a high-severity
// fraud finding routes an invoice to 'suspicious' status and lands here for a human
// with cross-company authority to review — never auto-resolved by the gate itself.
router.get('/fraud-flags', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(
    `SELECT ff.*, v.company_name as vendor_name, inv.invoice_number, inv.invoice_amount
     FROM fraud_flags ff
     JOIN vendors v ON v.id = ff.vendor_id
     LEFT JOIN invoices inv ON inv.id = ff.invoice_id
     ORDER BY ff.resolved ASC, ff.created_at DESC`
  );
  res.json(result.rows);
});

// POST /api/admin/fraud-flags/:id/resolve — mark a flag as reviewed. Doesn't change
// the invoice's own status automatically (that's a deliberate human decision, made
// separately, not something this endpoint should silently do) — it just closes out
// the flag itself from the review queue.
router.post('/fraud-flags/:id/resolve', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(`UPDATE fraud_flags SET resolved = true WHERE id = $1 RETURNING *`, [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Fraud flag not found' });
  res.json(result.rows[0]);
});

module.exports = router;

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

// GET /api/admin/vendors/:id/pan-proof-document — the uploaded PAN card document.
router.get('/vendors/:id/pan-proof-document', requireAuth, requireRole('platform_admin'), async (req, res) => {
  const result = await db.query(`SELECT pan_proof_path FROM vendors WHERE id = $1`, [req.params.id]);
  const vendor = result.rows[0];
  if (!vendor || !vendor.pan_proof_path) return res.status(404).json({ error: 'No PAN proof document on file' });
  res.sendFile(path.resolve(vendor.pan_proof_path));
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
  res.sendFile(path.resolve(company.registration_proof_path));
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
});

module.exports = router;

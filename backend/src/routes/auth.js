const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const upload = require('../utils/upload');
const { syncVendorNode } = require('../utils/neo4jSync');
const { isValidGstin, isValidPan } = require('../utils/validation');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const router = express.Router();

function signToken(user, extra = {}) {
  return jwt.sign(
    { id: user.id, role: user.role, company_id: user.company_id || null, ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register/vendor
router.post('/register/vendor', upload.fields([{ name: 'business_reg_proof', maxCount: 1 }, { name: 'pan_proof', maxCount: 1 }]), async (req, res) => {
  const { name, email, password, company_name, gstin, pan, phone_number, bank_account_number, bank_ifsc, address } = req.body;
  if (!name || !email || !password || !company_name || !phone_number || !address) {
    return res.status(400).json({ error: 'name, email, password, company_name, phone_number, and address are all required' });
  }
  if (!gstin || !isValidGstin(gstin)) {
    return res.status(400).json({ error: 'A valid 15-character GSTIN is required (format: 2 digits, 5 letters, 4 digits, 1 letter, 1 alphanumeric, Z, 1 alphanumeric).' });
  }
  if (!pan || !isValidPan(pan)) {
    return res.status(400).json({ error: 'A valid 10-character PAN is required (format: 5 letters, 4 digits, 1 letter).' });
  }
  if (!bank_account_number || !bank_ifsc) {
    return res.status(400).json({ error: 'Bank account number and IFSC code are required — this is how you get paid, and it also feeds the platform\'s shell-company fraud check.' });
  }
  const proofFile = req.files?.business_reg_proof?.[0];
  const panProofFile = req.files?.pan_proof?.[0];
  if (!proofFile) {
    return res.status(400).json({ error: 'Business registration proof document is required — Platform Admin cannot verify your account without it.' });
  }
  if (!panProofFile) {
    return res.status(400).json({ error: 'PAN card proof document is required — Platform Admin verifies the PAN number against this.' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'vendor') RETURNING id, name, email, role`,
      [name, email, passwordHash]
    );
    const user = userRes.rows[0];
    // RETURNING id here is essential — without it there's no way to put vendor_id in the
    // token, and every subsequent vendor action (quoting, invoicing, viewing own POs)
    // silently fails until the person logs out and back in. That was a real bug: fixed.
    const vendorRes = await client.query(
      `INSERT INTO vendors (user_id, company_name, gstin, pan, business_reg_proof_path, pan_proof_path, phone_number, bank_account_number, bank_ifsc, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [user.id, company_name, gstin.toUpperCase(), pan.toUpperCase(), proofFile.path, panProofFile.path, phone_number, bank_account_number, bank_ifsc, address]
    );
    await client.query('COMMIT');
    const token = signToken({ ...user, company_id: null }, { vendor_id: vendorRes.rows[0].id });
    res.status(201).json({ token, user: { ...user, vendor_verification_status: 'pending' } });

    // Fire-and-forget, after the response — a vendor registration must never fail or
    // slow down because of graph sync trouble. Real bank_account_number/address now
    // flow through, closing the gap where shell-company detection had nothing to check.
    syncVendorNode({ id: vendorRes.rows[0].id, company_name, gstin, bank_account_number, address });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/register/company
router.post('/register/company', upload.single('registration_proof'), async (req, res) => {
  const { name, email, password, company_name, gstin, address, industry_type } = req.body;
  if (!name || !email || !password || !company_name || !address || !industry_type) {
    return res.status(400).json({ error: 'name, email, password, company_name, address, and industry_type are all required' });
  }
  if (!gstin || !isValidGstin(gstin)) {
    return res.status(400).json({ error: 'A valid 15-character GSTIN is required (format: 2 digits, 5 letters, 4 digits, 1 letter, 1 alphanumeric, Z, 1 alphanumeric).' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'A company registration proof document (e.g. certificate of incorporation) is required.' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const compRes = await client.query(
      `INSERT INTO companies (name, gstin, address, industry_type, registration_proof_path) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [company_name, gstin.toUpperCase(), address, industry_type, req.file.path]
    );
    const companyId = compRes.rows[0].id;
    const passwordHash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role, company_id)
       VALUES ($1,$2,$3,'company_admin',$4) RETURNING id, name, email, role, company_id`,
      [name, email, passwordHash, companyId]
    );
    const user = userRes.rows[0];
    await client.query(`UPDATE companies SET created_by=$1 WHERE id=$2`, [user.id, companyId]);
    await client.query('COMMIT');
    const token = signToken(user);
    res.status(201).json({ token, user: { ...user, company_approval_status: 'pending' } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });

  if (user.is_active === false) {
    return res.status(403).json({ error: 'This account has been deactivated. Contact your Company Admin.' });
  }

  // attach vendor_id if this user is a vendor, for convenience downstream — and fetch
  // their current verification_status so the frontend can route pending/rejected
  // vendors to the awaiting-approval page instead of the full dashboard. This is a UX
  // convenience only — requireVerifiedVendor on the backend is what actually enforces
  // this regardless of what the frontend does with it.
  let vendorId = null;
  let vendorVerificationStatus = null;
  if (user.role === 'vendor') {
    const vRes = await db.query('SELECT id, verification_status FROM vendors WHERE user_id = $1', [user.id]);
    vendorId = vRes.rows[0]?.id || null;
    vendorVerificationStatus = vRes.rows[0]?.verification_status || null;
  }

  // Same convenience, same caveat, for company-scoped roles — the frontend routes a
  // pending/rejected company to an awaiting-approval page; requireApprovedCompany on
  // the backend is what actually enforces this regardless of what the frontend does.
  let companyApprovalStatus = null;
  if (user.company_id && ['company_admin', 'procurement', 'finance', 'warehouse'].includes(user.role)) {
    const cRes = await db.query('SELECT approval_status FROM companies WHERE id = $1', [user.company_id]);
    companyApprovalStatus = cRes.rows[0]?.approval_status || null;
  }

  const token = jwt.sign(
    { id: user.id, role: user.role, company_id: user.company_id, vendor_id: vendorId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role, company_id: user.company_id, vendor_id: vendorId,
      vendor_verification_status: vendorVerificationStatus,
      company_approval_status: companyApprovalStatus
    }
  });
});

// POST /api/auth/accept-invite/:token
router.post('/accept-invite/:token', async (req, res) => {
  const { token } = req.params;
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'name and password required' });

  const invRes = await db.query(
    `SELECT * FROM invitations WHERE token = $1 AND status = 'pending'`,
    [token]
  );
  const invite = invRes.rows[0];
  if (!invite) return res.status(404).json({ error: 'Invalid or already-used invite' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role, company_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role, company_id`,
      [name, invite.invited_email, passwordHash, invite.invited_role, invite.company_id]
    );
    await client.query(
      `UPDATE invitations SET status='accepted', accepted_at=now() WHERE id=$1`,
      [invite.id]
    );
    await client.query('COMMIT');
    const user = userRes.rows[0];
    const jwtToken = signToken(user);
    res.status(201).json({ token: jwtToken, user });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Could not accept invite' });
  } finally {
    client.release();
  }
});

// GET /api/auth/me — convenience for the frontend navbar
router.get('/me', requireAuth, async (req, res) => {
  const result = await db.query('SELECT id, name, email, role, company_id FROM users WHERE id = $1', [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  const user = result.rows[0];

  if (user.role === 'vendor') {
    const vRes = await db.query('SELECT id, verification_status FROM vendors WHERE user_id = $1', [user.id]);
    user.vendor_id = vRes.rows[0]?.id || null;
    user.vendor_verification_status = vRes.rows[0]?.verification_status || null;
  }

  if (user.company_id && ['company_admin', 'procurement', 'finance', 'warehouse'].includes(user.role)) {
    const cRes = await db.query('SELECT approval_status FROM companies WHERE id = $1', [user.company_id]);
    user.company_approval_status = cRes.rows[0]?.approval_status || null;
  }

  res.json(user);
});

module.exports = router;

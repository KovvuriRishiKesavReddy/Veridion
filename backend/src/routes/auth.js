const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const upload = require('../utils/upload');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, company_id: user.company_id || null },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register/vendor
router.post('/register/vendor', upload.single('business_reg_proof'), async (req, res) => {
  const { name, email, password, company_name, gstin, pan, phone_number } = req.body;
  if (!name || !email || !password || !company_name) {
    return res.status(400).json({ error: 'name, email, password, company_name are required' });
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
    const proofPath = req.file ? req.file.path : null;
    await client.query(
      `INSERT INTO vendors (user_id, company_name, gstin, pan, business_reg_proof_path, phone_number)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, company_name, gstin || null, pan || null, proofPath, phone_number || null]
    );
    await client.query('COMMIT');
    const token = signToken({ ...user, company_id: null });
    res.status(201).json({ token, user });
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
router.post('/register/company', async (req, res) => {
  const { name, email, password, company_name, gstin, address, industry_type } = req.body;
  if (!name || !email || !password || !company_name) {
    return res.status(400).json({ error: 'name, email, password, company_name are required' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const compRes = await client.query(
      `INSERT INTO companies (name, gstin, address, industry_type) VALUES ($1,$2,$3,$4) RETURNING id`,
      [company_name, gstin || null, address || null, industry_type || null]
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
    res.status(201).json({ token, user });
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

  // attach vendor_id if this user is a vendor, for convenience downstream
  let vendorId = null;
  if (user.role === 'vendor') {
    const vRes = await db.query('SELECT id FROM vendors WHERE user_id = $1', [user.id]);
    vendorId = vRes.rows[0]?.id || null;
  }

  const token = jwt.sign(
    { id: user.id, role: user.role, company_id: user.company_id, vendor_id: vendorId },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, company_id: user.company_id, vendor_id: vendorId }
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
  res.json(result.rows[0]);
});

module.exports = router;

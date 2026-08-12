const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const router = express.Router();

// POST /api/company/invite (company_admin only)
router.post('/invite', requireAuth, requireRole('company_admin'), async (req, res) => {
  const { invited_email, invited_role } = req.body;
  if (!invited_email || !['procurement', 'finance', 'warehouse'].includes(invited_role)) {
    return res.status(400).json({ error: 'invited_email and a valid invited_role are required' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const result = await db.query(
    `INSERT INTO invitations (company_id, invited_email, invited_role, invited_by, token)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.company_id, invited_email, invited_role, req.user.id, token]
  );
  // In a real deploy this would email the link; for now, return it directly.
  res.status(201).json({
    invitation: result.rows[0],
    accept_url: `/accept-invite.html?token=${token}`
  });
});

// GET /api/company/team (company_admin) — list current team + pending invites
router.get('/team', requireAuth, requireRole('company_admin'), async (req, res) => {
  const users = await db.query(
    `SELECT id, name, email, role FROM users WHERE company_id = $1 ORDER BY role`,
    [req.user.company_id]
  );
  const invites = await db.query(
    `SELECT id, invited_email, invited_role, status, created_at FROM invitations
     WHERE company_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
    [req.user.company_id]
  );
  res.json({ team: users.rows, pending_invitations: invites.rows });
});

module.exports = router;

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireApprovedCompany } = require('../middleware/companyApproval');

const router = express.Router();

// POST /api/company/invite (company_admin only)
router.post('/invite', requireAuth, requireRole('company_admin'), requireApprovedCompany, async (req, res) => {
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
    `SELECT id, name, email, role, is_active FROM users WHERE company_id = $1 ORDER BY role`,
    [req.user.company_id]
  );
  const invites = await db.query(
    `SELECT id, invited_email, invited_role, status, created_at FROM invitations
     WHERE company_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
    [req.user.company_id]
  );
  res.json({ team: users.rows, pending_invitations: invites.rows });
});

// DELETE /api/company/team/:userId (company_admin) — removes a team member.
// This is a soft delete (users.is_active = false), not a real row deletion — see
// migration 007_user_deactivation.sql for why a hard delete isn't viable (the user's
// own historical records — requirements they posted, GRNs they recorded — reference
// their user row via foreign keys with no ON DELETE behavior, so deleting it would
// either fail outright or silently corrupt that history). requireAuth checks
// is_active fresh on every request, so this takes effect immediately, not just on
// the removed user's next login attempt.
router.delete('/team/:userId', requireAuth, requireRole('company_admin'), async (req, res) => {
  const targetId = Number(req.params.userId);

  if (targetId === req.user.id) {
    // Without this, a Company Admin could deactivate themselves and — if they were
    // the only admin — permanently lock the company out of team management, since
    // only a company_admin can reactivate/manage the team in the first place.
    return res.status(400).json({ error: 'You cannot remove your own account.' });
  }

  // Scoped to company_id so a company_admin can only ever remove someone on their
  // OWN team — never a user row belonging to a different company.
  const result = await db.query(
    `UPDATE users SET is_active = false WHERE id = $1 AND company_id = $2 AND role != 'company_admin' RETURNING id, name, email, role`,
    [targetId, req.user.company_id]
  );

  if (!result.rows[0]) {
    // Covers three cases with one message: no such user, wrong company, or the
    // target is another company_admin. Removing a fellow admin is deliberately not
    // allowed here — that's a higher-trust action (admin demoting another admin)
    // that Platform Admin should mediate, not something to fold into a routine team
    // management endpoint.
    return res.status(404).json({ error: 'No removable team member found with that id (other company admins cannot be removed here).' });
  }

  res.json({ removed: result.rows[0] });
});

// POST /api/company/team/:userId/reactivate (company_admin) — undo an accidental
// removal, or bring someone back. Symmetric with the delete route above.
router.post('/team/:userId/reactivate', requireAuth, requireRole('company_admin'), async (req, res) => {
  const result = await db.query(
    `UPDATE users SET is_active = true WHERE id = $1 AND company_id = $2 RETURNING id, name, email, role`,
    [req.params.userId, req.user.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Team member not found' });
  res.json({ reactivated: result.rows[0] });
});

// GET /api/company/profile — the company's own editable profile fields.
router.get('/profile', requireAuth, requireRole('company_admin'), async (req, res) => {
  const result = await db.query(`SELECT id, name, gstin, address, industry_type, approval_status FROM companies WHERE id = $1`, [req.user.company_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json(result.rows[0]);
});

// PUT /api/company/profile (company_admin) — update the company's own profile.
// Deliberately does NOT allow editing gstin here, mirroring PUT /api/vendors/me's
// same exclusion and for the same reason: GSTIN is the identity anchor Platform Admin
// verified against the uploaded registration proof at approval time (Part 8.4).
// Fraud Detection's vendor_identity_mismatch check exists specifically to catch a
// mismatch between a claimed identity and a registered one — letting a company quietly
// change its own GSTIN post-approval would undermine that same principle from the
// other side. A genuine GSTIN correction should go through Platform Admin, not a
// self-service edit.
router.put('/profile', requireAuth, requireRole('company_admin'), async (req, res) => {
  const { name, address, industry_type } = req.body;
  const result = await db.query(
    `UPDATE companies SET
       name = COALESCE($1, name),
       address = COALESCE($2, address),
       industry_type = COALESCE($3, industry_type)
     WHERE id = $4 RETURNING id, name, gstin, address, industry_type`,
    [name, address, industry_type, req.user.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json(result.rows[0]);
});

module.exports = router;

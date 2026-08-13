const express = require('express');
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

module.exports = router;

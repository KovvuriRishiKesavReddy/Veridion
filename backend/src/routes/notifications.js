const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { recipientFilter } = require('../utils/notify');

const router = express.Router();

// Every authenticated role has a bell now (vendors, company roles, Platform Admin). What a
// user can see is decided by recipientFilter() — never by anything in the request.

// GET /api/notifications/mine — most recent first, for the bell dropdown.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const f = recipientFilter(req.user);
    if (!f) return res.json([]);
    const result = await db.query(
      `SELECT * FROM notifications WHERE ${f.where} ORDER BY created_at DESC, id DESC LIMIT 50`,
      f.params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load notifications' });
  }
});

// GET /api/notifications/unread-count — for the badge number on the bell icon.
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const f = recipientFilter(req.user);
    if (!f) return res.json({ count: 0 });
    const result = await db.query(
      `SELECT COUNT(*) FROM notifications WHERE ${f.where} AND is_read = false`,
      f.params
    );
    res.json({ count: Number(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load unread count' });
  }
});

// POST /api/notifications/:id/read — mark one as read (only if it is addressed to this user).
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const f = recipientFilter(req.user);
    if (!f) return res.status(404).json({ error: 'Notification not found' });
    const idParam = f.params.length + 1;
    const result = await db.query(
      `UPDATE notifications SET is_read = true WHERE id = $${idParam} AND ${f.where} RETURNING *`,
      [...f.params, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Notification not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update notification' });
  }
});

module.exports = router;

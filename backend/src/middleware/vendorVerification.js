const db = require('../db');

// requireVerifiedVendor: blocks any vendor whose CURRENT verification_status (read
// fresh from the database, never trusted from the JWT) isn't 'verified'. This was a
// real gap: a vendor got a valid JWT the moment they registered and could reach the
// full dashboard and act on the platform immediately — approval was never actually
// enforced, and a REJECTED vendor could still log in and use everything. This closes
// that gap at the only place that actually matters: the backend, on every request —
// not just a frontend redirect, which a bookmarked URL would simply skip past.
// No-ops for any role other than 'vendor', so it's safe to drop into any router.
async function requireVerifiedVendor(req, res, next) {
  if (req.user.role !== 'vendor') return next();

  const result = await db.query(`SELECT verification_status FROM vendors WHERE id = $1`, [req.user.vendor_id]);
  const vendor = result.rows[0];
  if (!vendor) return res.status(403).json({ error: 'No vendor profile found for this account.' });

  if (vendor.verification_status === 'pending') {
    return res.status(403).json({ error: 'Your vendor account is still pending Platform Admin approval.', verification_status: 'pending' });
  }
  if (vendor.verification_status === 'rejected') {
    return res.status(403).json({ error: 'Your vendor registration was rejected. Contact the platform for details.', verification_status: 'rejected' });
  }
  next();
}

module.exports = { requireVerifiedVendor };

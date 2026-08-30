const jwt = require('jsonwebtoken');
const db = require('../db');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // A JWT stays valid for its full 7-day lifetime regardless of anything that
    // happens to the account afterward — signature verification alone can't reflect a
    // Company Admin removing this person from the team five minutes ago. Re-checking
    // is_active fresh from the DB on every request (same pattern as
    // requireApprovedCompany/requireVerifiedVendor) closes that gap: a deactivated
    // team member's existing token stops working immediately, not just on next login.
    const result = await db.query(`SELECT is_active FROM users WHERE id = $1`, [payload.id]);
    if (!result.rows[0] || result.rows[0].is_active === false) {
      return res.status(401).json({ error: 'This account has been deactivated.' });
    }
    req.user = payload; // { id, role, company_id, vendor_id? }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };

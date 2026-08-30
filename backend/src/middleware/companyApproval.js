const db = require('../db');

// requireApprovedCompany: blocks any company-scoped user (company_admin, procurement,
// finance, warehouse) whose CURRENT company.approval_status (read fresh from the
// database, never trusted from the JWT) isn't 'approved'. Mirrors requireVerifiedVendor
// exactly, for the same reason: a company_admin got a valid JWT the instant they
// registered and could reach the full dashboard immediately — approval was never
// actually enforced anywhere. This closes that gap at the backend, on every mutating
// request — not just a frontend redirect, which a bookmarked URL would simply skip past.
// No-ops for 'vendor' and 'platform_admin' (neither is scoped to a single company's
// approval), so it's safe to drop into any router alongside requireRole.
async function requireApprovedCompany(req, res, next) {
  if (!['company_admin', 'procurement', 'finance', 'warehouse'].includes(req.user.role)) {
    return next();
  }

  if (!req.user.company_id) {
    return res.status(403).json({ error: 'No company found for this account.' });
  }

  const result = await db.query(`SELECT approval_status FROM companies WHERE id = $1`, [req.user.company_id]);
  const company = result.rows[0];
  if (!company) return res.status(403).json({ error: 'No company found for this account.' });

  if (company.approval_status === 'pending') {
    return res.status(403).json({ error: 'Your company is still pending Platform Admin approval.', approval_status: 'pending' });
  }
  if (company.approval_status === 'rejected') {
    return res.status(403).json({ error: 'Your company registration was rejected. Contact the platform for details.', approval_status: 'rejected' });
  }
  next();
}

module.exports = { requireApprovedCompany };

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { syncVendorNode } = require('../utils/neo4jSync');

const router = express.Router();

// GET /api/vendors/:id/platform-summary — Flow 5, Part 5.8's read-only, verified-only
// aggregate (the vendor_platform_summary view). Left as requireAuth only, no role
// restriction: both the vendor's own dashboard AND Procurement/Finance on the
// Quotation Comparison page (viewing a vendor they have no history with) need this,
// and it is pure aggregate reputation data, never a per-company breakdown — it is
// never read by any agent or fed into any company's own Context Gate (that stays
// scoped to the (company_id, vendor_id) vendor_risk_scores row everywhere else, e.g.
// rankQuotations.js). Falls back to an explicit zeroed object rather than 404 for a
// vendor with no platform-verified activity yet, since "not yet established" is a
// normal state here, not an error.
router.get('/:id/platform-summary', requireAuth, async (req, res) => {
  const result = await db.query(`SELECT * FROM vendor_platform_summary WHERE vendor_id = $1`, [req.params.id]);
  res.json(result.rows[0] || {
    vendor_id: Number(req.params.id),
    total_platform_verified_events: 0,
    aggregate_on_time_pct: null,
    num_companies_worked_with: 0,
    last_updated: null
  });
});

// GET /api/vendors/me — the vendor's own profile, including bank/address details they
// don't see anywhere else on the platform right now.
router.get('/me', requireAuth, requireRole('vendor'), async (req, res) => {
  const result = await db.query(`SELECT * FROM vendors WHERE id = $1`, [req.user.vendor_id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Vendor profile not found' });
  res.json(result.rows[0]);
});

// PUT /api/vendors/me — update bank/address/phone/notification preference. Deliberately
// does NOT allow editing company_name/gstin/pan here — those are what Platform Admin
// verified against the proof document; changing them post-verification should go
// through re-verification, not a quiet self-edit. Every update re-syncs the graph, so
// a vendor updating their bank account to match another vendor's is caught on the very
// next invoice, not just at registration time.
router.put('/me', requireAuth, requireRole('vendor'), async (req, res) => {
  const { phone_number, bank_account_number, bank_ifsc, address, preferred_notification_channel } = req.body;

  const current = await db.query(`SELECT * FROM vendors WHERE id = $1`, [req.user.vendor_id]);
  if (!current.rows[0]) return res.status(404).json({ error: 'Vendor profile not found' });

  const result = await db.query(
    `UPDATE vendors SET
       phone_number = COALESCE($1, phone_number),
       bank_account_number = COALESCE($2, bank_account_number),
       bank_ifsc = COALESCE($3, bank_ifsc),
       address = COALESCE($4, address),
       preferred_notification_channel = COALESCE($5, preferred_notification_channel)
     WHERE id = $6 RETURNING *`,
    [phone_number, bank_account_number, bank_ifsc, address, preferred_notification_channel, req.user.vendor_id]
  );

  const vendor = result.rows[0];
  syncVendorNode({ id: vendor.id, company_name: vendor.company_name, gstin: vendor.gstin, bank_account_number: vendor.bank_account_number, address: vendor.address });

  res.json(vendor);
});

module.exports = router;

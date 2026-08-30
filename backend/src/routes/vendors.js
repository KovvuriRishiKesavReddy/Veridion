const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { syncVendorNode } = require('../utils/neo4jSync');

const router = express.Router();

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

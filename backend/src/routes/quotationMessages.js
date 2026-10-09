const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { notifyVendor, notifyCompanyRole, safely } = require('../utils/notify');

const router = express.Router();

// Shared ownership check: a vendor can only reach THEIR OWN quotation; procurement can only
// reach a quotation on ONE OF THEIR OWN requirements. Neither can reach a quotation that
// belongs to a different vendor's/company's negotiation -- this is what keeps Vendor B from
// ever seeing Vendor A's price talk on the same requirement. Returns null (-> 404, not an
// empty thread) when the caller has no business seeing it.
async function loadQuotationScoped(quotationId, user) {
  if (!/^\d+$/.test(String(quotationId))) return null;
  const result = await db.query(
    `SELECT q.*, r.company_id, r.title AS requirement_title, v.company_name AS vendor_name
     FROM quotations q
     JOIN requirements r ON r.id = q.requirement_id
     JOIN vendors v ON v.id = q.vendor_id
     WHERE q.id = $1`,
    [quotationId]
  );
  const q = result.rows[0];
  if (!q) return null;
  if (user.role === 'vendor' && q.vendor_id !== user.vendor_id) return null;
  if (user.role === 'procurement' && q.company_id !== user.company_id) return null;
  return q;
}

// GET /api/quotation-messages/:quotationId (vendor or procurement) -- full history, always
// readable, even after the quotation is decided.
router.get('/:quotationId', requireAuth, requireRole('vendor', 'procurement'), async (req, res) => {
  const q = await loadQuotationScoped(req.params.quotationId, req.user);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  const result = await db.query(
    `SELECT * FROM quotation_messages WHERE quotation_id = $1 ORDER BY created_at ASC, id ASC`,
    [q.id]
  );
  res.json(result.rows);
});

// POST /api/quotation-messages/:quotationId (vendor or procurement) -- write-guarded to
// 'submitted' only, the same freeze-once-the-stage-is-done rule disputes follow. Once the
// quotation is accepted/rejected the thread is read-only history.
router.post('/:quotationId',
  requireAuth, requireRole('vendor', 'procurement'),
  (req, res, next) => req.user.role === 'vendor' ? requireVerifiedVendor(req, res, next) : requireApprovedCompany(req, res, next),
  async (req, res) => {
    const { message } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'message is required' });

    const q = await loadQuotationScoped(req.params.quotationId, req.user);
    if (!q) return res.status(404).json({ error: 'Quotation not found' });
    if (q.status !== 'submitted') {
      return res.status(400).json({ error: 'This quotation has already been decided — the negotiation window is closed.' });
    }

    const nameRes = await db.query(
      req.user.role === 'vendor' ? `SELECT company_name AS name FROM vendors WHERE id = $1` : `SELECT name FROM users WHERE id = $1`,
      [req.user.role === 'vendor' ? req.user.vendor_id : req.user.id]
    );
    const senderName = nameRes.rows[0]?.name || (req.user.role === 'vendor' ? 'Vendor' : 'Procurement');

    const result = await db.query(
      `INSERT INTO quotation_messages (quotation_id, sender_role, sender_name, message) VALUES ($1,$2,$3,$4) RETURNING *`,
      [q.id, req.user.role, senderName, String(message).trim()]
    );
    res.status(201).json(result.rows[0]);

    // Tell the other side (fire-and-forget, after the response, so it can never fail the send).
    safely((async () => {
      if (req.user.role === 'vendor') {
        await notifyCompanyRole(q.company_id, 'procurement', 'quotation_message',
          `${senderName} sent a message about their quotation for "${q.requirement_title}".`, q.id, 'quotation');
      } else {
        await notifyVendor(q.vendor_id, 'quotation_message',
          `${senderName} sent you a message about your quotation for "${q.requirement_title}".`, q.id, 'quotation');
      }
    })(), 'quotation_message');
  }
);

module.exports = router;

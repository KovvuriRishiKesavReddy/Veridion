const express = require('express');
const db = require('../db');
const { notifyVendor, notifyCompanyRole, notifyPlatformAdmins, safely } = require('../utils/notify');

const router = express.Router();

// Service-to-service endpoints (ai-service -> backend). Not for browsers: the ai-service
// is a separate process with its own DB connection, so it has no Socket.io instance and
// cannot push live notifications itself. It calls here instead, and this route does the
// notifying through the same helpers every other route uses.
//
// If INTERNAL_API_SECRET is set on the backend, callers must send it as x-internal-secret
// (set the same value in ai-service/.env). Left unset it is open — fine on localhost, but
// set it for any real deployment. Either way the endpoint takes only an id and derives
// every message from the database, and it is idempotent per decision, so it cannot be used
// to inject arbitrary text or to spam duplicates.
router.use((req, res, next) => {
  const secret = process.env.INTERNAL_API_SECRET;
  if (secret && req.headers['x-internal-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid internal secret' });
  }
  next();
});

// True if a notification of this kind already exists that is newer than `since`.
async function alreadyNotified(clause, params) {
  const r = await db.query(`SELECT 1 FROM notifications WHERE ${clause} LIMIT 1`, params);
  return r.rows.length > 0;
}

// POST /api/internal/pipeline-complete { invoice_id } — called by ai-service when the
// verification pipeline has written its decision for an invoice.
//   * Finance:        flagged -> "needs review"; auto-approved -> "verified, ready for payment"
//   * Vendor:         auto-approved -> "your invoice was verified and approved"
//   * Platform Admin: one notification per fraud flag raised on this invoice
router.post('/pipeline-complete', async (req, res) => {
  try {
    const invoiceId = Number(req.body.invoice_id);
    if (!invoiceId) return res.status(400).json({ error: 'invoice_id is required' });

    const infoRes = await db.query(
      `SELECT inv.id, inv.invoice_number, inv.invoice_amount, inv.vendor_id, po.id AS po_id, po.company_id,
              v.company_name AS vendor_name, c.name AS company_name, r.title AS item
       FROM invoices inv
       JOIN purchase_orders po ON po.id = inv.po_id
       JOIN vendors v ON v.id = inv.vendor_id
       JOIN companies c ON c.id = po.company_id
       JOIN requirements r ON r.id = po.requirement_id
       WHERE inv.id = $1`, [invoiceId]);
    const info = infoRes.rows[0];
    if (!info) return res.status(404).json({ error: 'Invoice not found' });

    const decRes = await db.query(`SELECT * FROM decisions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
    const decision = decRes.rows[0];
    if (!decision) return res.json({ notified: false, reason: 'no decision yet' });

    const label = info.invoice_number ? `Invoice ${info.invoice_number}` : `Invoice #${info.id}`;
    const approved = decision.final_decision === 'auto_approved';
    const finType = approved ? 'invoice_verified' : 'invoice_flagged';

    // Idempotent per decision: skip if we already notified for this invoice since the decision.
    const done = await alreadyNotified(
      `company_id = $1 AND target_role = 'finance' AND type = $2 AND related_id = $3 AND created_at >= $4`,
      [info.company_id, finType, info.id, decision.decided_at]
    );
    if (!done) {
      if (approved) {
        safely(notifyCompanyRole(info.company_id, 'finance', finType,
          `${label} from ${info.vendor_name} (${info.item}) passed verification and is ready for payment approval.`, info.id, 'invoice'), 'finance invoice_verified');
        safely(notifyVendor(info.vendor_id, 'invoice_approved',
          `${info.company_name} verified and approved your ${label.toLowerCase()} for "${info.item}". Payment is pending.`, info.id, 'invoice'), 'vendor invoice_approved');
      } else {
        safely(notifyCompanyRole(info.company_id, 'finance', finType,
          `${label} from ${info.vendor_name} (${info.item}) was flagged by verification and needs your review.`, info.id, 'invoice'), 'finance invoice_flagged');
      }
    }

    // Fraud flags raised on this invoice -> Platform Admin (once per flag).
    const flagRes = await db.query(`SELECT id, flag_type, severity FROM fraud_flags WHERE invoice_id = $1 AND resolved = false`, [invoiceId]);
    for (const f of flagRes.rows) {
      const seen = await alreadyNotified(`type = 'fraud_flag' AND related_id = $1 AND related_type = 'fraud_flag' AND target_role = 'platform_admin'`, [f.id]);
      if (seen) continue;
      safely(notifyPlatformAdmins('fraud_flag',
        `${f.severity || 'New'} fraud flag (${String(f.flag_type).replace(/_/g, ' ')}) on ${label.toLowerCase()} from ${info.vendor_name} to ${info.company_name}.`, f.id, 'fraud_flag'), 'admin fraud_flag');
    }

    res.json({ notified: true });
  } catch (err) {
    console.error('[internal] pipeline-complete failed:', err.message);
    res.status(500).json({ error: 'Could not send notifications' });
  }
});

module.exports = router;

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { notifyVendor, notifyCompanyRole, safely } = require('../utils/notify');

const router = express.Router();

// Who can do what in this thread:
//   * Vendor and Warehouse converse -- post-award the only live topic is logistics (delivery dates,
//     split shipments, handover), and Warehouse is the team that receives the goods and records the
//     GRN, so it is the single buyer-side voice. That also keeps "the confirming message" for a
//     partial GRN unambiguous (see grn.js): one person on the buyer's side set the date.
//   * Procurement can READ the whole history (audit trail) but cannot post. Its negotiation with the
//     vendor happened in the pre-award quotation thread, which closes when it accepts.
//   * Finance has no access here at all (invoice questions go through Disputes).
// A vendor reaches only THEIR OWN purchase orders; procurement / warehouse only their own
// company's. Anything else is a 404 (not an empty thread), so existence isn't leaked.
async function loadPoScoped(poId, user) {
  if (!/^\d+$/.test(String(poId))) return null;
  const result = await db.query(
    `SELECT po.*, r.title AS requirement_title FROM purchase_orders po
     JOIN requirements r ON r.id = po.requirement_id WHERE po.id = $1`,
    [poId]
  );
  const po = result.rows[0];
  if (!po) return null;
  if (user.role === 'vendor' && po.vendor_id !== user.vendor_id) return null;
  if ((user.role === 'procurement' || user.role === 'warehouse') && po.company_id !== user.company_id) return null;
  return po;
}

// poClosure(po): is the post-award thread closed to NEW messages, and why? Two ways it closes
// (history always stays readable):
//   1. 'fulfilled' -- every unit on the PO has been confirmed by a GRN. The logistics
//      conversation (delivery timing, split shipments, handover) has nothing left to arrange, and
//      goods_receipt_notes locks a fulfilled PO against further GRNs, so this state is final.
//      From here, anything about the invoice runs through the Disputes channel with Finance.
//   2. 'paid' -- any invoice on the PO has status 'paid' (the real flag this codebase uses; see
//      invoices.js mark-paid / override-and-pay -- no separate payments table is written to).
// Applies to every participant, vendor included: a thread only one side can write to is not a
// conversation.
async function poClosure(po) {
  if (po.fulfillment_status === 'fulfilled') {
    return {
      closed: true, reason: 'fulfilled',
      note: 'All goods on this purchase order have been received and confirmed — this conversation is closed to new messages (history stays visible). Anything about the invoice continues through Disputes with Finance. If a receipt was entered by mistake, Warehouse or Procurement can raise a GRN correction request.'
    };
  }
  const paid = await db.query(`SELECT 1 FROM invoices WHERE po_id = $1 AND status = 'paid' LIMIT 1`, [po.id]);
  if (paid.rows.length) {
    return { closed: true, reason: 'paid', note: 'This purchase order has been paid — the conversation is closed to new messages (history stays visible).' };
  }
  return { closed: false, reason: null, note: null };
}

// GET /api/po-messages/:poId (vendor, procurement or warehouse) -- full history, always readable.
router.get('/:poId', requireAuth, requireRole('vendor', 'procurement', 'warehouse'), async (req, res) => {
  const po = await loadPoScoped(req.params.poId, req.user);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  const result = await db.query(`SELECT * FROM po_messages WHERE po_id = $1 ORDER BY created_at ASC, id ASC`, [po.id]);
  res.json(result.rows);
});

// GET /api/po-messages/:poId/status -- { closed, reason, note }, so the UI can disable the reply box (not the
// history) once an invoice on this PO is paid, without needing a failed POST first.
router.get('/:poId/status', requireAuth, requireRole('vendor', 'procurement', 'warehouse'), async (req, res) => {
  const po = await loadPoScoped(req.params.poId, req.user);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json(await poClosure(po));
});

// POST /api/po-messages/:poId (vendor or warehouse) -- logistics only. Nothing here ever touches
// agreed_price; there is no field for it in this table at all. Procurement gets a clear 403 (it is
// read-only here, see the note at the top); Finance and every other role are refused by
// requireRole with a 403.
router.post('/:poId',
  requireAuth,
  (req, res, next) => req.user && req.user.role === 'procurement'
    ? res.status(403).json({ error: 'After the quotation is accepted, delivery conversations with the vendor are handled by Warehouse. Procurement can read this history but cannot post in it.' })
    : next(),
  requireRole('vendor', 'warehouse'),
  (req, res, next) => req.user.role === 'vendor' ? requireVerifiedVendor(req, res, next) : requireApprovedCompany(req, res, next),
  async (req, res) => {
    const { message } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'message is required' });

    const po = await loadPoScoped(req.params.poId, req.user);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    const closure = await poClosure(po);
    if (closure.closed) return res.status(400).json({ error: closure.note, reason: closure.reason });

    const nameRes = await db.query(
      req.user.role === 'vendor' ? `SELECT company_name AS name FROM vendors WHERE id = $1` : `SELECT name FROM users WHERE id = $1`,
      [req.user.role === 'vendor' ? req.user.vendor_id : req.user.id]
    );
    const senderName = nameRes.rows[0]?.name ||
      (req.user.role === 'vendor' ? 'Vendor' : 'Warehouse');

    const result = await db.query(
      `INSERT INTO po_messages (po_id, sender_role, sender_name, message) VALUES ($1,$2,$3,$4) RETURNING *`,
      [po.id, req.user.role, senderName, String(message).trim()]
    );
    res.status(201).json(result.rows[0]);

    // Tell the other party (fire-and-forget): a vendor's message goes to Warehouse (the only buyer-side
    // team that converses here); a Warehouse message goes to the vendor.
    safely((async () => {
      const text = `${senderName} sent a message about purchase order #${po.id} ("${po.requirement_title}").`;
      if (req.user.role === 'vendor') {
        await notifyCompanyRole(po.company_id, ['warehouse'], 'po_message', text, po.id, 'po');
      } else {
        await notifyVendor(po.vendor_id, 'po_message', text, po.id, 'po');
      }
    })(), 'po_message');
  }
);

module.exports = router;

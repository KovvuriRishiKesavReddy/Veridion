const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { notifyVendor, notifyCompanyRole, safely } = require('../utils/notify');

const router = express.Router();

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

// isPoClosedToMessages: freezes the thread once ANY invoice on this PO has been paid --
// invoices.status = 'paid' is the real flag this codebase uses (see invoices.js's mark-paid /
// override-and-pay routes); no separate payments table is actually written to.
async function isPoClosedToMessages(poId) {
  const result = await db.query(`SELECT 1 FROM invoices WHERE po_id = $1 AND status = 'paid' LIMIT 1`, [poId]);
  return result.rows.length > 0;
}

// GET /api/po-messages/:poId (vendor, procurement or warehouse) -- full history, always readable.
router.get('/:poId', requireAuth, requireRole('vendor', 'procurement', 'warehouse'), async (req, res) => {
  const po = await loadPoScoped(req.params.poId, req.user);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  const result = await db.query(`SELECT * FROM po_messages WHERE po_id = $1 ORDER BY created_at ASC, id ASC`, [po.id]);
  res.json(result.rows);
});

// GET /api/po-messages/:poId/status -- { closed }, so the UI can disable the reply box (not the
// history) once an invoice on this PO is paid, without needing a failed POST first.
router.get('/:poId/status', requireAuth, requireRole('vendor', 'procurement', 'warehouse'), async (req, res) => {
  const po = await loadPoScoped(req.params.poId, req.user);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json({ closed: await isPoClosedToMessages(po.id) });
});

// POST /api/po-messages/:poId (vendor, procurement or warehouse) -- logistics only. Nothing
// here ever touches agreed_price; there is no field for it in this table at all. Finance (and
// every other role) is refused by requireRole with a 403.
router.post('/:poId',
  requireAuth, requireRole('vendor', 'procurement', 'warehouse'),
  (req, res, next) => req.user.role === 'vendor' ? requireVerifiedVendor(req, res, next) : requireApprovedCompany(req, res, next),
  async (req, res) => {
    const { message } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'message is required' });

    const po = await loadPoScoped(req.params.poId, req.user);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });
    if (await isPoClosedToMessages(po.id)) {
      return res.status(400).json({ error: 'This purchase order has been paid — the conversation is closed to new messages.' });
    }

    const nameRes = await db.query(
      req.user.role === 'vendor' ? `SELECT company_name AS name FROM vendors WHERE id = $1` : `SELECT name FROM users WHERE id = $1`,
      [req.user.role === 'vendor' ? req.user.vendor_id : req.user.id]
    );
    const senderName = nameRes.rows[0]?.name ||
      (req.user.role === 'vendor' ? 'Vendor' : req.user.role === 'warehouse' ? 'Warehouse' : 'Procurement');

    const result = await db.query(
      `INSERT INTO po_messages (po_id, sender_role, sender_name, message) VALUES ($1,$2,$3,$4) RETURNING *`,
      [po.id, req.user.role, senderName, String(message).trim()]
    );
    res.status(201).json(result.rows[0]);

    // Tell the other parties (fire-and-forget): a vendor's message goes to Procurement AND
    // Warehouse (both act on it); a company-side message goes to the vendor.
    safely((async () => {
      const text = `${senderName} sent a message about purchase order #${po.id} ("${po.requirement_title}").`;
      if (req.user.role === 'vendor') {
        await notifyCompanyRole(po.company_id, ['procurement', 'warehouse'], 'po_message', text, po.id, 'po');
      } else {
        await notifyVendor(po.vendor_id, 'po_message', text, po.id, 'po');
      }
    })(), 'po_message');
  }
);

module.exports = router;

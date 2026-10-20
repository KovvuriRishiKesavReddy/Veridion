// backend/src/utils/paymentDeadlines.js
//
// Payment-deadline warnings for Finance. A vendor may enter an optional "Payment Due Date" when
// submitting an invoice (invoices.due_date). This util:
//   1. notifies the company's Finance role ONCE when an unpaid invoice enters the warning window
//      (type 'payment_due_soon'), and ONCE more when the date has passed (type 'payment_overdue');
//   2. closes those notifications (marks them read) as soon as the invoice is paid or withdrawn
//      (a withdrawn invoice is deleted, so "no longer exists" counts as closed too).
// No new table or migration: de-duplication is a lookup on the existing notifications table.
// The red/amber badge itself is computed in the browser from invoices.due_date.
const db = require('../db');
const { notifyCompanyRole } = require('./notify');

const DUE_SOON_DAYS = 3;                 // keep in sync with DUE_SOON_DAYS in frontend/shared/api.js
const TYPES = ['payment_due_soon', 'payment_overdue'];
const THROTTLE_MS = 60 * 1000;           // on-demand checks (page loads) run at most once a minute
let lastRun = 0;

// Mark deadline notifications read once their invoice is paid or gone.
async function closeResolved() {
  await db.query(
    `UPDATE notifications n SET is_read = true
     WHERE n.type = ANY($1) AND n.is_read = false AND n.related_type = 'invoice'
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = n.related_id AND i.status <> 'paid')`,
    [TYPES]
  );
}

async function checkPaymentDeadlines({ force = false } = {}) {
  if (!force && Date.now() - lastRun < THROTTLE_MS) return;
  lastRun = Date.now();
  await closeResolved();
  const { rows } = await db.query(
    `SELECT inv.id, inv.invoice_number, inv.due_date, po.company_id, v.company_name AS vendor_name,
            (inv.due_date < CURRENT_DATE) AS overdue,
            (inv.due_date - CURRENT_DATE) AS days_left
     FROM invoices inv
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN vendors v ON v.id = inv.vendor_id
     WHERE inv.due_date IS NOT NULL AND inv.status <> 'paid'
       AND inv.due_date <= CURRENT_DATE + $1::int`,
    [DUE_SOON_DAYS]
  );
  for (const inv of rows) {
    const type = inv.overdue ? 'payment_overdue' : 'payment_due_soon';
    const seen = await db.query(
      `SELECT 1 FROM notifications
       WHERE company_id = $1 AND target_role = 'finance' AND type = $2
         AND related_type = 'invoice' AND related_id = $3 LIMIT 1`,
      [inv.company_id, type, inv.id]
    );
    if (seen.rows.length) continue;
    const label = inv.invoice_number || `#${inv.id}`;
    const days = Number(inv.days_left);
    const message = inv.overdue
      ? `Payment overdue: invoice ${label} from ${inv.vendor_name} was due ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago.`
      : days === 0
        ? `Payment due today: invoice ${label} from ${inv.vendor_name}.`
        : `Payment deadline approaching: invoice ${label} from ${inv.vendor_name} is due in ${days} day${days === 1 ? '' : 's'}.`;
    await notifyCompanyRole(inv.company_id, 'finance', type, message, inv.id, 'invoice');
  }
}

// Fire-and-forget wrapper so a failure here can never break a request or crash the server.
function checkSafely(opts) {
  checkPaymentDeadlines(opts).catch(err => console.error('[paymentDeadlines] check failed:', err.message));
}
function closeSafely() {
  closeResolved().catch(err => console.error('[paymentDeadlines] close failed:', err.message));
}

module.exports = { checkPaymentDeadlines, checkSafely, closeSafely, closeResolved, DUE_SOON_DAYS };

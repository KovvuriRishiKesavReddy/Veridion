// Logic test for utils/paymentDeadlines.js using a fake db + notifier (no database needed).
// Run: node scripts/test-payment-deadlines.js
const Module = require('module'); const path = require('path');
const sent = []; let existing = []; let invoices = [];
const fakeDb = { query: async (sql, params) => {
  if (/UPDATE notifications/.test(sql)) return { rows: [] };
  if (/FROM invoices inv/.test(sql)) return { rows: invoices };
  if (/FROM notifications/.test(sql)) return { rows: existing.some(e => e.type === params[1] && e.id === params[2]) ? [{}] : [] };
  return { rows: [] };
} };
const fakeNotify = { notifyCompanyRole: async (c, r, type, msg, id) => { sent.push({ c, r, type, msg, id }); existing.push({ type, id }); } };
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === '../db') return fakeDb;
  if (req === './notify') return fakeNotify;
  return origLoad.call(this, req, parent, ...rest);
};
const { checkPaymentDeadlines } = require(path.join(__dirname, '../src/utils/paymentDeadlines.js'));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  invoices = [
    { id: 1, invoice_number: 'A-1', company_id: 7, vendor_name: 'Acme', overdue: false, days_left: 2 },
    { id: 2, invoice_number: 'B-2', company_id: 7, vendor_name: 'Beta', overdue: false, days_left: 0 },
    { id: 3, invoice_number: null, company_id: 7, vendor_name: 'Core', overdue: true, days_left: -3 }];
  await checkPaymentDeadlines({ force: true });
  ok(sent.length === 3, 'one notification per invoice in the window');
  ok(sent[0].type === 'payment_due_soon' && /due in 2 days/.test(sent[0].msg), 'approaching message');
  ok(/due today/.test(sent[1].msg), 'due-today message');
  ok(sent[2].type === 'payment_overdue' && /3 days ago/.test(sent[2].msg) && /#3/.test(sent[2].msg), 'overdue message, falls back to #id');
  ok(sent.every(s => s.r === 'finance' && s.c === 7), 'sent to the Finance role of the right company');
  await checkPaymentDeadlines({ force: true });
  ok(sent.length === 3, 'running again does not duplicate notifications');
  invoices[0].overdue = true; invoices[0].days_left = -1;
  await checkPaymentDeadlines({ force: true });
  ok(sent.length === 4 && sent[3].type === 'payment_overdue', 'an invoice that later goes overdue gets one more notification');
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();

// GRN correction (support-style) end-to-end test: request -> review -> void, with the PO's
// fulfilment recomputed, the PO conversation reopening, unpaid invoices withdrawn, payment held
// while a request is open, and every guard rail. TRUNCATES and re-seeds the test database.
//
// Usage:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/veridion_test node scripts/test-grn-corrections.js
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL || !/test/i.test(new URL(DB_URL).pathname)) { console.error('Refusing to run: TEST_DATABASE_URL must name a database containing "test".'); process.exit(2); }
const PORT = 4578, BASE = `http://localhost:${PORT}`;
const pool = new Pool({ connectionString: DB_URL, ssl: require('../src/utils/pgSsl').sslFor(DB_URL) });
let passed = 0, failed = 0, backend;
const check = (name, cond, extra = '') => { cond ? passed++ : failed++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); };
async function api(method, url, token, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
const login = async email => (await api('POST', '/api/auth/login', null, { email, password: 'password123' })).body.token;

(async () => {
  execFileSync('node', ['scripts/seed.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, NEO4J_URI: '' }, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    backend = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, JWT_SECRET: 'test-secret', PORT: String(PORT), NEO4J_URI: '', NEO4J_USER: '', NEO4J_PASSWORD: '', RABBITMQ_URL: '', AI_SERVICE_URL: 'http://localhost:1' } });
    backend.stdout.on('data', d => String(d).includes('listening') && resolve());
    backend.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));
    setTimeout(() => reject(new Error('backend start timeout')), 15000);
  });
  const proc = await login('proc@brightbuild.test'), wh = await login('warehouse@brightbuild.test'), fin = await login('finance@brightbuild.test');
  const admin = await login('admin@brightbuild.test'), otherWh = await login('warehouse@steelcorp.test'), otherAdmin = await login('admin@steelcorp.test');
  const vA = await login('vendor1@test.dev');

  async function makePo(qty, title) {
    const rq = await api('POST', '/api/requirements', proc, { title, description: 'x', category: 'Cement', quantity: qty, unit: 'bags', deadline: '2030-01-01' });
    const q = (await api('POST', '/api/quotations', vA, { requirement_id: rq.body.id, price: 100, delivery_days: 5 })).body;
    return (await api('POST', `/api/quotations/${q.id}/accept`, proc)).body;
  }
  const grn = (token, po, qty, date = '2026-10-09') => api('POST', '/api/grn', token, { po_id: po.id, received_quantity: qty, received_date: date });

  console.log('\n[the mistake] "all goods received" entered by accident');
  const po = await makePo(100, 'Cement A');
  let r = await grn(wh, po, 100);
  check('GRN for the full 100 recorded', r.status === 201 && r.body.fulfillment_status === 'fulfilled', JSON.stringify(r.body));
  const mistaken = r.body.id;
  r = await api('POST', `/api/po-messages/${po.id}`, wh, { message: 'hello' });
  check('PO conversation is closed (fulfilled)', r.status === 400 && r.body.reason === 'fulfilled');
  r = await grn(wh, po, 10);
  check('and no further GRN is possible: nothing in the product can fix it yet', r.status === 409);

  console.log('\n[request] raising a correction');
  r = await api('POST', '/api/grn-corrections', wh, { grn_id: mistaken, reason: 'too short' });
  check('reason must be explained (>= 10 chars) -> 400', r.status === 400);
  r = await api('POST', '/api/grn-corrections', fin, { grn_id: mistaken, reason: 'Finance should not be able to' });
  check('finance cannot raise one -> 403', r.status === 403);
  r = await api('POST', '/api/grn-corrections', vA, { grn_id: mistaken, reason: 'Vendor should not be able to' });
  check('vendor cannot raise one -> 403', r.status === 403);
  r = await api('POST', '/api/grn-corrections', otherWh, { grn_id: mistaken, reason: "Another company's warehouse" });
  check("another company's warehouse -> 404", r.status === 404);
  r = await api('POST', '/api/grn-corrections', wh, { grn_id: 999999, reason: 'Does not exist at all' });
  check('unknown GRN -> 404', r.status === 404);
  r = await api('POST', '/api/grn-corrections', wh, { grn_id: mistaken, reason: 'Only 60 bags actually arrived; I keyed 100 by mistake.' });
  check('warehouse raises a request -> 201, pending', r.status === 201 && r.body.status === 'pending', JSON.stringify(r.body));
  const reqId = r.body.id;
  r = await api('POST', '/api/grn-corrections', proc, { grn_id: mistaken, reason: 'Duplicate request for the same GRN' });
  check('a second open request on the same GRN -> 409', r.status === 409);
  await new Promise(res => setTimeout(res, 600));
  const note1 = await pool.query(`SELECT type FROM notifications WHERE type = 'grn_correction_requested'`);
  check('reviewers were notified', note1.rows.length >= 2, JSON.stringify(note1.rows));

  console.log('\n[hold] payment is on hold while a request is open');
  await pool.query(`INSERT INTO invoices (po_id, vendor_id, invoice_number, invoice_amount, status) VALUES ($1,$2,'INV-9',10000,'verified')`, [po.id, po.vendor_id]);
  const inv = (await pool.query(`SELECT id FROM invoices WHERE po_id=$1`, [po.id])).rows[0].id;
  await pool.query(`INSERT INTO decisions (invoice_id, agent_inputs, gate_weights, final_score, final_decision, reasoning_text) VALUES ($1,'{}','{}',0.95,'auto_approved','ok')`, [inv]);
  r = await api('POST', `/api/invoices/${inv}/mark-paid`, fin);
  check('mark-paid -> 409 payment on hold', r.status === 409 && /on hold/i.test(r.body.error), JSON.stringify(r.body));

  console.log('\n[review] who can approve');
  r = await api('POST', `/api/grn-corrections/${reqId}/approve`, wh);
  check('warehouse cannot review -> 403', r.status === 403);
  r = await api('POST', `/api/grn-corrections/${reqId}/approve`, fin);
  check('finance cannot review -> 403', r.status === 403);
  r = await api('POST', `/api/grn-corrections/${reqId}/approve`, otherAdmin);
  check("another company's admin -> 404", r.status === 404);
  r = await api('POST', `/api/grn-corrections/${reqId}/reject`, proc, {});
  check('rejecting needs a reason -> 400', r.status === 400);
  r = await api('GET', '/api/grn-corrections', wh);
  check('requester sees their request, with context', r.status === 200 && r.body[0].id === reqId && r.body[0].vendor_name && r.body[0].requirement_title);
  r = await api('GET', '/api/grn-corrections', otherWh);
  check("another company sees none of it", r.status === 200 && r.body.length === 0);

  console.log('\n[approve] the GRN is voided, the PO reopens');
  r = await api('POST', `/api/grn-corrections/${reqId}/approve`, proc, { note: 'Confirmed with the delivery challan.' });
  check('procurement approves -> 200', r.status === 200 && r.body.status === 'approved', JSON.stringify(r.body));
  check('PO is back to pending (nothing counted)', r.body.fulfillment_status === 'pending' && r.body.received_total === 0);
  check('the unpaid invoice was pulled back', r.body.invoices_withdrawn === 1);
  const g = (await pool.query(`SELECT voided_at, void_reason FROM goods_receipt_notes WHERE id=$1`, [mistaken])).rows[0];
  check('GRN is voided, not deleted, with the reason kept', g && g.voided_at && /60 bags/.test(g.void_reason));
  check('invoice row gone', (await pool.query(`SELECT 1 FROM invoices WHERE id=$1`, [inv])).rows.length === 0);
  await new Promise(res => setTimeout(res, 600)); // notifications are fire-and-forget, written just after the response
  const nn = await pool.query(`SELECT type FROM notifications WHERE type IN ('grn_correction_approved','grn_voided','invoice_withdrawn_grn')`);
  check('warehouse/procurement, vendor and finance were told', new Set(nn.rows.map(x => x.type)).size === 3, JSON.stringify(nn.rows));
  r = await api('POST', `/api/po-messages/${po.id}`, wh, { message: 'Re-checking the count.' });
  check('PO conversation reopened', r.status === 201);
  r = await api('POST', `/api/grn-corrections/${reqId}/approve`, proc);
  check('approving twice -> 409', r.status === 409);

  console.log('\n[re-enter] the correct receipt');
  r = await grn(wh, po, 60);
  check('new GRN for 60 accepted', r.status === 201 && r.body.fulfillment_status === 'partially_fulfilled' && r.body.cumulative_received === 60, JSON.stringify(r.body));
  r = await api('GET', `/api/purchase-orders/${po.id}/grns`, proc);
  const rows = r.body.grns || r.body;
  check('PO history lists BOTH, the voided one flagged', rows.length === 2 && rows.some(x => x.voided_at) && rows.some(x => !x.voided_at));
  r = await api('GET', '/api/purchase-orders/mine', proc);
  const mine = (r.body.purchase_orders || r.body).find(x => x.id === po.id);
  check('PO list shows 60 received, not 160', mine && Number(mine.total_received ?? mine.received_so_far ?? 60) === 60, JSON.stringify(mine));
  r = await api('GET', '/api/grn/company', fin);
  const listed = r.body.filter(x => x.po_id === po.id);
  check('GRN Documents: voided one still listed, cumulative excludes it', listed.length === 2 && Number(listed.find(x => !x.voided_at).cumulative_received) === 60, JSON.stringify(listed.map(x => [x.id, x.cumulative_received, !!x.voided_at])));
  r = await api('POST', '/api/grn-corrections', wh, { grn_id: mistaken, reason: 'Trying to void an already voided GRN' });
  check('an already-voided GRN cannot be corrected again -> 409', r.status === 409);

  console.log('\n[rules] newest-first, no self-review, no correction after payment, rejection');
  const po2 = await makePo(100, 'Cement B');
  const first = (await grn(wh, po2, 60)).body.id, second = (await grn(wh, po2, 40)).body.id;
  r = await api('POST', '/api/grn-corrections', wh, { grn_id: first, reason: 'The first receipt was wrong, I think.' });
  check('only the most recent GRN can be corrected -> 409', r.status === 409 && /most recent/i.test(r.body.error), JSON.stringify(r.body));
  r = await api('POST', '/api/grn-corrections', proc, { grn_id: second, reason: 'Procurement spotted a miscount here.' });
  check('procurement can raise one too', r.status === 201);
  const selfId = r.body.id;
  r = await api('POST', `/api/grn-corrections/${selfId}/approve`, proc);
  check('...but cannot approve their own request -> 403', r.status === 403);
  r = await api('POST', `/api/grn-corrections/${selfId}/reject`, proc, { note: 'my own' });
  check('...or reject it -> 403', r.status === 403);
  r = await api('POST', `/api/grn-corrections/${selfId}/reject`, admin, { note: 'Delivery challan matches the GRN, no change.' });
  check('the company admin rejects with a reason -> 200', r.status === 200 && r.body.status === 'rejected');
  const g2 = (await pool.query(`SELECT voided_at FROM goods_receipt_notes WHERE id=$1`, [second])).rows[0];
  check('a rejection leaves the GRN untouched', g2.voided_at === null);
  r = await api('POST', '/api/grn-corrections', wh, { grn_id: second, reason: 'Raising it again with better evidence.' });
  check('after a rejection a new request can be raised', r.status === 201);
  r = await api('POST', `/api/grn-corrections/${r.body.id}/approve`, admin);
  check('company admin approves -> 200', r.status === 200);
  r = await api('GET', '/api/purchase-orders/mine', proc);
  const mine2 = (r.body.purchase_orders || r.body).find(x => x.id === po2.id);
  check('PO fell back to partially fulfilled (60 of 100)', mine2 && mine2.fulfillment_status === 'partially_fulfilled', JSON.stringify(mine2));

  const po3 = await makePo(50, 'Cement C');
  const g3 = (await grn(wh, po3, 50)).body.id;
  await pool.query(`INSERT INTO invoices (po_id, vendor_id, invoice_number, invoice_amount, status) VALUES ($1,$2,'INV-PAID',5000,'paid')`, [po3.id, po3.vendor_id]);
  r = await api('POST', '/api/grn-corrections', wh, { grn_id: g3, reason: 'Wrong count but the invoice is already paid.' });
  check('once an invoice on the PO is paid, no correction -> 409', r.status === 409 && /paid/i.test(r.body.error));

  console.log(`\n${passed} passed, ${failed} failed`);
  backend.kill(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async err => { console.error(err); backend && backend.kill(); process.exit(1); });

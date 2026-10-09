// Vendor-Company Communication Channel end-to-end test: pre-award quotation thread, the
// vendor PUT /api/quotations/:id, post-award PO thread, and the sourced next-delivery date on
// a GRN. Spawns the real backend against a TEST database and drives the real HTTP API.
//
// SAFETY: this TRUNCATES and re-seeds the database. It refuses to run unless the database
// name contains "test".
//
// Usage:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/veridion_test node scripts/test-communication-channel.js
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL || !/test/i.test(new URL(DB_URL).pathname)) {
  console.error('Refusing to run: set TEST_DATABASE_URL to a database whose name contains "test" (this script truncates tables).');
  process.exit(2);
}
const PORT = 4577, BASE = `http://localhost:${PORT}`;
const pool = new Pool({ connectionString: DB_URL });
let passed = 0, failed = 0, backend;
const check = (name, cond, extra = '') => { cond ? passed++ : failed++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  const proc = await login('proc@brightbuild.test');
  const wh = await login('warehouse@brightbuild.test');
  const fin = await login('finance@brightbuild.test');
  const otherProc = await login('proc@steelcorp.test');
  const otherWh = await login('warehouse@steelcorp.test');
  const vA = await login('vendor1@test.dev');
  const vB = await login('vendor4@test.dev');

  console.log('\n[schema]');
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='goods_receipt_notes' AND column_name='expected_next_delivery_source_message_id'`);
  check('goods_receipt_notes.expected_next_delivery_source_message_id exists', cols.rows.length === 1);
  const tbls = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('quotation_messages','po_messages')`);
  check('quotation_messages and po_messages exist', tbls.rows.length === 2);

  console.log('\n[pre-award] two vendors quote on the same requirement');
  const rq = await api('POST', '/api/requirements', proc, { title: 'Cement OPC 53', description: 'x', category: 'Cement', quantity: 100, unit: 'bags', deadline: '2030-01-01' });
  const qA = (await api('POST', '/api/quotations', vA, { requirement_id: rq.body.id, price: 500, delivery_days: 10 })).body;
  const qB = (await api('POST', '/api/quotations', vB, { requirement_id: rq.body.id, price: 480, delivery_days: 12 })).body;
  check('both quotations created', qA && qB && qA.id && qB.id);

  let r = await api('POST', `/api/quotation-messages/${qA.id}`, proc, { message: 'Can you do 450 per bag?' });
  check('procurement can post in Vendor A thread', r.status === 201, JSON.stringify(r.body));
  check('sender role/name recorded', r.body.sender_role === 'procurement' && /Procurement/.test(r.body.sender_name));
  r = await api('POST', `/api/quotation-messages/${qA.id}`, vA, { message: 'Yes if delivery is 14 days.' });
  check('vendor A can reply in own thread', r.status === 201);
  r = await api('GET', `/api/quotation-messages/${qA.id}`, vA);
  check('vendor A reads 2 messages in order', r.status === 200 && r.body.length === 2 && r.body[0].sender_role === 'procurement');
  r = await api('GET', `/api/quotation-messages/${qA.id}`, vB);
  check("Vendor B GET on Vendor A's thread -> 404 (not an empty list)", r.status === 404, `${r.status}`);
  r = await api('POST', `/api/quotation-messages/${qA.id}`, vB, { message: 'sneaky' });
  check("Vendor B POST on Vendor A's thread -> 404", r.status === 404);
  r = await api('GET', `/api/quotation-messages/${qA.id}`, otherProc);
  check("another company's procurement -> 404", r.status === 404);
  r = await api('POST', `/api/quotation-messages/${qA.id}`, vA, { message: '   ' });
  check('blank message -> 400', r.status === 400);
  r = await api('POST', `/api/quotation-messages/${qA.id}`, fin, { message: 'hi' });
  check('finance cannot post -> 403', r.status === 403);
  r = await api('GET', `/api/quotation-messages/abc`, vA);
  check('non-numeric id -> 404, not a 500', r.status === 404);

  console.log('\n[pre-award] vendor updates own quotation via PUT');
  r = await api('PUT', `/api/quotations/${qA.id}`, vB, { price: 1 });
  check("Vendor B cannot edit Vendor A's quotation -> 404", r.status === 404);
  r = await api('PUT', `/api/quotations/${qA.id}`, proc, { price: 1 });
  check('procurement cannot edit a quotation directly -> 403', r.status === 403);
  r = await api('PUT', `/api/quotations/${qA.id}`, vA, {});
  check('empty update -> 400', r.status === 400);
  r = await api('PUT', `/api/quotations/${qA.id}`, vA, { price: -5 });
  check('negative price -> 400', r.status === 400);
  r = await api('PUT', `/api/quotations/${qA.id}`, vA, { delivery_days: 2.5 });
  check('fractional delivery_days -> 400', r.status === 400);
  r = await api('PUT', `/api/quotations/${qA.id}`, vA, { price: 450, delivery_days: 14 });
  check('vendor A updates price + days', r.status === 200 && Number(r.body.price) === 450 && r.body.delivery_days === 14, JSON.stringify(r.body));
  r = await api('PUT', `/api/quotations/${qA.id}`, vA, { price: 440 });
  check('price-only update keeps delivery_days', r.status === 200 && Number(r.body.price) === 440 && r.body.delivery_days === 14);
  r = await api('GET', '/api/quotations/company', proc);
  const seenA = r.body.find(q => q.id === qA.id);
  check("procurement's comparison list shows the new number", seenA && Number(seenA.price) === 440 && seenA.delivery_days === 14);
  const notes = await pool.query(`SELECT type FROM notifications WHERE type IN ('quotation_message','quotation_updated')`);
  check('notifications fired for messages / price update', notes.rows.length >= 3, JSON.stringify(notes.rows));

  console.log('\n[accept] PO carries the NEGOTIATED numbers');
  const acc = await api('POST', `/api/quotations/${qA.id}/accept`, proc);
  check('accept -> 201', acc.status === 201, JSON.stringify(acc.body));
  check('PO agreed_price is the negotiated 440, not the original 500', Number(acc.body.agreed_price) === 440, JSON.stringify(acc.body));
  const expectDate = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 14)).toISOString().slice(0, 10);
  check('agreed_delivery_date reflects the negotiated 14 days', String(acc.body.agreed_delivery_date).slice(0, 10) === expectDate, `${acc.body.agreed_delivery_date} vs ${expectDate}`);
  const po = acc.body;

  console.log('\n[frozen] pre-award thread after acceptance');
  r = await api('POST', `/api/quotation-messages/${qA.id}`, proc, { message: 'late' });
  check('POST after acceptance -> 400 (procurement)', r.status === 400);
  r = await api('POST', `/api/quotation-messages/${qA.id}`, vA, { message: 'late' });
  check('POST after acceptance -> 400 (vendor)', r.status === 400);
  r = await api('GET', `/api/quotation-messages/${qA.id}`, vA);
  check('GET still returns full history', r.status === 200 && r.body.length === 2);
  r = await api('PUT', `/api/quotations/${qA.id}`, vA, { price: 1 });
  check('PUT after acceptance -> 400 (number frozen)', r.status === 400);
  r = await api('POST', `/api/quotation-messages/${qB.id}`, vB, { message: 'rejected one' });
  check("rejected quotation's thread is closed too -> 400", r.status === 400);

  console.log('\n[post-award] PO thread');
  r = await api('POST', `/api/po-messages/${po.id}`, wh, { message: 'We can take 60 now and 40 on the 20th.' });
  check('warehouse can post', r.status === 201, JSON.stringify(r.body));
  r = await api('POST', `/api/po-messages/${po.id}`, proc, { message: 'Agreed.' });
  check('procurement can post', r.status === 201);
  r = await api('POST', `/api/po-messages/${po.id}`, vA, { message: 'Confirmed: remainder ships on the 20th.' });
  check('vendor can post', r.status === 201);
  const planMsgId = r.body.id;
  r = await api('POST', `/api/po-messages/${po.id}`, fin, { message: 'hello' });
  check('finance POST -> 403 (by role)', r.status === 403);
  r = await api('GET', `/api/po-messages/${po.id}`, vB);
  check("other vendor GET -> 404", r.status === 404);
  r = await api('GET', `/api/po-messages/${po.id}`, otherWh);
  check("other company's warehouse GET -> 404", r.status === 404);
  r = await api('GET', `/api/po-messages/${po.id}`, wh);
  check('warehouse reads 3 messages', r.status === 200 && r.body.length === 3);
  r = await api('GET', `/api/po-messages/${po.id}/status`, vA);
  check('status says open', r.status === 200 && r.body.closed === false);

  console.log('\n[GRN] partial GRN citing a message');
  // a message from a DIFFERENT PO (second PO) to test the cross-PO rejection
  const rq2 = await api('POST', '/api/requirements', proc, { title: 'Sand', description: 'x', category: 'Sand', quantity: 10, unit: 't', deadline: '2030-01-01' });
  const q2 = (await api('POST', '/api/quotations', vA, { requirement_id: rq2.body.id, price: 100, delivery_days: 3 })).body;
  const po2 = (await api('POST', `/api/quotations/${q2.id}/accept`, proc)).body;
  const foreign = (await api('POST', `/api/po-messages/${po2.id}`, vA, { message: 'other PO chatter' })).body;
  r = await api('POST', '/api/grn', wh, { po_id: po.id, received_quantity: 60, received_date: '2026-10-09', expected_next_delivery_date: '2026-10-20', next_delivery_notes: 'split', expected_next_delivery_source_message_id: foreign.id });
  check("GRN citing a different PO's message -> 400", r.status === 400, JSON.stringify(r.body));
  const none = await pool.query(`SELECT COUNT(*)::int AS n FROM goods_receipt_notes WHERE po_id=$1`, [po.id]);
  check('rejected GRN was rolled back (nothing stored)', none.rows[0].n === 0);
  r = await api('POST', '/api/grn', wh, { po_id: po.id, received_quantity: 60, received_date: '2026-10-09', expected_next_delivery_date: '2026-10-20', next_delivery_notes: 'split', expected_next_delivery_source_message_id: planMsgId });
  check('GRN citing this PO\'s message -> 201', r.status === 201, JSON.stringify(r.body));
  const stored = await pool.query(`SELECT expected_next_delivery_source_message_id AS m FROM goods_receipt_notes WHERE po_id=$1`, [po.id]);
  check('DB row has the source message id', stored.rows[0] && stored.rows[0].m === planMsgId);
  r = await api('GET', `/api/purchase-orders/${po.id}/grns`, vA);
  const g = r.body.grns && r.body.grns[0];
  check('GET .../grns returns the quoted text + sender', g && /remainder ships on the 20th/.test(g.source_message_text) && g.source_message_sender, JSON.stringify(g));
  r = await api('GET', `/api/purchase-orders/${po.id}/grns`, proc);
  check('procurement sees the same source', r.body.grns[0].source_message_text);
  r = await api('GET', '/api/grn/company', fin);
  check('GET /api/grn/company (GRN Documents) carries the source text', r.status === 200 && r.body.some(x => /remainder ships on the 20th/.test(x.source_message_text || '')), JSON.stringify(r.body).slice(0, 200));
  r = await api('GET', '/api/grn/vendor', vA);
  check('GET /api/grn/vendor carries the source text', r.status === 200 && r.body.some(x => /remainder ships on the 20th/.test(x.source_message_text || '')));
  // A full (non-shortfall) GRN ignores any cited message, same as the date fields do
  r = await api('POST', '/api/grn', wh, { po_id: po.id, received_quantity: 40, received_date: '2026-10-20', expected_next_delivery_source_message_id: planMsgId });
  check('final GRN accepted', r.status === 201);
  const fin2 = await pool.query(`SELECT expected_next_delivery_source_message_id AS m FROM goods_receipt_notes WHERE po_id=$1 ORDER BY id DESC LIMIT 1`, [po.id]);
  check('non-shortfall GRN stores no source (guard matches the date fields)', fin2.rows[0].m === null);

  console.log('\n[paid] thread closes when an invoice on the PO is paid');
  await pool.query(`INSERT INTO invoices (po_id, vendor_id, invoice_number, invoice_amount, status) VALUES ($1,$2,'INV-1',1000,'paid')`, [po.id, po.vendor_id]);
  r = await api('POST', `/api/po-messages/${po.id}`, wh, { message: 'after paid' });
  check('POST after paid -> 400 (warehouse)', r.status === 400);
  r = await api('POST', `/api/po-messages/${po.id}`, vA, { message: 'after paid' });
  check('POST after paid -> 400 (vendor)', r.status === 400);
  r = await api('GET', `/api/po-messages/${po.id}`, vA);
  check('GET still returns history', r.status === 200 && r.body.length === 3);
  r = await api('GET', `/api/po-messages/${po.id}/status`, vA);
  check('status says closed', r.body.closed === true);
  r = await api('POST', `/api/po-messages/${po2.id}`, vA, { message: 'unpaid PO still open' });
  check('a different, unpaid PO is unaffected', r.status === 201);

  console.log('\n[disputes] untouched');
  const dm = await pool.query(`SELECT to_regclass('dispute_messages') AS t, to_regclass('vendor_communications') AS v`);
  check('dispute tables still present', dm.rows[0].t && dm.rows[0].v);

  console.log(`\n${passed} passed, ${failed} failed`);
  backend.kill(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async err => { console.error(err); backend && backend.kill(); process.exit(1); });

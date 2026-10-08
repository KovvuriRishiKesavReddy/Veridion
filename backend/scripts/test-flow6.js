// Flow 6 end-to-end test: vendor voice notification on quotation acceptance.
//
// Spawns the real backend against a TEST database, plus a mock OmniDimension server, then
// drives the real HTTP API (register/login/post requirement/quote/accept) and checks both the
// outcome and the outbound_notifications audit rows.
//
// SAFETY: this TRUNCATES and re-seeds the database. It refuses to run unless the database
// name contains "test".
//
// Usage:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/veridion_test node scripts/test-flow6.js
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL || !/test/i.test(new URL(DB_URL).pathname)) {
  console.error('Refusing to run: set TEST_DATABASE_URL to a database whose name contains "test" (this script truncates tables).');
  process.exit(2);
}
const BACKEND_PORT = 4555, MOCK_PORT = 4556;
const BASE = `http://localhost:${BACKEND_PORT}`;
const pool = new Pool({ connectionString: DB_URL });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- mock OmniDimension ----------------------------------------------------
const mock = { calls: [], mode: 'ok', delayMs: 0 };
const mockServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    mock.calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const reply = () => {
      if (mock.mode === 'ok') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, status: 'dispatched', requestId: 3166940, custom_variables_count: 4 })); }
      else if (mock.mode === '500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'provider exploded' })); }
      else if (mock.mode === '401') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid api key' })); }
    };
    mock.delayMs ? setTimeout(reply, mock.delayMs) : reply();
  });
});

// ---- backend process -------------------------------------------------------
let backend;
function startBackend(extraEnv) {
  return new Promise((resolve, reject) => {
    backend = spawn('node', ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env, DATABASE_URL: DB_URL, JWT_SECRET: 'test-secret', PORT: String(BACKEND_PORT),
        NEO4J_URI: '', NEO4J_USER: '', NEO4J_PASSWORD: '', RABBITMQ_URL: '', AI_SERVICE_URL: 'http://localhost:1',
        ...extraEnv
      }
    });
    let ready = false;
    backend.stdout.on('data', d => { if (!ready && String(d).includes('listening')) { ready = true; resolve(); } });
    backend.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
    backend.on('exit', () => { if (!ready) reject(new Error('backend exited early')); });
    setTimeout(() => !ready && reject(new Error('backend start timeout')), 15000);
  });
}
async function stopBackend() { if (backend) { backend.kill(); await sleep(300); backend = null; } }

// ---- API helpers -----------------------------------------------------------
async function api(method, url, token, body) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function login(email) {
  const r = await api('POST', '/api/auth/login', null, { email, password: 'password123' });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}
async function seed() {
  const { execFileSync } = require('child_process');
  execFileSync('node', ['scripts/seed.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, NEO4J_URI: '' }, stdio: 'pipe' });
}
async function setVendor(email, fields) {
  const sets = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(',');
  await pool.query(`UPDATE vendors SET ${sets} WHERE user_id=(SELECT id FROM users WHERE email=$1)`, [email, ...Object.values(fields)]);
}
// Posts a requirement as procurement, has the vendor quote on it, then accepts it.
async function acceptFlow(procToken, vendorToken, title) {
  const rq = await api('POST', '/api/requirements', procToken, { title, description: 'x', category: 'Cement', quantity: 100, unit: 'bags', deadline: '2030-01-01' });
  if (rq.status !== 201) throw new Error('post requirement failed: ' + JSON.stringify(rq));
  const q = await api('POST', '/api/quotations', vendorToken, { requirement_id: rq.body.id, price: 500, delivery_days: 5 });
  if (q.status !== 201) throw new Error('quote failed: ' + JSON.stringify(q));
  const t0 = Date.now();
  const acc = await api('POST', `/api/quotations/${q.body.id}/accept`, procToken);
  return { acc, ms: Date.now() - t0 };
}
async function notificationFor(poId, waitForStatusNot = 'queued') {
  for (let i = 0; i < 40; i++) {
    const r = await pool.query(`SELECT * FROM outbound_notifications WHERE reference_type='quotation_accepted' AND reference_id=$1`, [poId]);
    if (r.rows[0] && r.rows[0].status !== waitForStatusNot) return r.rows[0];
    await sleep(100);
  }
  const r = await pool.query(`SELECT * FROM outbound_notifications WHERE reference_id=$1`, [poId]);
  return r.rows[0] || null;
}

(async () => {
  await new Promise(r => mockServer.listen(MOCK_PORT, r));
  const omniEnv = {
    OMNIDIMENSION_API_KEY: 'test-key', OMNIDIMENSION_AGENT_ID: '158910', OMNIDIMENSION_OUTBOUND_NUMBER_ID: '23',
    OMNIDIMENSION_BASE_URL: `http://localhost:${MOCK_PORT}/api/v1`
  };

  console.log('\n[unit] normalizePhoneNumber');
  const { normalizePhoneNumber, buildMessage } = require('../src/utils/notifyVendor');
  const cases = [
    ['+919876543210', '+919876543210'], ['9876543210', '+919876543210'], ['+91 98765-43210', '+919876543210'],
    ['09876543210', '+919876543210'], ['919876543210', '+919876543210'], ['0091 9876543210', '+919876543210'],
    ['(555) 123-4567', '+915551234567'], ['+1 415 555 2671', '+14155552671'],
    ['', null], ['abc', null], ['123', null], [null, null], ['+0123456789', null]
  ];
  for (const [input, expected] of cases) check(`normalize(${JSON.stringify(input)}) -> ${expected}`, normalizePhoneNumber(input) === expected, `got ${normalizePhoneNumber(input)}`);
  check('message text matches design doc 9.4', buildMessage({ companyName: 'BrightBuild', item: 'Cement' }) ===
    'This is an automated message from Veridion on behalf of BrightBuild. Your quotation for Cement has been accepted. A purchase order has been generated and is available on your Veridion vendor dashboard. Thank you.');

  console.log('\n[setup] seed + start backend (OmniDimension configured -> mock)');
  await seed();
  await startBackend(omniEnv);
  const proc = await login('proc@brightbuild.test');
  const vendor = await login('vendor1@test.dev');

  console.log('\n[1] voice_call, valid number -> call dispatched, notification sent');
  await setVendor('vendor1@test.dev', { preferred_notification_channel: 'voice_call', phone_number: '+919876543210' });
  mock.calls.length = 0; mock.mode = 'ok';
  let r = await acceptFlow(proc, vendor, 'Cement OPC 53');
  check('accept returns 201', r.acc.status === 201, JSON.stringify(r.acc.body));
  let n = await notificationFor(r.acc.body.id);
  check('outbound_notifications row is sent', n && n.status === 'sent', JSON.stringify(n));
  check('provider_message_id = requestId', n && n.provider_message_id === '3166940');
  check('channel recorded as voice_call', n && n.channel === 'voice_call');
  check('dialled number stored (E.164)', n && n.to_number === '+919876543210');
  check('exactly one dispatch call made', mock.calls.length === 1);
  const c = mock.calls[0];
  check('hit POST /api/v1/calls/dispatch', c && c.url === '/api/v1/calls/dispatch');
  check('bearer auth header sent', c && c.auth === 'Bearer test-key');
  check('agent_id sent as number', c && c.body.agent_id === 158910);
  check('from_number_id sent as number', c && c.body.from_number_id === 23);
  check('to_number is E.164', c && c.body.to_number === '+919876543210');
  check('call_context carries company/item/message', c && c.body.call_context.company_name === 'BrightBuild' && c.body.call_context.item === 'Cement OPC 53' && /has been accepted/.test(c.body.call_context.message));
  const po1 = await pool.query(`SELECT * FROM purchase_orders WHERE id=$1`, [r.acc.body.id]);
  check('PO exists and committed', po1.rows.length === 1);

  console.log('\n[2] local 10-digit number is normalised with default country code');
  await setVendor('vendor1@test.dev', { phone_number: '9876500000' });
  mock.calls.length = 0;
  r = await acceptFlow(proc, vendor, 'TMT Bars');
  n = await notificationFor(r.acc.body.id);
  check('sent', n && n.status === 'sent');
  check('dialled +919876500000', mock.calls[0] && mock.calls[0].body.to_number === '+919876500000');

  console.log('\n[3] invalid phone number -> notification failed, PO still created');
  await pool.query(`UPDATE vendors SET phone_number='12ab' WHERE user_id=(SELECT id FROM users WHERE email='vendor1@test.dev')`);
  mock.calls.length = 0;
  r = await acceptFlow(proc, vendor, 'Sand');
  check('accept still 201', r.acc.status === 201);
  n = await notificationFor(r.acc.body.id);
  check('row is failed with phone reason', n && n.status === 'failed' && /phone/i.test(n.error_message), JSON.stringify(n));
  check('provider never called', mock.calls.length === 0);

  console.log('\n[4] provider returns 500 -> failed, PO still created');
  await setVendor('vendor1@test.dev', { phone_number: '+919876543210' });
  mock.mode = '500'; mock.calls.length = 0;
  r = await acceptFlow(proc, vendor, 'Bricks');
  check('accept still 201', r.acc.status === 201);
  n = await notificationFor(r.acc.body.id);
  check('row failed with provider error', n && n.status === 'failed' && /500/.test(n.error_message) && /exploded/.test(n.error_message), JSON.stringify(n));

  console.log('\n[5] provider returns 401 (bad key) -> failed, PO still created');
  mock.mode = '401';
  r = await acceptFlow(proc, vendor, 'Gravel');
  check('accept still 201', r.acc.status === 201);
  n = await notificationFor(r.acc.body.id);
  check('row failed with 401', n && n.status === 'failed' && /401/.test(n.error_message), JSON.stringify(n));

  console.log('\n[6] SLOW provider (4s) -> accept responds immediately (non-blocking), notification completes later');
  mock.mode = 'ok'; mock.delayMs = 4000; mock.calls.length = 0;
  r = await acceptFlow(proc, vendor, 'Steel Rods');
  check(`accept responded fast (${r.ms} ms < 2000 ms)`, r.acc.status === 201 && r.ms < 2000);
  // The background job inserts its audit row a few ms AFTER the response — wait for it to
  // appear, then confirm it is still 'queued' while the (4s) provider call is in flight.
  let early = { rows: [] };
  for (let i = 0; i < 20 && !early.rows.length; i++) {
    early = await pool.query(`SELECT status FROM outbound_notifications WHERE reference_id=$1`, [r.acc.body.id]);
    if (!early.rows.length) await sleep(50);
  }
  check('notification still in progress (queued) while provider is slow', early.rows[0] && early.rows[0].status === 'queued', JSON.stringify(early.rows));
  n = await notificationFor(r.acc.body.id);
  check('eventually sent', n && n.status === 'sent', JSON.stringify(n));
  mock.delayMs = 0;

  console.log('\n[7] vendor prefers SMS -> skipped (no provider), no call made');
  await setVendor('vendor1@test.dev', { preferred_notification_channel: 'sms' });
  mock.calls.length = 0;
  r = await acceptFlow(proc, vendor, 'Paint');
  check('accept 201', r.acc.status === 201);
  n = await notificationFor(r.acc.body.id);
  check('row skipped, channel sms', n && n.status === 'skipped' && n.channel === 'sms', JSON.stringify(n));
  check('no call made', mock.calls.length === 0);

  console.log('\n[8] vendor prefers app_only -> skipped');
  await setVendor('vendor1@test.dev', { preferred_notification_channel: 'app_only' });
  r = await acceptFlow(proc, vendor, 'Tiles');
  n = await notificationFor(r.acc.body.id);
  check('row skipped with in-app reason', n && n.status === 'skipped' && /in-app/i.test(n.error_message), JSON.stringify(n));

  console.log('\n[9] provider unreachable (connection refused) -> failed, PO still created');
  await setVendor('vendor1@test.dev', { preferred_notification_channel: 'voice_call' });
  await stopBackend();
  await startBackend({ ...omniEnv, OMNIDIMENSION_BASE_URL: 'http://localhost:1/api/v1' });
  const proc2 = await login('proc@brightbuild.test'), vendor2 = await login('vendor1@test.dev');
  r = await acceptFlow(proc2, vendor2, 'Glass');
  check('accept still 201', r.acc.status === 201);
  n = await notificationFor(r.acc.body.id);
  check('row failed', n && n.status === 'failed', JSON.stringify(n));

  console.log('\n[10] OmniDimension not configured -> skipped, PO still created');
  await stopBackend();
  await startBackend({ OMNIDIMENSION_API_KEY: '', OMNIDIMENSION_AGENT_ID: '', OMNIDIMENSION_OUTBOUND_NUMBER_ID: '' });
  const proc3 = await login('proc@brightbuild.test'), vendor3 = await login('vendor1@test.dev');
  r = await acceptFlow(proc3, vendor3, 'Wire');
  check('accept still 201', r.acc.status === 201);
  n = await notificationFor(r.acc.body.id);
  check('row skipped: not configured', n && n.status === 'skipped' && /not configured/i.test(n.error_message), JSON.stringify(n));

  console.log('\n[11] vendor-facing API');
  let nl = await api('GET', '/api/vendors/me/notifications', vendor3);
  check('GET /me/notifications 200 and non-empty', nl.status === 200 && nl.body.length >= 10, `status ${nl.status} len ${nl.body && nl.body.length}`);
  check('newest first', nl.body[0].created_at >= nl.body[nl.body.length - 1].created_at);
  check('provider internals not exposed', !('provider_message_id' in nl.body[0]) && !('to_number' in nl.body[0]));
  check('includes requirement title', nl.body.some(x => x.requirement_title === 'Wire'));
  const procNl = await api('GET', '/api/vendors/me/notifications', proc3);
  check('non-vendor gets 403', procNl.status === 403);
  const other = await login('vendor4@test.dev');
  const otherNl = await api('GET', '/api/vendors/me/notifications', other);
  check("another vendor sees none of vendor1's notifications", otherNl.status === 200 && otherNl.body.length === 0);

  console.log('\n[12] channel + phone validation');
  let put = await api('PUT', '/api/vendors/me', vendor3, { preferred_notification_channel: 'carrier_pigeon' });
  check('bad channel -> 400 (not a 500)', put.status === 400, JSON.stringify(put));
  put = await api('PUT', '/api/vendors/me', vendor3, { phone_number: 'not a number' });
  check('bad phone -> 400', put.status === 400, JSON.stringify(put));
  put = await api('PUT', '/api/vendors/me', vendor3, { phone_number: '+91 98765 11111', preferred_notification_channel: 'voice_call' });
  check('valid update -> 200', put.status === 200 && put.body.preferred_notification_channel === 'voice_call');

  console.log('\n[13] registration stores channel; rejects bad phone');
  const fd = (over = {}) => {
    const f = new FormData();
    const base = { name: 'New Vendor', email: `nv${Date.now()}${Math.random().toString(36).slice(2, 6)}@test.dev`, password: 'Passw0rd!', company_name: 'NV Co', gstin: '27AAAPV9999C1ZV', pan: 'AAAPV9999C', phone_number: '9876511111', address: 'Somewhere', bank_account_number: '55555', bank_ifsc: 'HDFC0000001', preferred_notification_channel: 'voice_call', ...over };
    for (const [k, v] of Object.entries(base)) f.append(k, v);
    f.append('business_reg_proof', new Blob(['x'], { type: 'text/plain' }), 'proof.txt');
    f.append('pan_proof', new Blob(['x'], { type: 'text/plain' }), 'pan.txt');
    return f;
  };
  let reg = await fetch(BASE + '/api/auth/register/vendor', { method: 'POST', body: fd() });
  const regBody = await reg.json();
  check('register 201', reg.status === 201, JSON.stringify(regBody));
  if (reg.status === 201) {
    const row = await pool.query(`SELECT preferred_notification_channel FROM vendors WHERE user_id=$1`, [regBody.user.id]);
    check('channel voice_call stored', row.rows[0].preferred_notification_channel === 'voice_call');
  }
  reg = await fetch(BASE + '/api/auth/register/vendor', { method: 'POST', body: fd({ phone_number: 'xx' }) });
  check('register with bad phone -> 400', reg.status === 400);
  reg = await fetch(BASE + '/api/auth/register/vendor', { method: 'POST', body: fd({ preferred_notification_channel: 'pigeon' }) });
  check('register with bad channel -> 400', reg.status === 400);
  const reg2 = await fetch(BASE + '/api/auth/register/vendor', { method: 'POST', body: (() => { const f = fd(); f.delete('preferred_notification_channel'); return f; })() });
  const reg2Body = await reg2.json();
  check('register without channel -> 201, defaults to sms', reg2.status === 201);
  if (reg2.status === 201) {
    const row = await pool.query(`SELECT preferred_notification_channel FROM vendors WHERE user_id=$1`, [reg2Body.user.id]);
    check('default channel sms', row.rows[0].preferred_notification_channel === 'sms');
  }

  console.log('\n[14] profile page markup + frontend wiring present');
  const fs = require('fs');
  const prof = fs.readFileSync(path.join(__dirname, '../../frontend/vendor/profile.html'), 'utf8');
  const regHtml = fs.readFileSync(path.join(__dirname, '../../frontend/vendor/register.html'), 'utf8');
  check('profile.html calls /api/vendors/me/notifications', prof.includes('/api/vendors/me/notifications'));
  check('register.html sends preferred_notification_channel', regHtml.includes("fd.append('preferred_notification_channel'"));
  const page = await fetch(BASE + '/vendor/profile.html');
  check('profile page served by backend', page.status === 200);

  await stopBackend();
  mockServer.close();
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => { console.error('TEST HARNESS ERROR:', err); await stopBackend(); process.exit(1); });

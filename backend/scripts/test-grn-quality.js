// GRN quality rating + required partial-delivery fields + quality ranking signal (migration 025).
// Covers the stop-and-test checklist: API validation, per-GRN persistence, quantity-weighted vendor
// rollup, data_volume incrementing once per GRN, cold start, and the ranking weights.
// TRUNCATES and re-seeds the test database.
//
// Usage:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/veridion_test node scripts/test-grn-quality.js
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL || !/test/i.test(new URL(DB_URL).pathname)) { console.error('Refusing to run: TEST_DATABASE_URL must name a database containing "test".'); process.exit(2); }
const PORT = 4579, BASE = `http://localhost:${PORT}`;
const pool = new Pool({ connectionString: DB_URL, ssl: require('../src/utils/pgSsl').sslFor(DB_URL) });

// ai-service modules read DATABASE_URL when first required, so point them at the test database.
process.env.DATABASE_URL = DB_URL;
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key-unused'; // Groq is unreachable here -> deterministic reasoning
const vendorRisk = require('../../ai-service/src/agents/vendorRisk');
const { runRankQuotationsAgent } = require('../../ai-service/src/agents/rankQuotations');

let passed = 0, failed = 0, backend;
const check = (name, cond, extra = '') => { cond ? passed++ : failed++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); };
async function api(method, url, token, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
const login = async email => (await api('POST', '/api/auth/login', null, { email, password: 'password123' })).body.token;
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  execFileSync('node', ['scripts/seed.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, NEO4J_URI: '' }, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    backend = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, JWT_SECRET: 'test-secret', PORT: String(PORT), NEO4J_URI: '', NEO4J_USER: '', NEO4J_PASSWORD: '', RABBITMQ_URL: '', AI_SERVICE_URL: 'http://localhost:1' } });
    backend.stdout.on('data', d => String(d).includes('listening') && resolve());
    backend.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));
    setTimeout(() => reject(new Error('backend start timeout')), 15000);
  });
  const proc = await login('proc@brightbuild.test'), wh = await login('warehouse@brightbuild.test');
  const vA = await login('vendor1@test.dev'), vB = await login('vendor2@test.dev');
  // The seed leaves vendor 2 pending; this test needs a second verified vendor with no history.
  await pool.query(`UPDATE vendors SET verification_status = 'verified'`);

  async function makePo(qty, title, vendorToken = vA, price = 100, days = 5) {
    const rq = await api('POST', '/api/requirements', proc, { title, description: 'x', category: 'Cement', quantity: qty, unit: 'bags', deadline: '2030-01-01' });
    const q = (await api('POST', '/api/quotations', vendorToken, { requirement_id: rq.body.id, price, delivery_days: days })).body;
    return (await api('POST', `/api/quotations/${q.id}/accept`, proc)).body;
  }
  const say = async (po, token = vA) => (await api('POST', `/api/po-messages/${po.id}`, token, { message: 'Remaining units will arrive on the 20th.' })).body.id;
  const grnCount = async po => (await pool.query(`SELECT COUNT(*)::int AS n FROM goods_receipt_notes WHERE po_id=$1`, [po.id])).rows[0].n;

  console.log('\n[quality rating] required on every GRN');
  const poFull = await makePo(100, 'Full A');
  let r = await api('POST', '/api/grn', wh, { po_id: poFull.id, received_quantity: 100, received_date: '2026-10-09' });
  check('GRN with no quality_rating -> 400', r.status === 400 && /quality_rating/.test(r.body.error), JSON.stringify(r.body));
  for (const bad of [0, 6, 3.5, 'abc', '']) {
    r = await api('POST', '/api/grn', wh, { po_id: poFull.id, received_quantity: 100, received_date: '2026-10-09', quality_rating: bad });
    check(`quality_rating ${JSON.stringify(bad)} -> 400`, r.status === 400);
  }
  check('rejected GRNs stored nothing', (await grnCount(poFull)) === 0);
  r = await api('POST', '/api/grn', wh, { po_id: poFull.id, received_quantity: 100, received_date: '2026-10-09', quality_rating: 4, quality_notes: 'two torn bags' });
  check('full GRN with a rating and NO next-delivery date/message -> 201 (rule is scoped to shortfalls)', r.status === 201, JSON.stringify(r.body));
  check('rating and note stored on the GRN row', r.body.quality_rating === 4 && r.body.quality_notes === 'two torn bags');

  console.log('\n[partial delivery] needs a confirmed date AND a conversation message');
  const po = await makePo(100, 'Split B');
  const msg = await say(po);
  const base = { po_id: po.id, received_quantity: 60, received_date: '2026-10-09', quality_rating: 5 };
  r = await api('POST', '/api/grn', wh, base);
  check('short GRN with no date and no message -> 400', r.status === 400 && /next-delivery date/.test(r.body.error), JSON.stringify(r.body));
  r = await api('POST', '/api/grn', wh, { ...base, expected_next_delivery_date: '2026-10-20' });
  check('short GRN with a date but no message -> 400', r.status === 400);
  r = await api('POST', '/api/grn', wh, { ...base, expected_next_delivery_source_message_id: msg });
  check('short GRN with a message but no date -> 400', r.status === 400);
  r = await api('POST', '/api/grn', wh, { ...base, expected_next_delivery_date: '2026-10-01', expected_next_delivery_source_message_id: msg });
  check('next date before the delivery date -> 400', r.status === 400 && /on or after/.test(r.body.error), JSON.stringify(r.body));
  check('none of the rejected partial GRNs were stored', (await grnCount(po)) === 0);
  r = await api('POST', '/api/grn', wh, { ...base, expected_next_delivery_date: '2026-10-20', expected_next_delivery_source_message_id: msg });
  check('short GRN with date + confirming message + rating -> 201', r.status === 201 && r.body.fulfillment_status === 'partially_fulfilled', JSON.stringify(r.body));
  const grn1 = r.body.id;
  r = await api('POST', '/api/grn', wh, { po_id: po.id, received_quantity: 40, received_date: '2026-10-20', quality_rating: 1, quality_notes: 'most units cracked' });
  check('final GRN (rated 1) needs no date/message -> 201', r.status === 201 && r.body.fulfillment_status === 'fulfilled', JSON.stringify(r.body));
  const grn2 = r.body.id;
  const rows = (await pool.query(`SELECT id, quality_rating FROM goods_receipt_notes WHERE po_id=$1 ORDER BY id`, [po.id])).rows;
  check('two GRNs on one PO keep their OWN ratings (5 then 1)', rows.length === 2 && rows[0].quality_rating === 5 && rows[1].quality_rating === 1, JSON.stringify(rows));

  console.log('\n[vendor rollup] quantity-weighted quality, data_volume +1 per GRN');
  const pair = async () => (await pool.query(`SELECT vrs.* FROM vendor_risk_scores vrs WHERE vrs.company_id=$1 AND vrs.vendor_id=$2`, [po.company_id, po.vendor_id])).rows[0];
  check('no risk row yet for this company/vendor pair', !(await pair()));
  await vendorRisk.onGrnConfirmed(po.id, grn1);
  let row = await pair();
  check('after GRN #1: data_volume is exactly 1 (not 2)', Number(row.data_volume) === 1, JSON.stringify(row));
  check('after GRN #1: quality_score = 100 (one 5-star delivery)', near(row.quality_score, 100));
  await vendorRisk.onGrnConfirmed(po.id, grn2);
  row = await pair();
  check('after GRN #2: data_volume is exactly 2 (one per GRN, not per unit/metric)', Number(row.data_volume) === 2);
  check('quality_score = 60 for 60 units @5 then 40 units @1 (NOT a flat 50)', near(row.quality_score, 60), `got ${row.quality_score}`);
  check('quality_weighted_units = 100 (60 + 40), separate from data_volume', near(row.quality_weighted_units, 100));
  check('grn_count = 2 and on-time metric still updated', Number(row.grn_count) === 2 && row.on_time_delivery_pct != null);

  console.log('\n[unchanged callers] the single-metric wrapper behaves exactly as before');
  const poOther = await makePo(10, 'Other', vB);
  await vendorRisk.updateVendorMetric(poOther.company_id, poOther.vendor_id, 'invoice_accuracy_pct', 100, { countColumn: 'invoice_decision_count', successColumn: 'invoice_decision_success_count' });
  await vendorRisk.updateVendorMetric(poOther.company_id, poOther.vendor_id, 'invoice_accuracy_pct', 0, { countColumn: 'invoice_decision_count', successColumn: 'invoice_decision_success_count' });
  await vendorRisk.updateVendorMetric(poOther.company_id, poOther.vendor_id, 'invoice_accuracy_pct', 100, { countColumn: 'invoice_decision_count', successColumn: 'invoice_decision_success_count' });
  const o = (await pool.query(`SELECT * FROM vendor_risk_scores WHERE company_id=$1 AND vendor_id=$2`, [poOther.company_id, poOther.vendor_id])).rows[0];
  check('invoice_accuracy_pct = 66.67 after 100,0,100; data_volume 3; counters 3/2; no quality touched', near(o.invoice_accuracy_pct, 66.667) && Number(o.data_volume) === 3 && Number(o.invoice_decision_count) === 3 && Number(o.invoice_decision_success_count) === 2 && o.quality_score === null, JSON.stringify(o));
  await pool.query(`DELETE FROM vendor_risk_scores WHERE company_id=$1 AND vendor_id=$2`, [poOther.company_id, poOther.vendor_id]);

  console.log('\n[ranking] quality is a 4th signal; cold start is not penalised');
  const rq = await api('POST', '/api/requirements', proc, { title: 'Ranked', description: 'x', category: 'Cement', quantity: 50, unit: 'bags', deadline: '2030-01-01' });
  await api('POST', '/api/quotations', vA, { requirement_id: rq.body.id, price: 100, delivery_days: 5 });
  await api('POST', '/api/quotations', vB, { requirement_id: rq.body.id, price: 100, delivery_days: 5 });
  const ranked = await runRankQuotationsAgent(rq.body.id);
  const withHistory = ranked.find(x => x.vendor_id === po.vendor_id), noHistory = ranked.find(x => x.vendor_id !== po.vendor_id);
  check('vendor with 2 rated GRNs but NO paid invoice: quality weight > 0', withHistory.gate_weights.quality > 0, JSON.stringify(withHistory.gate_weights));
  check('...while past_performance weight stays 0 (reads paid deals, still 0)', withHistory.gate_weights.past_performance === 0);
  check('vendor with no GRNs: quality weight is exactly 0 (cold start)', noHistory.gate_weights.quality === 0);
  check('...and its Price/Delivery weights are what they would be with no quality signal (1.0 vs 0.9 -> 0.526/0.474)', near(noHistory.gate_weights.price, 1 / 1.9, 0.001) && near(noHistory.gate_weights.delivery, 0.9 / 1.9, 0.001), JSON.stringify(noHistory.gate_weights));
  check('quality history shrinks the other shares (outcome redistributes, mechanism unchanged)', withHistory.gate_weights.price < noHistory.gate_weights.price);
  check('weights still sum to 1', near(Object.values(withHistory.gate_weights).reduce((a, b) => a + b, 0), 1, 1e-9));
  check('reasoning mentions quality', /quality/i.test(withHistory.ai_rank_reasoning), withHistory.ai_rank_reasoning);

  console.log(`\n${passed} passed, ${failed} failed`);
  backend.kill(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async err => { console.error(err); backend && backend.kill(); process.exit(1); });

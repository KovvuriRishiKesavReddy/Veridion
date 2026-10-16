// backend/scripts/test-vendor-risk-weighting.js
//
// Run:  npm run test:vendor-risk        (inside backend/, TEST database only)
//
// Guards the running averages in ai-service/src/agents/vendorRisk.js. Each metric must be averaged
// over ITS OWN events -- invoice_accuracy_pct over invoice decisions (invoice_decision_count),
// on_time_delivery_pct over deliveries (grn_count) -- never over the shared data_volume, which also
// counts every GRN, dispute and the legacy-import placeholder. Before this was fixed, a vendor with
// a legacy import (data_volume 12) whose first invoice was flagged and second was fine ended up at
// 100/14 = 7% accuracy instead of 1 good of 2 = 50%.
//
// Also checks the repair migration (db/026_fix_vendor_metric_weighting.sql) on rows damaged that way.
// Only ADDS its own rows (unique names) to the test database.
const path = require('path');
const fs = require('fs');
const backendDir = path.join(__dirname, '..');
const aiDir = path.join(backendDir, '..', 'ai-service');
const { Pool } = require(require.resolve('pg', { paths: [backendDir] }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = require(path.join(aiDir, 'src', 'db.js'));
const vr = require(path.join(aiDir, 'src', 'agents', 'vendorRisk.js'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
}
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;
const q = (t, p) => pool.query(t, p);
const one = async (t, p) => (await q(t, p)).rows[0];
const tag = Date.now().toString().slice(-7);
let companyId, userId, reqId, n = 0;

async function mkVendor() {
  n++;
  const u = await one(`INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,'x','vendor') RETURNING id`, [`VRW ${n}`, `vrw-${tag}-${n}@example.com`]);
  return one(`INSERT INTO vendors (user_id,company_name,verification_status) VALUES ($1,$2,'verified') RETURNING *`, [u.id, `VRW Vendor ${n} ${tag}`]);
}
// a PO (agreed delivery date fixed in the past) so GRNs can be on time or late
async function mkPo(vendor) {
  const qo = await one(`INSERT INTO quotations (requirement_id,vendor_id,price,delivery_days,status) VALUES ($1,$2,100,3,'selected') RETURNING id`, [reqId, vendor.id]);
  return one(`INSERT INTO purchase_orders (requirement_id,quotation_id,vendor_id,company_id,agreed_price,agreed_quantity,agreed_delivery_date) VALUES ($1,$2,$3,$4,100,10,'2026-01-10') RETURNING id`, [reqId, qo.id, vendor.id, companyId]);
}
async function invoiceDecision(vendor, po, decision) {
  const inv = await one(`INSERT INTO invoices (po_id,vendor_id,invoice_number,invoice_amount,gst_amount,status) VALUES ($1,$2,$3,100,18,'submitted') RETURNING id`, [po.id, vendor.id, `VRW-${tag}-${++n}`]);
  await vr.onInvoiceDecisionFinalised(inv.id, decision);
}
async function grn(vendor, po, onTime) {
  const g = await one(`INSERT INTO goods_receipt_notes (po_id,received_quantity,received_date,recorded_by,quality_rating) VALUES ($1,1,$2,$3,4) RETURNING id`, [po.id, onTime ? '2026-01-05' : '2026-01-20', userId]);
  await vr.onGrnConfirmed(po.id, g.id);
}
const risk = v => one(`SELECT * FROM vendor_risk_scores WHERE company_id=$1 AND vendor_id=$2`, [companyId, v.id]);
const legacy = (v, extra = {}) => vr.legacyImport(companyId, v.id, userId, { transactionCount: 28, onTimePct: 90, disputeRate: null, invoiceAccuracyPct: null, justification: 'test', ...extra });

async function main() {
  const c = await one(`INSERT INTO companies (name,approval_status) VALUES ($1,'approved') RETURNING id`, [`VRW Co ${tag}`]);
  companyId = c.id;
  userId = (await one(`INSERT INTO users (name,email,password_hash,role,company_id) VALUES ('VRW User',$1,'x','finance',$2) RETURNING id`, [`vrw-user-${tag}@example.com`, companyId])).id;
  reqId = (await one(`INSERT INTO requirements (company_id,title,category,quantity,unit,created_by) VALUES ($1,'VRW item','T',10,'u',$2) RETURNING id`, [companyId, userId])).id;

  console.log('\n[1] The reported case: legacy import (28 deals -> capped data_volume 12, NO invoice accuracy given)');
  let v = await mkVendor(); let po = await mkPo(v);
  await legacy(v);
  let r = await risk(v);
  check('setup: legacy data_volume capped at 12, no invoice accuracy', Number(r.data_volume) === 12 && r.invoice_accuracy_pct === null && r.invoice_decision_count === 0);
  await invoiceDecision(v, po, 'flagged');
  r = await risk(v);
  check('1st platform invoice flagged -> accuracy 0%', near(r.invoice_accuracy_pct, 0), r.invoice_accuracy_pct);
  await invoiceDecision(v, po, 'auto_approved');
  r = await risk(v);
  check('2nd invoice correct -> accuracy 50% (1 good of 2), NOT 7%', near(r.invoice_accuracy_pct, 50), `got ${r.invoice_accuracy_pct}`);
  check('exact counters agree: 1 of 2', r.invoice_decision_count === 2 && r.invoice_decision_success_count === 1);
  await invoiceDecision(v, po, 'auto_approved');
  r = await risk(v);
  check('3rd invoice correct -> 66.67% (2 of 3)', near(r.invoice_accuracy_pct, 66.67), r.invoice_accuracy_pct);

  console.log('\n[2] Other kinds of events must not dilute invoice accuracy');
  v = await mkVendor(); po = await mkPo(v);
  await grn(v, po, true); await invoiceDecision(v, po, 'flagged'); await grn(v, po, true); await invoiceDecision(v, po, 'auto_approved');
  r = await risk(v);
  check('GRNs in between: accuracy is still 1 good of 2 = 50%', near(r.invoice_accuracy_pct, 50), r.invoice_accuracy_pct);

  console.log('\n[3] Legacy import WITH an invoice accuracy keeps its (discounted) weight');
  v = await mkVendor(); po = await mkPo(v);
  await legacy(v, { invoiceAccuracyPct: 80 });
  r = await risk(v);
  check('setup: counters mirror the legacy figure (12 events)', r.invoice_decision_count === 12 && near(r.invoice_accuracy_pct, 80));
  await invoiceDecision(v, po, 'flagged');
  r = await risk(v);
  check('one flagged invoice moves 80% to (80x12 + 0)/13 = 73.85%', near(r.invoice_accuracy_pct, 73.85), r.invoice_accuracy_pct);

  console.log('\n[4] On-time delivery averages over deliveries only');
  v = await mkVendor(); po = await mkPo(v);
  await grn(v, po, true); await invoiceDecision(v, po, 'auto_approved'); await grn(v, po, false);
  r = await risk(v);
  check('1 on time + 1 late delivery (with an invoice in between) = 50%, not 66.7%', near(r.on_time_delivery_pct, 50), r.on_time_delivery_pct);
  v = await mkVendor(); po = await mkPo(v);
  await legacy(v, { onTimePct: 90 });
  await invoiceDecision(v, po, 'auto_approved'); await invoiceDecision(v, po, 'auto_approved'); await grn(v, po, false);
  r = await risk(v);
  check('legacy 90% over 12 deliveries + 1 late = 83.08%, invoices do not change the weight', near(r.on_time_delivery_pct, 83.08), r.on_time_delivery_pct);

  console.log('\n[5] Repair migration 026 on rows damaged by the old weighting');
  const migSql = fs.readFileSync(path.join(backendDir, '..', 'db', '026_fix_vendor_metric_weighting.sql'), 'utf8');
  // (a) platform-only vendor: counters say 1 good of 2, stored value is the old wrong 7.14
  const a = await mkVendor();
  await q(`INSERT INTO vendor_risk_scores (company_id,vendor_id,invoice_accuracy_pct,on_time_delivery_pct,data_volume,platform_verified_event_count,invoice_decision_count,invoice_decision_success_count,grn_count,grn_on_time_count) VALUES ($1,$2,7.14,66.67,3,3,2,1,2,1)`, [companyId, a.id]);
  // (b) legacy vendor with accuracy 80 over 12, then 1 good + 1 flagged, stored with the old (shared-weight) value
  const b = await mkVendor(); await legacy(b, { invoiceAccuracyPct: 80, onTimePct: 90 });
  await q(`UPDATE vendor_risk_scores SET invoice_accuracy_pct=60, invoice_decision_count=14, invoice_decision_success_count=11 WHERE company_id=$1 AND vendor_id=$2`, [companyId, b.id]);
  // (c) a vendor with no invoice events must be left exactly as it is
  const cV = await mkVendor(); await legacy(cV, { onTimePct: 75 });
  const beforeC = await risk(cV);
  await q(migSql);
  const ra = await risk(a), rb = await risk(b), rc = await risk(cV);
  check('(a) platform-only: accuracy repaired to 50, on-time repaired to 50', near(ra.invoice_accuracy_pct, 50) && near(ra.on_time_delivery_pct, 50), `${ra.invoice_accuracy_pct} / ${ra.on_time_delivery_pct}`);
  // legacy 12 events @80% = 10 good (round(12*0.8)=10 incl. rounding); platform: 11-10 = 1 good of 2 -> (80*12 + 100*1)/14 = 75.71
  check('(b) legacy + platform: (80x12 + 100x1)/14 = 75.71', near(rb.invoice_accuracy_pct, 75.71), rb.invoice_accuracy_pct);
  check('(c) row with no invoice events left untouched', rc.invoice_accuracy_pct === beforeC.invoice_accuracy_pct && near(rc.on_time_delivery_pct, 75));
  await q(migSql);
  const ra2 = await risk(a), rb2 = await risk(b);
  check('re-running the migration changes nothing (idempotent)', near(ra2.invoice_accuracy_pct, ra.invoice_accuracy_pct) && near(rb2.invoice_accuracy_pct, rb.invoice_accuracy_pct));
  check('migration never touches data_volume or the counters', ra2.data_volume === ra.data_volume && ra2.invoice_decision_count === 2 && rb2.invoice_decision_count === 14);

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  await pool.end(); await db.pool.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async err => { console.error('TEST SCRIPT ERROR:', err); try { await pool.end(); } catch (_) {} process.exit(2); });

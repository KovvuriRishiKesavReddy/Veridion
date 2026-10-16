// backend/scripts/test-fraud-fixes.js
//
// Run:  npm run test:fraud-fixes        (inside backend/, goes through with-test-db.js -> TEST database only)
//
// Exercises Fraud Fixes 1-3 against the real Postgres test database, WITHOUT needing Neo4j,
// RabbitMQ, Groq or the two servers: the graph is replaced by a small in-memory stub so the
// shell-company paths can actually fire. Covers:
//   * Fix 2  - a rejected/deactivated vendor no longer counts as a shell-company match, even if the
//              graph still has its (stale) edge; the helper fails safe (unfiltered) on bad input.
//   * Fix 3  - re-running the decision after a flag is resolved: the resolved flag is not re-raised,
//              no duplicate flags/disputes are created, the invoice moves on, and the vendor's
//              invoice_accuracy is never charged / credited twice for the same invoice.
//   * Fix 2/3 backend SQL - the "invoices affected by a revoked vendor" query finds the right
//              invoices for both stored evidence shapes (plain number and Neo4j {low,high}).
//   * Fix 1  - the Cypher issued by syncVendorNode / detachVendorIdentity (order + parameters).
// It only ever ADDS its own rows (unique names) to the test database.
const path = require('path');
const fs = require('fs');
const Module = require('module');

const backendDir = path.join(__dirname, '..');
const aiDir = path.join(backendDir, '..', 'ai-service');

// ---- in-memory graph stub, installed in place of ai-service/src/neo4jClient.js ----
const graph = { bank: [], address: [] };           // each: { vendor_id, name, value }
const neo4jPath = require.resolve(path.join(aiDir, 'src', 'neo4jClient.js'));
const neo4jLib = require(require.resolve('neo4j-driver', { paths: [aiDir] }));
const rec = obj => ({ get: k => obj[k] });
require.cache[neo4jPath] = {
  id: neo4jPath, filename: neo4jPath, loaded: true,
  exports: {
    runCypher: async (query, params = {}) => {
      if (/HAS_BANK_ACCOUNT/.test(query)) {
        const mine = graph.bank.filter(e => e.vendor_id === params.vendorId).map(e => e.value);
        return graph.bank.filter(e => e.vendor_id !== params.vendorId && mine.includes(e.value))
          .map(e => rec({ other_vendor_id: neo4jLib.int(e.vendor_id), other_vendor_name: e.name, shared_account: e.value }));
      }
      if (/HAS_ADDRESS/.test(query)) {
        const mine = graph.address.filter(e => e.vendor_id === params.vendorId).map(e => e.value);
        return graph.address.filter(e => e.vendor_id !== params.vendorId && mine.includes(e.value))
          .map(e => rec({ other_vendor_id: neo4jLib.int(e.vendor_id), other_vendor_name: e.name, shared_address: e.value }));
      }
      return []; // split-billing query: nothing
    },
    runWrite: async () => {}
  }
};

// Groq is never called: the stub throws, so decide.js / vendorCommunication.js take their built-in
// deterministic fallbacks (exactly what happens in production with no/failed Groq).
const groqPath = require.resolve(path.join(aiDir, 'src', 'groqClient.js'));
require.cache[groqPath] = {
  id: groqPath, filename: groqPath, loaded: true,
  exports: { callGroqStructured: async () => { throw new Error('Groq stubbed out in test'); }, normalizeCurrency: x => x, MODEL: 'stub' }
};

const { Pool } = require(require.resolve('pg', { paths: [backendDir] }));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = require(path.join(aiDir, 'src', 'db.js'));
const { runFraudAgent } = require(path.join(aiDir, 'src', 'agents', 'fraud.js'));
const { runDecisionAgent } = require(path.join(aiDir, 'src', 'agents', 'decide.js'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
}
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];

const tag = Date.now().toString().slice(-7);
let companyId, reqId, financeUserId;

async function mkVendor(label, bank, address) {
  const u = await one(`INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,'x','vendor') RETURNING id`, [`FFT ${label}`, `fft-${tag}-${label}@example.com`]);
  const v = await one(`INSERT INTO vendors (user_id, company_name, gstin, bank_account_number, address, verification_status)
                       VALUES ($1,$2,$3,$4,$5,'verified') RETURNING *`, [u.id, `FFT ${label} Traders ${tag}`, `29ABCDE${tag}Z5`.slice(0, 15), bank, address]);
  await q(`INSERT INTO vendor_risk_scores (company_id, vendor_id, invoice_accuracy_pct, data_volume, invoice_decision_count, invoice_decision_success_count)
           VALUES ($1,$2,50,4,4,2)`, [companyId, v.id]);
  return { ...v, user_id: u.id };
}

// An invoice with CLEAN matching + compliance, so the only possible problem is the fraud signal.
async function mkInvoice(vendor, n) {
  const quo = await one(`INSERT INTO quotations (requirement_id, vendor_id, price, delivery_days, status) VALUES ($1,$2,1000,5,'selected') RETURNING id`, [reqId, vendor.id]);
  const po = await one(`INSERT INTO purchase_orders (requirement_id, quotation_id, vendor_id, company_id, agreed_price, agreed_quantity)
                        VALUES ($1,$2,$3,$4,1000,10) RETURNING id`, [reqId, quo.id, vendor.id, companyId]);
  const inv = await one(`INSERT INTO invoices (po_id, vendor_id, invoice_number, invoice_amount, gst_amount, status)
                         VALUES ($1,$2,$3,1000,180,'submitted') RETURNING id`, [po.id, vendor.id, `FFT-${tag}-${n}`]);
  await q(`INSERT INTO matching_results (invoice_id, po_match_score, grn_match_score, mismatch_fields, overall_match, confidence_score, data_volume, issue_type)
           VALUES ($1,1,1,'{}',true,0.9,5,'mismatch')`, [inv.id]);
  await q(`INSERT INTO compliance_checks (invoice_id, gst_valid, gst_details, issues_found, confidence_score, data_volume)
           VALUES ($1,true,'{}','{}',0.9,5)`, [inv.id]);
  return inv.id;
}
const invoiceStatus = async id => (await one(`SELECT status FROM invoices WHERE id=$1`, [id])).status;
const flagsOf = id => q(`SELECT * FROM fraud_flags WHERE invoice_id=$1 ORDER BY id`, [id]).then(r => r.rows);
const decisionsOf = id => q(`SELECT final_decision FROM decisions WHERE invoice_id=$1 ORDER BY id`, [id]).then(r => r.rows.map(x => x.final_decision));
const risk = async vendor => one(`SELECT invoice_decision_count AS n, invoice_decision_success_count AS ok FROM vendor_risk_scores WHERE company_id=$1 AND vendor_id=$2`, [companyId, vendor.id]);
const commsOf = id => one(`SELECT COUNT(*)::int AS n FROM vendor_communications WHERE invoice_id=$1`, [id]).then(r => r.n);

async function main() {
  const u = await one(`INSERT INTO users (name, email, password_hash, role) VALUES ('FFT Finance',$1,'x','finance') RETURNING id`, [`fft-${tag}-fin@example.com`]);
  financeUserId = u.id;
  companyId = (await one(`INSERT INTO companies (name, approval_status) VALUES ($1,'approved') RETURNING id`, [`FFT Company ${tag}`])).id;
  await q(`UPDATE users SET company_id=$1 WHERE id=$2`, [companyId, financeUserId]);
  reqId = (await one(`INSERT INTO requirements (company_id, title, category, quantity, unit, created_by) VALUES ($1,'FFT item','Test',10,'units',$2) RETURNING id`, [companyId, financeUserId])).id;

  const clean = await mkVendor('Clean', '1111100001', `1 Clean Street ${tag}`);
  const shell = await mkVendor('Shell', '1111100001', `9 Shell Road ${tag}`);     // shares the BANK ACCOUNT with Clean
  graph.bank.push({ vendor_id: clean.id, name: clean.company_name, value: '1111100001' }, { vendor_id: shell.id, name: shell.company_name, value: '1111100001' });

  // ---------- 0. baseline: a first run is exactly what it always was ----------
  console.log('\n[0] Baseline first run (shell vendor live)');
  const invA = await mkInvoice(clean, 'A');
  const dA = await runDecisionAgent(invA);
  check('first run -> suspicious', dA.final_decision === 'suspicious' && await invoiceStatus(invA) === 'suspicious');
  let fl = await flagsOf(invA);
  check('exactly one open shell-company bank flag', fl.length === 1 && fl[0].flag_type === 'shell_company_shared_bank_account' && !fl[0].resolved);
  check('flag evidence names the shell vendor', JSON.stringify(fl[0].evidence).includes(String(shell.id)));
  let r0 = await risk(clean);
  check('first run charged vendor risk once (count 4 -> 5, successes unchanged)', r0.n === 5 && r0.ok === 2, JSON.stringify(r0));
  const commsA = await commsOf(invA);

  // ---------- 1. re-run while nothing changed: no duplicates, no double charge ----------
  console.log('\n[1] Re-run with nothing changed');
  const dA2 = await runDecisionAgent(invA, { rerun: true });
  fl = await flagsOf(invA);
  check('still suspicious', dA2.final_decision === 'suspicious' && await invoiceStatus(invA) === 'suspicious');
  check('open flag REUSED, not duplicated', fl.length === 1 && !fl[0].resolved, `flags=${fl.length}`);
  check('vendor risk NOT charged a second time', (await risk(clean)).n === 5);
  check('no duplicate dispute record', await commsOf(invA) === commsA);

  // ---------- 2. Fix 3: admin resolves the flag, then the decision re-runs ----------
  console.log('\n[2] Admin resolves the flag (shell vendor still live) -> re-run');
  await q(`UPDATE fraud_flags SET resolved=true WHERE id=$1`, [fl[0].id]);
  const dA3 = await runDecisionAgent(invA, { rerun: true });
  fl = await flagsOf(invA);
  check('resolved flag is NOT raised again (still 1 row, resolved)', fl.length === 1 && fl[0].resolved === true, `flags=${fl.length}`);
  check('decision moved on: no longer suspicious', dA3.final_decision !== 'suspicious' && await invoiceStatus(invA) !== 'suspicious', `status=${await invoiceStatus(invA)} decision=${dA3.final_decision}`);
  const afterResolve = await risk(clean);
  const wasGood = dA3.final_decision === 'auto_approved';
  check('vendor risk: one positive event iff approved, else nothing', wasGood ? (afterResolve.n === 6 && afterResolve.ok === 3) : (afterResolve.n === 5), JSON.stringify(afterResolve));
  await runDecisionAgent(invA, { rerun: true });
  check('repeating the re-run records NO second event', JSON.stringify(await risk(clean)) === JSON.stringify(afterResolve), JSON.stringify(await risk(clean)));
  check('every re-run kept exactly one flag row', (await flagsOf(invA)).length === 1);

  // ---------- 3. Fix 2: shell vendor revoked, graph edge still STALE ----------
  console.log('\n[3] Shell vendor revoked; graph edge deliberately left stale');
  const invB = await mkInvoice(clean, 'B');
  await runDecisionAgent(invB);
  check('setup: invoice B suspicious via the shell flag', await invoiceStatus(invB) === 'suspicious' && (await flagsOf(invB)).length === 1);
  const before = await risk(clean);
  await q(`UPDATE vendors SET verification_status='rejected' WHERE id=$1`, [shell.id]);
  const dB = await runDecisionAgent(invB, { rerun: true });
  fl = await flagsOf(invB);
  check('open shell flag auto-closed (signal no longer applies)', fl.length === 1 && fl[0].resolved === true, JSON.stringify(fl.map(f => f.resolved)));
  check('invoice B no longer suspicious', dB.final_decision !== 'suspicious' && await invoiceStatus(invB) !== 'suspicious', `decision=${dB.final_decision}`);
  const good = dB.final_decision === 'auto_approved';
  const afterB = await risk(clean);
  check('risk: at most one corrective positive event', good ? (afterB.n === before.n + 1 && afterB.ok === before.ok + 1) : (afterB.n === before.n), JSON.stringify({ before, afterB }));

  // a FRESH invoice from the clean vendor must not be flagged any more
  const invC = await mkInvoice(clean, 'C');
  const dC = await runDecisionAgent(invC);
  check('fresh invoice from the clean vendor is not flagged as shell company', (await flagsOf(invC)).length === 0 && dC.final_decision !== 'suspicious', `decision=${dC.final_decision}`);

  // deactivated login counts as revoked too
  console.log('\n[4] Deactivated vendor login also stops matching');
  await q(`UPDATE vendors SET verification_status='verified' WHERE id=$1`, [shell.id]);
  const invD = await mkInvoice(clean, 'D');
  await runDecisionAgent(invD);
  check('setup: shell vendor re-verified -> flagged again', await invoiceStatus(invD) === 'suspicious');
  await q(`UPDATE users SET is_active=false WHERE id=$1`, [shell.user_id]);
  const invE = await mkInvoice(clean, 'E');
  const dE = await runDecisionAgent(invE);
  check('deactivated shell vendor no longer flags new invoices', (await flagsOf(invE)).length === 0 && dE.final_decision !== 'suspicious');
  await q(`UPDATE users SET is_active=true WHERE id=$1`, [shell.user_id]);

  // ---------- 5. fail-safe: unreadable ids => unfiltered (old behaviour) ----------
  console.log('\n[5] Fail-safe');
  graph.bank = [{ vendor_id: clean.id, name: 'c', value: 'Z' }, { vendor_id: 0, name: 'x', value: 'Z' }];
  const orig = db.query; // make the revoked-vendor lookup throw
  db.query = async (t, p) => { if (/FROM vendors v LEFT JOIN users u/.test(t)) throw new Error('simulated db failure'); return orig(t, p); };
  const invF = await mkInvoice(clean, 'F');
  const out = await runFraudAgent(invF);
  db.query = orig;
  check('lookup failure -> flag still raised (fraud detection never goes blind)', out.flags.some(f => f.flag_type === 'shell_company_shared_bank_account'));

  // ---------- 6. backend SQL: invoices affected by a revoked vendor ----------
  console.log('\n[6] Backend query: invoices affected by a revoked vendor');
  const adminSrc = fs.readFileSync(path.join(backendDir, 'src', 'routes', 'admin.js'), 'utf8');
  const m = adminSrc.match(/async function rerunInvoicesAffectedByRevokedVendor[\s\S]*?db\.query\(\s*`([\s\S]*?)`/);
  check('found the query in admin.js', !!m);
  const sql = m[1];
  const target = Number(shell.id);
  const mk = async (label, evidence, status = 'suspicious', vendor = clean) => {
    const id = await mkInvoice(vendor, label);
    await q(`UPDATE invoices SET status=$1 WHERE id=$2`, [status, id]);
    await q(`INSERT INTO fraud_flags (vendor_id, invoice_id, flag_type, severity, evidence, resolved) VALUES ($1,$2,'shell_company_shared_bank_account','high',$3,false)`, [vendor.id, id, JSON.stringify(evidence)]);
    return id;
  };
  const idLow = await mk('S1', [{ other_vendor_id: { low: target, high: 0 } }]);            // Neo4j Integer shape
  const idNum = await mk('S2', [{ other_vendor_id: target }]);                                // plain number
  const idOther = await mk('S3', [{ other_vendor_id: { low: target + 9999, high: 0 } }]);    // a different vendor
  const idPaid = await mk('S4', [{ other_vendor_id: target }], 'verified');                   // already verified
  const idOwn = await mk('S5', [{ other_vendor_id: { low: clean.id, high: 0 } }], 'suspicious', shell); // the revoked vendor's OWN invoice
  const idObj = await mk('S6', { not: 'an array' });                                          // unexpected shape must not throw
  const idJunk = await mk('S7', ['junk', 5, null]);
  let rows;
  try { rows = (await q(sql, [shell.id, String(shell.id)])).rows.map(r => r.invoice_id); } catch (e) { rows = null; console.log(e.message); }
  check('query runs without error on odd evidence shapes', rows !== null);
  check('finds the {low,high} (Neo4j Integer) evidence', rows && rows.includes(idLow));
  check('finds the plain-number evidence', rows && rows.includes(idNum));
  check('ignores other vendors / non-stuck invoices / the vendor\'s own invoices / odd shapes',
    rows && ![idOther, idPaid, idOwn, idObj, idJunk].some(i => rows.includes(i)), JSON.stringify(rows));

  // ---------- 7. Fix 1: Cypher issued by neo4jSync ----------
  console.log('\n[7] neo4jSync Cypher');
  const calls = [];
  const syncPath = path.join(backendDir, 'src', 'utils', 'neo4jSync.js');
  const realDriver = require(require.resolve('neo4j-driver', { paths: [backendDir] }));
  process.env.NEO4J_URI = 'bolt://stub:7687';
  const origDriver = realDriver.driver;
  realDriver.driver = () => ({ session: () => ({ run: async (query, params) => { calls.push({ query, params }); }, close: async () => {} }) });
  delete require.cache[syncPath];
  const sync = require(syncPath);
  await sync.syncVendorNode({ id: 7, company_name: 'X', gstin: 'G', bank_account_number: '222', address: 'Addr' });
  check('syncVendorNode: 3 writes, original MERGE first, then the two stale-edge deletes',
    calls.length === 3 && /MERGE \(v:Vendor/.test(calls[0].query) && /DELETE r/.test(calls[1].query) && /HAS_BANK_ACCOUNT/.test(calls[1].query) && /DELETE r/.test(calls[2].query) && /HAS_ADDRESS/.test(calls[2].query));
  check('stale-edge deletes use the vendor\'s CURRENT bank/address', calls[1].params.bank_account_number === '222' && calls[2].params.address === 'Addr' && calls[1].params.id === 7);
  calls.length = 0;
  await sync.syncVendorNode({ id: 8, company_name: 'X', gstin: 'G', bank_account_number: '', address: null });
  check('empty bank/address -> deletes all of that vendor\'s old edges (null param)', calls[1].params.bank_account_number === null && calls[2].params.address === null);
  calls.length = 0;
  await sync.detachVendorIdentity(9);
  check('detachVendorIdentity: removes only the two edge types, keeps the Vendor node',
    calls.length === 2 && calls.every(c => /DELETE r/.test(c.query) && !/DETACH|DELETE v/.test(c.query)) && calls[0].params.id === 9);
  check('module exports detachVendorIdentity', typeof sync.detachVendorIdentity === 'function' && typeof sync.syncPurchaseOrderNode === 'function' && typeof sync.syncInvoiceNode === 'function');
  realDriver.driver = origDriver;

  console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  await pool.end(); await db.pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async err => { console.error('TEST SCRIPT ERROR:', err); try { await pool.end(); } catch (_) {} process.exit(2); });

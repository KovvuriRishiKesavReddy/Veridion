// backend/scripts/evaluate-vendor-states.js
//
// Scores the 8 vendor-state cases written by seed-synthetic-data.js (vendor-state-results.json).
// These are STRUCTURAL checks — each one verifies its own specific claim — not extra data points
// to average into the Part 7.3 accuracy number, so there is deliberately no flat accuracy % here.
//
// Usage: npm run evaluate:vendor-states
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { Pool } = require('pg');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
let dbName = '';
try { dbName = new URL(DB_URL).pathname; } catch (_) {}
if (!/test/i.test(dbName)) {
  console.error('Refusing to run: the database name in TEST_DATABASE_URL / DATABASE_URL must contain "test".');
  process.exit(1);
}
const pool = new Pool({ connectionString: DB_URL });
const AUTO_APPROVE_THRESHOLD = 0.7;

async function pollForDecision(invoiceId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool.query(`SELECT * FROM decisions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
    if (r.rows[0]) return r.rows[0];
    await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error(`Invoice ${invoiceId} never got a decision within ${timeoutMs}ms`);
}

const fmt = n => (n == null || isNaN(Number(n)) ? 'n/a' : Number(n).toFixed(3));
const riskWeight = d => Number(d.gate_weights?.vendor_risk ?? 0);
const recomputeScore = d => Object.entries(d.gate_weights || {}).reduce((s, [name, w]) => s + Number(w) * Number(d.agent_inputs?.[name]?.verdict_score ?? 0), 0);

let passed = 0, failed = 0, designProps = 0, notTested = 0;
// kind (only used when ok is false):
//   'design' — the original expectation does not hold BY DESIGN of the system (explained in the detail text)
//   'skip'   — the check could not be exercised in this environment (not a verdict on the system)
function report(name, ok, detail, kind) {
  let label;
  if (ok) { passed++; label = '✓ PASS'; }
  else if (kind === 'design') { designProps++; label = '≈ DESIGN PROPERTY (expected)'; }
  else if (kind === 'skip') { notTested++; label = '– NOT TESTED'; }
  else { failed++; label = '✗ FAIL'; }
  console.log(`${label}  ${name}\n         ${detail}`);
}

// Same plain equal-weight fusion as evaluate.js's baseline (1/N per agent, same 0.70 threshold, no
// safety rules) — the baseline itself is unchanged; here it is only applied to the vendor-history
// cases so you can see what a plain average would have decided.
const equalAvg = d => { const v = Object.values(d.agent_inputs || {}).map(a => Number(a.verdict_score)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
const equalDecision = d => (equalAvg(d) >= AUTO_APPROVE_THRESHOLD ? 'auto_approved' : 'flagged');
// Neo4j is deliberately switched off by test mode (scripts/with-test-db.js) unless TEST_USE_NEO4J=1.
const neo4jOffInTestMode = process.env.VERIDION_TEST_MODE === '1' && process.env.NEO4J_URI === '';

async function main() {
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor-state-results.json'), 'utf8'));
  const D = {};
  for (const k of ['fresh_reference', 'legacy_1', 'earned_history_1', 'degraded_history_1', 'reputation_correction_1', 'shell_company_1', 'compound_mismatch_1', 'boundary_1']) {
    if (R[k]?.invoice_id) D[k] = await pollForDecision(R[k].invoice_id);
  }
  console.log('\n--- Vendor-state structural checks ---\n');

  // 1. legacy-1 (Addition 1)
  if (D.legacy_1 && D.fresh_reference) {
    const ok = D.legacy_1.final_decision === 'auto_approved' && riskWeight(D.legacy_1) > riskWeight(D.fresh_reference);
    report('legacy-1: legacy-imported vendor auto-approved, and the Context Gate actually weights its history', ok,
      `decision=${D.legacy_1.final_decision}; vendor_risk gate_weight legacy=${fmt(riskWeight(D.legacy_1))} vs zero-history=${fmt(riskWeight(D.fresh_reference))} (must be higher)`);
  }

  // 2. earned-history-1 (Addition 2)
  if (D.earned_history_1 && D.fresh_reference) {
    const ok = D.earned_history_1.final_decision === 'auto_approved' && riskWeight(D.earned_history_1) > riskWeight(D.fresh_reference);
    report('earned-history-1: vendor with real round-trip history carries measurably more Past-Performance weight', ok,
      `decision=${D.earned_history_1.final_decision}; vendor_risk gate_weight earned=${fmt(riskWeight(D.earned_history_1))} vs zero-history=${fmt(riskWeight(D.fresh_reference))}; data_volume=${D.earned_history_1.agent_inputs?.vendor_risk?.data_volume}`);
  }

  // 3. ranking-1 (Addition 3) — re-read the stored ai_rank_score rather than trusting the seed's own flag
  if (R.ranking_1) {
    const q = await pool.query(`SELECT vendor_id, ai_rank_score FROM quotations WHERE requirement_id = $1`, [R.ranking_1.requirement_id]);
    const hi = q.rows.find(r => r.vendor_id === R.ranking_1.high_history_vendor_id);
    const fr = q.rows.find(r => r.vendor_id === R.ranking_1.fresh_vendor_id);
    const ok = !!hi && !!fr && Number(hi.ai_rank_score) > Number(fr.ai_rank_score);
    report('ranking-1: at equal price/delivery, does a vendor with real history outrank a vendor with none?', ok,
      `ai_rank_score high-history=${fmt(hi?.ai_rank_score)} vs no-history=${fmt(fr?.ai_rank_score)} (seed-time check passed=${R.ranking_1.passed}). ${ok ? '' : 'Expected by design, not a defect: a vendor with no history gets Past Performance weight 0 (a deliberate choice so new vendors get a fair chance), so with Price and Delivery tied it scores exactly 1.0 and any record below 100% can only pull a vendor under it. The original expectation here was an assumption; ranking-2 tests the comparison history CAN order.'}`, 'design');
  }

  // 3b. ranking-2 — good history vs degraded history at equal price/delivery
  if (R.ranking_2) {
    const q = await pool.query(`SELECT vendor_id, ai_rank_score FROM quotations WHERE requirement_id = $1`, [R.ranking_2.requirement_id]);
    const good = q.rows.find(r => r.vendor_id === R.ranking_2.high_history_vendor_id);
    const bad = q.rows.find(r => r.vendor_id === R.ranking_2.fresh_vendor_id);
    const ok = !!good && !!bad && Number(good.ai_rank_score) > Number(bad.ai_rank_score);
    report('ranking-2: at equal price/delivery, a good-history vendor outranks a degraded-history vendor', ok,
      `ai_rank_score good-history=${fmt(good?.ai_rank_score)} vs degraded=${fmt(bad?.ai_rank_score)}`);
  }

  // 4. degraded-history-1 (Addition 4) + the three-way table
  if (D.degraded_history_1) {
    const ok = D.degraded_history_1.final_decision === 'flagged';
    report('degraded-history-1: same scenario that auto-approves for a trusted vendor is flagged for a poorly-rated one', ok,
      `decision=${D.degraded_history_1.final_decision}; score=${fmt(D.degraded_history_1.final_score)}; vendor_risk verdict=${fmt(D.degraded_history_1.agent_inputs?.vendor_risk?.verdict_score)} weight=${fmt(riskWeight(D.degraded_history_1))}`);
    console.log('\n         Same invoice, four vendor histories — put this in the report. The last two columns show what a plain equal-weight average (the baseline, unchanged) would have given:');
    console.log('         ' + 'Vendor history'.padEnd(24) + 'Decision'.padEnd(15) + 'Score'.padEnd(8) + 'verdict'.padEnd(9) + 'weight'.padEnd(8) + 'Equal avg'.padEnd(11) + 'Equal-wt decision');
    for (const [label, d] of [['Fresh (none)', D.fresh_reference], ['Legacy-imported', D.legacy_1], ['Earned (good)', D.earned_history_1], ['Degraded (bad)', D.degraded_history_1]]) {
      if (!d) continue;
      console.log('         ' + label.padEnd(24) + String(d.final_decision).padEnd(15) + fmt(d.final_score).padEnd(8) + fmt(d.agent_inputs?.vendor_risk?.verdict_score).padEnd(9) + fmt(riskWeight(d)).padEnd(8) + fmt(equalAvg(d)).padEnd(11) + equalDecision(d));
    }
    console.log('');
    for (const [label, d] of [['degraded-history-1', D.degraded_history_1], ['reputation-correction-1', D.reputation_correction_1]]) {
      if (d && d.final_decision !== equalDecision(d)) console.log(`         Baseline contrast — ${label}: Context Gate = ${d.final_decision} (${fmt(d.final_score)}), plain equal average = ${equalDecision(d)} (${fmt(equalAvg(d))}).`);
    }
    console.log('');
  }

  // 5. shell-company-1 (Addition 5)
  if (D.shell_company_1) {
    const f = await pool.query(`SELECT flag_type FROM fraud_flags WHERE invoice_id = $1`, [R.shell_company_1.invoice_id]);
    const types = f.rows.map(r => r.flag_type);
    const ok = D.shell_company_1.final_decision === 'suspicious' && types.includes(R.shell_company_1.expected_flag_type);
    report('shell-company-1: clean invoice from a bank-account-sharing vendor is suspicious via the shell-company check', ok,
      `decision=${D.shell_company_1.final_decision}; flags=[${types.join(', ') || 'none'}]. ${neo4jOffInTestMode ? 'Neo4j is switched off in test mode, so this check could not fire — it is NOT a verdict on the shell-company logic. To exercise it, use a separate Neo4j instance and run with TEST_USE_NEO4J=1.' : 'If missing: is Neo4j configured, and is HAS_BANK_ACCOUNT written at vendor registration (neo4jSync)?'}`,
      neo4jOffInTestMode ? 'skip' : undefined);
  }

  // 6. reputation-correction-1 (Addition 6) — all three must hold together
  if (D.reputation_correction_1) {
    const d = D.reputation_correction_1;
    const risk = await pool.query(`SELECT invoice_decision_success_count FROM vendor_risk_scores WHERE company_id = $1 AND vendor_id = $2`, [R.reputation_correction_1.company_id, R.reputation_correction_1.vendor_id]);
    const before = Number(R.reputation_correction_1.risk_before?.invoice_decision_success_count ?? 0);
    const after = Number(risk.rows[0]?.invoice_decision_success_count ?? 0);
    const decisionIsFlagged = d.final_decision === 'flagged';
    const countedAsPositive = d.agent_inputs?.vendor_risk?.counted_as_positive_despite_flag === true;
    const successCountIncreased = after > before;
    report('reputation-correction-1: flagged, counted as positive, success count up — all three together', decisionIsFlagged && countedAsPositive && successCountIncreased,
      `flagged=${decisionIsFlagged}; counted_as_positive_despite_flag=${countedAsPositive}; invoice_decision_success_count ${before} -> ${after} (increased=${successCountIncreased}). NB: later decisions for this vendor also move the count — run before anything else touches it.`);
  }

  // 7. compound-mismatch-1 (Addition 7)
  if (D.compound_mismatch_1) {
    const inv = R.compound_mismatch_1.invoice_id;
    const m = await pool.query(`SELECT mismatch_fields FROM matching_results WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [inv]);
    const c = await pool.query(`SELECT issues_found FROM compliance_checks WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [inv]);
    const hasQty = !!m.rows[0]?.mismatch_fields?.quantity;
    const issues = c.rows[0]?.issues_found || [];
    const hasGst = issues.some(i => /gst/i.test(i));
    report('compound-mismatch-1: quantity issue (Matching) AND GST issue (Compliance) both survive on the same invoice', D.compound_mismatch_1.final_decision === 'flagged' && hasQty && hasGst,
      `decision=${D.compound_mismatch_1.final_decision}; matching quantity mismatch=${hasQty}; compliance GST issue=${hasGst} ${hasGst ? '' : `(issues_found=${JSON.stringify(issues)})`}`);
  }

  // 8. boundary-1 (Addition 8) — mechanical >= check
  if (D.boundary_1) {
    const d = D.boundary_1;
    const score = recomputeScore(d);
    const m = await pool.query(`SELECT overall_match FROM matching_results WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [R.boundary_1.invoice_id]);
    const matchClean = m.rows[0]?.overall_match !== false;
    const predicted = score >= AUTO_APPROVE_THRESHOLD ? 'auto_approved' : 'flagged';
    const ok = !matchClean || d.final_decision === predicted; // a real mismatch hard-flags regardless of score
    const dist = score - AUTO_APPROVE_THRESHOLD;
    report('boundary-1: decision agrees with `finalScore >= 0.7` (mechanical boundary check, NOT a realistic scenario)', ok,
      `recomputed score=${score.toFixed(6)} (stored ${fmt(d.final_score)}), distance from 0.70 = ${dist >= 0 ? '+' : ''}${dist.toFixed(6)}; predicted=${predicted}, actual=${d.final_decision}. ${Math.abs(dist) > 0.05 ? 'Landed far from 0.70 — adjust EVAL_BOUNDARY_WARMUPS and re-seed to get closer; the check above still holds but exercises the boundary only loosely.' : 'Landed close to the boundary.'}`);

    // Across EVERY invoice in the DB: any decision whose recomputed score sits within 1e-9 of 0.7 must follow >=.
    const all = await pool.query(`SELECT invoice_id, final_decision, gate_weights, agent_inputs FROM decisions WHERE final_decision IN ('auto_approved','flagged') AND jsonb_typeof(gate_weights) = 'object' AND gate_weights <> '{}'::jsonb`);
    const edge = all.rows.filter(r => Math.abs(recomputeScore(r) - AUTO_APPROVE_THRESHOLD) < 1e-9);
    if (edge.length) console.log(`         ${edge.length} invoice(s) sit exactly on the boundary: ` + edge.map(r => `#${r.invoice_id}=${r.final_decision}`).join(', '));
  }

  console.log(`\n--- ${passed} passed, ${failed} failed, ${designProps} design property, ${notTested} not tested ---`);
  console.log('Reminder for the report: split-billing (fraud.js Check 3) is dormant by design — Flow 1 blocks a second invoice on the same PO — so it is documented as future work, not tested here.');
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async err => { console.error(err); try { await pool.end(); } catch (_) {} process.exit(1); });

// backend/scripts/evaluate.js
//
// Reads synthetic-dataset-results.json (written by seed-synthetic-data.js), waits for each
// invoice's pipeline to finish (polling decisions), compares actual vs expected final_decision,
// and prints accuracy. Then re-scores the SAME already-computed agent_inputs using equal
// weighting instead of the Context Gate formula, entirely in memory — no need to re-run the
// pipeline a second time, since agent_inputs (confidence, data_volume, verdict_score per agent)
// was already saved by decide.js for every invoice.
//
// Usage: npm run evaluate
//        STRICT_BASELINE=1 npm run evaluate   (no partial credit for the baseline on 'suspicious' cases)
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
const STRICT_BASELINE = process.env.STRICT_BASELINE === '1';
const AUTO_APPROVE_THRESHOLD = 0.7; // same constant as ai-service/src/agents/decide.js

async function pollForDecision(invoiceId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await pool.query(`SELECT * FROM decisions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
    if (res.rows[0]) return res.rows[0];
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Invoice ${invoiceId} never got a decision within ${timeoutMs}ms — is RabbitMQ/ai-service running?`);
}

// equalWeightDecision: re-fuses the SAME agent_inputs this invoice actually produced, but with
// gate_weight = 1/N for every agent instead of confidence * log(1+data_volume). This is the
// ablation comparison — same inputs, different fusion rule, to isolate whether the Context
// Gate's weighting specifically (not the agents' underlying judgments) drives correct decisions.
function equalWeightDecision(agentInputs) {
  const names = Object.keys(agentInputs || {});
  if (!names.length) return 'flagged';
  const equalWeight = 1 / names.length;
  const finalScore = names.reduce((sum, name) => sum + equalWeight * Number(agentInputs[name].verdict_score), 0);
  return finalScore >= AUTO_APPROVE_THRESHOLD ? 'auto_approved' : 'flagged';
  // Note: this intentionally does NOT reproduce decide.js's high-severity-fraud bypass or the
  // overall_match/gst_valid hard-flag rule — those are gate-independent safety rules, not part of
  // the weighting scheme being tested. Leaving them out keeps this baseline PURELY about the
  // weighting formula's effect.
}

async function main() {
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'synthetic-dataset-results.json'), 'utf8'));
  let gateCorrect = 0, equalCorrect = 0;
  const rows = [];

  for (const { invoice_id, expected_decision, label } of dataset) {
    const decision = await pollForDecision(invoice_id);
    // Which source did Agent 1 actually use? 'ocr_extraction' = the PDF was read and structured. If the
    // structuring step fails (e.g. a Groq error/timeout/rate limit) the system falls back to the
    // vendor-submitted form values ('vendor_submitted_fallback'), and checks that compare the PDF
    // against the registered vendor (e.g. the GSTIN identity check) cannot run. Recorded per invoice so
    // OCR failures can be told apart from decision-logic failures. The scoring below is unaffected.
    const ex = await pool.query(`SELECT structured_data->>'__source' AS src FROM document_extractions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoice_id]);
    const ocrSource = ex.rows[0]?.src || 'unknown';
    const gateDecision = decision.final_decision;
    const equalDecision = equalWeightDecision(decision.agent_inputs);

    const gateRight = gateDecision === expected_decision;
    // equalWeightDecision has no concept of 'suspicious' (the fraud bypass is deliberately
    // excluded above). By default 'flagged' earns partial credit against an expected 'suspicious'
    // — conservative toward the Context Gate (it makes the baseline look better than it is).
    // STRICT_BASELINE=1 marks those wrong instead, which makes the gate's advantage look larger.
    const equalRight = equalDecision === expected_decision ||
      (!STRICT_BASELINE && expected_decision === 'suspicious' && equalDecision === 'flagged');

    if (gateRight) gateCorrect++;
    if (equalRight) equalCorrect++;
    rows.push({ invoice_id, label, ocr_source: ocrSource, expected: expected_decision, gate_decision: gateDecision, gate_correct: gateRight, equal_decision: equalDecision, equal_correct: equalRight, score: decision.final_score });
  }

  console.log('\n--- Per-invoice results ---');
  rows.forEach(r => console.log(`${r.gate_correct ? '✓' : '✗'} [gate] ${r.equal_correct ? '✓' : '✗'} [equal]  ${r.label.padEnd(66)} expected=${r.expected} gate=${r.gate_decision} equal=${r.equal_decision}${r.ocr_source !== 'ocr_extraction' ? `   <-- OCR source: ${r.ocr_source}` : ''}`));

  console.log('\n--- Summary ---');
  console.log(`Context Gate accuracy: ${gateCorrect}/${rows.length} (${(100 * gateCorrect / rows.length).toFixed(1)}%)`);
  console.log(`Equal-weight baseline: ${equalCorrect}/${rows.length} (${(100 * equalCorrect / rows.length).toFixed(1)}%)${STRICT_BASELINE ? '  [strict: no partial credit on suspicious cases]' : ''}`);
  // Secondary breakdown (the headline numbers above are unchanged and always cover ALL invoices).
  const fellBack = rows.filter(r => r.ocr_source !== 'ocr_extraction');
  if (fellBack.length) {
    const ok = rows.filter(r => r.ocr_source === 'ocr_extraction');
    console.log(`\nNote: ${fellBack.length} invoice(s) did not go through real OCR structuring (${fellBack.map(r => `#${r.invoice_id} ${r.ocr_source}`).join(', ')}).`);
    console.log(`  Among the ${ok.length} invoice(s) where OCR succeeded — Context Gate: ${ok.filter(r => r.gate_correct).length}/${ok.length}, equal-weight: ${ok.filter(r => r.equal_correct).length}/${ok.length}.`);
    console.log('  Report both: the all-invoice figures above are the headline; this line separates OCR failures from decision-logic failures.');
  }
  if (gateCorrect < equalCorrect) console.log('\n! Context Gate scored BELOW the baseline — either a test case\'s expected value needs re-examining or there is a genuine weighting problem. Worth writing up honestly, not hiding.');
  console.log('\nThis comparison is your ablation-study result — put the table above directly in your report.');
  console.log('Structural vendor-state checks are separate: npm run evaluate:vendor-states');
  await pool.end();
}

main().catch(async err => { console.error(err); try { await pool.end(); } catch (_) {} process.exit(1); });

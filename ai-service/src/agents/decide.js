const db = require('../db');
const { callGroqStructured } = require('../groqClient');
const { runFraudAgent } = require('./fraud');
const { onInvoiceDecisionFinalised } = require('./vendorRisk');

// runDecisionAgent: Agent 8 — the Context Gate / Decision Engine.
// Now reads all four suppliers (Matching, Compliance, Fraud, Vendor Risk) — this is
// the Flow 3 update per the build doc's own staging (Flow 2 only had Matching+Compliance).
//
// The formula is applied EXACTLY as specified:
//   raw_weight_i   = confidence_i * log(1 + data_volume_i)
//   gate_weight_i  = raw_weight_i / sum(raw_weight_all_agents)
//   final_score    = sum(gate_weight_i * agent_verdict_score_i)
const AUTO_APPROVE_THRESHOLD = 0.7;

async function runDecisionAgent(invoiceId) {
  const matchingRes = await db.query(`SELECT * FROM matching_results WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
  const complianceRes = await db.query(`SELECT * FROM compliance_checks WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
  const matching = matchingRes.rows[0];
  const compliance = complianceRes.rows[0];
  if (!matching || !compliance) throw new Error(`Missing matching or compliance result for invoice ${invoiceId} — run those agents first`);

  const invRes = await db.query(`SELECT inv.*, po.company_id FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id WHERE inv.id = $1`, [invoiceId]);
  const invoice = invRes.rows[0];

  // Agent 4 — Fraud Detection. Runs fresh every time (checks the graph as it stands now).
  const fraud = await runFraudAgent(invoiceId);

  // High-severity fraud skips the normal gate calculation entirely and routes straight
  // to a suspicious/rejected outcome for Platform Admin review — per Part 3.4/6.3, this
  // is the one case where a supplier's finding overrides the gate math rather than
  // just being weighted into it.
  if (fraud.has_high_severity) {
    // FIXED: this reasoning text previously only mentioned the fraud flags, never
    // explaining that Matching/Compliance still ran and produced their own results —
    // which created real, reported confusion: a user seeing "Semantic Matching:
    // Overall match Yes" right next to "System Decision: Suspicious" reasonably reads
    // that as a contradiction, or as Matching having failed to do its job. It didn't
    // fail — it's scoped to quantity, amount, and item-description consistency against
    // the PO/GRN/requirement, and none of those were actually wrong here. Vendor
    // identity (GSTIN, company name, bank account) is deliberately NOT part of
    // Matching's scope — that's what Fraud Detection just caught, and correctly
    // bypassed the gate for. Now stated explicitly rather than left for the reader to
    // infer from two disconnected-looking cards.
    const matchingRes = await db.query(`SELECT overall_match FROM matching_results WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
    const matchingWasClean = matchingRes.rows[0]?.overall_match !== false;
    const scopeNote = matchingWasClean
      ? ` Semantic Matching and Compliance both came back clean for this invoice — that is expected and not a contradiction: those two checks only verify quantity, amount, and item consistency against the PO/GRN/requirement, and none of those were actually wrong here. Vendor identity (GSTIN, company name, bank account) is checked separately, by Fraud Detection — which is exactly what caught this.`
      : ` Semantic Matching and/or Compliance also found separate issues on this invoice, shown below — those are independent of the fraud signal above.`;
    const reasoningText = `This invoice was marked SUSPICIOUS immediately — Fraud Detection found a high-severity signal (${fraud.flags.map(f => f.flag_type).join(', ')}) and this bypasses the normal weighted decision entirely. Routed to the Platform Admin fraud review queue.${scopeNote}`;
    const result = await db.query(
      `INSERT INTO decisions (invoice_id, agent_inputs, gate_weights, final_score, final_decision, reasoning_text)
       VALUES ($1,$2,$3,$4,'suspicious',$5) RETURNING *`,
      [invoiceId, JSON.stringify({ fraud }), JSON.stringify({}), 0, reasoningText]
    );
    await db.query(`UPDATE invoices SET status = 'suspicious' WHERE id = $1`, [invoiceId]);
    if (invoice) await onInvoiceDecisionFinalised(invoiceId, 'suspicious');
    return result.rows[0];
  }

  // Agent 5 — Vendor Risk. Reads the CURRENT stored score scoped to (company_id,
  // vendor_id) — this agent does not run any gate logic itself, it only supplies
  // score + data_volume for Agent 8 (and Agent 6, later) to weigh (Part 6.3/6.4).
  const riskRes = await db.query(
    `SELECT * FROM vendor_risk_scores WHERE company_id = $1 AND vendor_id = $2`,
    [invoice.company_id, invoice.vendor_id]
  );
  const risk = riskRes.rows[0];
  // No history yet (data_volume 0) is handled honestly, not faked: neutral verdict,
  // zero data_volume, so the gate naturally assigns it near-zero weight — cold start
  // by design (Part 5.7).
  const riskVerdictScore = risk?.invoice_accuracy_pct != null ? Number(risk.invoice_accuracy_pct) / 100 : 0.5;
  const riskDataVolume = risk?.data_volume || 0;
  const riskConfidence = riskDataVolume > 0 ? 0.8 : 0;

  // Convert each remaining agent's verdict into a 0-1 numeric score before applying the gate.
  const matchingVerdictScore = Number(matching.grn_match_score);
  const complianceVerdictScore = compliance.gst_valid && compliance.issues_found.length === 0 ? 1 : 0.3;

  const agents = [
    { name: 'matching', confidence: Number(matching.confidence_score), data_volume: Number(matching.data_volume), verdict_score: matchingVerdictScore },
    { name: 'compliance', confidence: Number(compliance.confidence_score), data_volume: Number(compliance.data_volume), verdict_score: complianceVerdictScore },
    { name: 'fraud', confidence: fraud.confidence_score, data_volume: fraud.data_volume, verdict_score: fraud.verdict_score },
    { name: 'vendor_risk', confidence: riskConfidence, data_volume: riskDataVolume, verdict_score: riskVerdictScore }
  ];

  const rawWeights = agents.map(a => a.confidence * Math.log(1 + a.data_volume));
  const totalRawWeight = rawWeights.reduce((sum, w) => sum + w, 0);
  const gateWeights = {};
  let finalScore = 0;

  agents.forEach((a, i) => {
    const gateWeight = totalRawWeight > 0 ? rawWeights[i] / totalRawWeight : 0;
    gateWeights[a.name] = gateWeight;
    finalScore += gateWeight * a.verdict_score;
  });

  let finalDecision = finalScore >= AUTO_APPROVE_THRESHOLD ? 'auto_approved' : 'flagged';
  // A genuine mismatch or invalid compliance always at least flags, regardless of score —
  // the gate weighs HOW MUCH to trust each signal, it never lets a high-confidence signal
  // silently override a real problem another agent found.
  if (!matching.overall_match || !compliance.gst_valid) {
    finalDecision = finalDecision === 'auto_approved' ? 'flagged' : finalDecision;
  }

  const agentInputs = agents.reduce((obj, a) => {
    obj[a.name] = { confidence: a.confidence, data_volume: a.data_volume, verdict_score: a.verdict_score };
    return obj;
  }, {});
  agentInputs.fraud.flags_found = fraud.flags_found;

  const reasoningText = await buildReasoningText(matching, compliance, fraud, risk, gateWeights, finalScore, finalDecision);

  const result = await db.query(
    `INSERT INTO decisions (invoice_id, agent_inputs, gate_weights, final_score, final_decision, reasoning_text)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [invoiceId, JSON.stringify(agentInputs), JSON.stringify(gateWeights), finalScore, finalDecision, reasoningText]
  );

  await db.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [finalDecision === 'auto_approved' ? 'verified' : 'flagged', invoiceId]);

  // Agent 5 update: feed this decision back into the vendor's running invoice_accuracy_pct.
  await onInvoiceDecisionFinalised(invoiceId, finalDecision);

  return result.rows[0];
}

async function buildReasoningText(matching, compliance, fraud, risk, gateWeights, finalScore, finalDecision) {
  const dominant = Object.entries(gateWeights).sort((a, b) => b[1] - a[1])[0]?.[0] || 'matching';

  const systemPrompt = `You write a short, plain-English paragraph (2-4 sentences) explaining an invoice verification decision to a Finance reviewer who is not technical. Name which signal (matching, compliance, fraud, or vendor_risk) drove the decision and why, referencing the specific numbers given. Respond ONLY with a JSON object: {"reasoning": "..."}`;
  const userPrompt = JSON.stringify({
    final_decision: finalDecision,
    final_score: finalScore.toFixed(2),
    matching: { overall_match: matching.overall_match, issue_type: matching.issue_type, weight: gateWeights.matching?.toFixed(2) },
    compliance: { gst_valid: compliance.gst_valid, issues_found: compliance.issues_found, weight: gateWeights.compliance?.toFixed(2) },
    fraud: { flags_found: fraud.flags_found, weight: gateWeights.fraud?.toFixed(2) },
    vendor_risk: { has_history: !!risk, invoice_accuracy_pct: risk?.invoice_accuracy_pct, data_volume: risk?.data_volume || 0, weight: gateWeights.vendor_risk?.toFixed(2) }
  });

  // FIXED: this call was previously unwrapped, so ANY Groq failure here (rate
  // limit, transient network issue, invalid/missing key, a malformed response
  // that still fails to parse as JSON) threw all the way out of
  // runDecisionAgent — meaning the invoice's decision was never written at
  // all, leaving it stuck indefinitely and making the whole pipeline look
  // broken from the outside. The deterministic fallback text below already
  // existed but was unreachable dead code, since nothing in groqClient.js
  // ever actually returns a `__stub` marker. Now genuinely used on failure.
  try {
    const groqResult = await callGroqStructured(systemPrompt, userPrompt);
    if (groqResult?.reasoning) return groqResult.reasoning;
  } catch (err) {
    console.error(`[decide] reasoning-text Groq call failed, using deterministic fallback: ${err.message}`);
  }

  // Deterministic fallback — no Groq key configured, or the Groq call failed.
  const decisionWord = finalDecision === 'auto_approved' ? 'auto-approved' : 'flagged for review';
  const matchNote = matching.overall_match ? 'quantities/amounts matched' : `a mismatch was found (${JSON.stringify(matching.mismatch_fields)})`;
  const complianceNote = compliance.gst_valid && compliance.issues_found.length === 0 ? 'GST checks passed' : `compliance issues found: ${compliance.issues_found.join('; ')}`;
  const fraudNote = fraud.flags_found > 0 ? `${fraud.flags_found} fraud flag(s) present` : 'no fraud signals';
  const riskNote = risk ? `vendor's track record is ${risk.invoice_accuracy_pct != null ? Number(risk.invoice_accuracy_pct).toFixed(0) + '% accurate' : 'not yet established'} (${risk.data_volume} prior events)` : 'no prior history with this vendor yet, so this carried little weight';
  return `This invoice was ${decisionWord} with a final score of ${finalScore.toFixed(2)}. The ${dominant} signal carried the most weight (${(gateWeights[dominant] * 100).toFixed(0)}%). Matching: ${matchNote}. Compliance: ${complianceNote}. Fraud: ${fraudNote}. Vendor risk: ${riskNote}. (Generated without a Groq API key — set GROQ_API_KEY in ai-service/.env for more natural-language reasoning.)`;
}

module.exports = { runDecisionAgent };

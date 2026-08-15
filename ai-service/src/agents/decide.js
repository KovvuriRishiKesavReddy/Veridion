const db = require('../db');
const { callGroqStructured } = require('../groqClient');

// runDecisionAgent: Agent 8 — the Context Gate / Decision Engine.
// For now this reads only Agents 2 (Matching) and 3 (Compliance) — Fraud and Vendor
// Risk get added in Flow 3, at which point this route gets updated to include them,
// exactly per the build doc's own staging.
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

  // Convert each agent's verdict into a 0-1 numeric score before applying the gate.
  const matchingVerdictScore = Number(matching.grn_match_score); // already 0-1
  const complianceVerdictScore = compliance.gst_valid && compliance.issues_found.length === 0 ? 1 : 0.3;

  const agents = [
    {
      name: 'matching',
      confidence: Number(matching.confidence_score),
      data_volume: Number(matching.data_volume),
      verdict_score: matchingVerdictScore
    },
    {
      name: 'compliance',
      confidence: Number(compliance.confidence_score),
      data_volume: Number(compliance.data_volume),
      verdict_score: complianceVerdictScore
    }
  ];

  const rawWeights = agents.map(a => a.confidence * Math.log(1 + a.data_volume));
  const totalRawWeight = rawWeights.reduce((sum, w) => sum + w, 0);
  const gateWeights = {};
  let finalScore = 0;

  agents.forEach((a, i) => {
    const gateWeight = totalRawWeight > 0 ? rawWeights[i] / totalRawWeight : 1 / agents.length;
    gateWeights[a.name] = gateWeight;
    finalScore += gateWeight * a.verdict_score;
  });

  let finalDecision = finalScore >= AUTO_APPROVE_THRESHOLD ? 'auto_approved' : 'flagged';
  // A genuine mismatch or invalid compliance always at least flags, regardless of score —
  // the gate weighs HOW MUCH to trust each signal, it never lets a high-confidence signal
  // silently override a real problem the other agent found.
  if (!matching.overall_match || !compliance.gst_valid) {
    finalDecision = finalDecision === 'auto_approved' ? 'flagged' : finalDecision;
  }

  const agentInputs = agents.reduce((obj, a) => {
    obj[a.name] = { confidence: a.confidence, data_volume: a.data_volume, verdict_score: a.verdict_score };
    return obj;
  }, {});

  const reasoningText = await buildReasoningText(invoiceId, matching, compliance, gateWeights, finalScore, finalDecision);

  const result = await db.query(
    `INSERT INTO decisions (invoice_id, agent_inputs, gate_weights, final_score, final_decision, reasoning_text)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [invoiceId, JSON.stringify(agentInputs), JSON.stringify(gateWeights), finalScore, finalDecision, reasoningText]
  );

  // Update the invoice's own status to reflect the decision, so it's visible without
  // joining into the decisions table everywhere.
  await db.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [finalDecision === 'auto_approved' ? 'verified' : 'flagged', invoiceId]);

  return result.rows[0];
}

async function buildReasoningText(invoiceId, matching, compliance, gateWeights, finalScore, finalDecision) {
  const dominantAgent = gateWeights.matching >= gateWeights.compliance ? 'Matching' : 'Compliance';

  const systemPrompt = `You write a short, plain-English paragraph (2-3 sentences) explaining an invoice verification decision to a Finance reviewer who is not technical. Name which signal (Matching or Compliance) drove the decision and why, referencing the specific numbers given. Respond ONLY with a JSON object: {"reasoning": "..."}`;
  const userPrompt = JSON.stringify({
    final_decision: finalDecision,
    final_score: finalScore.toFixed(2),
    matching: { overall_match: matching.overall_match, issue_type: matching.issue_type, confidence: matching.confidence_score, weight: gateWeights.matching?.toFixed(2) },
    compliance: { gst_valid: compliance.gst_valid, issues_found: compliance.issues_found, confidence: compliance.confidence_score, weight: gateWeights.compliance?.toFixed(2) }
  });

  const groqResult = await callGroqStructured(systemPrompt, userPrompt);
  if (!groqResult.__stub && groqResult.reasoning) {
    return groqResult.reasoning;
  }

  // Deterministic fallback — no Groq key configured. Honest and specific, just less
  // fluent than the LLM version would be.
  const decisionWord = finalDecision === 'auto_approved' ? 'auto-approved' : 'flagged for review';
  const matchNote = matching.overall_match
    ? 'the invoice quantity and amount matched what the warehouse confirmed and the PO agreed'
    : `a mismatch was found (see mismatch_fields: ${JSON.stringify(matching.mismatch_fields)})`;
  const complianceNote = compliance.gst_valid && compliance.issues_found.length === 0
    ? 'GST compliance checks passed'
    : `compliance issues were found: ${compliance.issues_found.join('; ')}`;
  return `This invoice was ${decisionWord} with a final score of ${finalScore.toFixed(2)}. ${dominantAgent} carried the larger weight (${(gateWeights[dominantAgent.toLowerCase()] * 100).toFixed(0)}%) in this decision. On matching: ${matchNote}. On compliance: ${complianceNote}. (Generated without a Groq API key — set GROQ_API_KEY in ai-service/.env for more natural-language reasoning.)`;
}

module.exports = { runDecisionAgent };

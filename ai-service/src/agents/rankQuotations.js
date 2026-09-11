const db = require('../db');
const { callGroqStructured } = require('../groqClient');

// runRankQuotationsAgent: Agent 6 — Quotation Ranking.
// Applies the SAME Context Gate formula as Agent 8 (Part 3.3 of the build doc: "The
// same formula is reused for Quotation Ranking"), but fused over three signals
// instead of four: Price, Delivery Fit, and Past Performance — each vendor's OWN
// (company_id, vendor_id)-scoped vendor_risk_scores row, never any other company's
// data and never vendor_platform_summary (Part 5.8's isolation principle — the gate
// only ever reads first-party, verified evidence).
//
//   raw_weight_i  = confidence_i * log(1 + data_volume_i)
//   gate_weight_i = raw_weight_i / sum(raw_weight_all_signals)
//   final_score   = sum(gate_weight_i * signal_score_i)
//
// Price and Delivery are always fully known the moment a quote is submitted, so both
// carry a fixed, non-zero data_volume of 1 regardless of vendor history — this is
// what gives them a "meaningful baseline weight... regardless of history" (Part
// 3.3.1). Price gets full confidence (1.0) since it's an exact, verifiable figure;
// Delivery gets slightly less (0.9) since it's a promise rather than a certainty —
// this is why, in the worked example, Price ends up weighted marginally higher than
// Delivery for the same vendor. Past Performance's data_volume is the vendor's REAL
// evidence count and collapses to 0 (confidence 0, verdict a neutral midpoint) for a
// vendor with no history — cold start by design, exactly like Agent 5/Agent 8.
async function runRankQuotationsAgent(requirementId) {
  const reqRes = await db.query(`SELECT * FROM requirements WHERE id = $1`, [requirementId]);
  const requirement = reqRes.rows[0];
  if (!requirement) throw new Error(`Requirement ${requirementId} not found`);

  const quotationsRes = await db.query(
    `SELECT q.*, v.company_name as vendor_name
     FROM quotations q JOIN vendors v ON v.id = q.vendor_id
     WHERE q.requirement_id = $1`,
    [requirementId]
  );
  const quotations = quotationsRes.rows;
  if (quotations.length === 0) return [];

  const prices = quotations.map(q => Number(q.price));
  const days = quotations.map(q => Number(q.delivery_days));
  const minPrice = Math.min(...prices), maxPrice = Math.max(...prices);
  const minDays = Math.min(...days), maxDays = Math.max(...days);

  // deliveryDeadlineDays: how many days from today the requirement's deadline actually
  // gives — used only as an informational penalty signal, not as a hard cutoff (a
  // vendor quoting past the deadline isn't disqualified, just scored lower on Delivery
  // Fit, since Procurement always makes the final call regardless — Part 3.6).
  let deadlineDays = null;
  if (requirement.deadline) {
    const deadline = new Date(requirement.deadline);
    deadlineDays = Math.ceil((deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  }

  const ranked = [];

  for (const q of quotations) {
    const riskRes = await db.query(
      `SELECT * FROM vendor_risk_scores WHERE company_id = $1 AND vendor_id = $2`,
      [requirement.company_id, q.vendor_id]
    );
    const risk = riskRes.rows[0];

    // --- Signal 1: Price competitiveness ---
    // Lower price = higher score. All-tied quotes (including a single quotation, the
    // n=1 case where nothing else exists to compare against) score 1 — fully
    // competitive by default, nothing else known to weigh it down.
    const priceScore = maxPrice === minPrice ? 1 : (maxPrice - Number(q.price)) / (maxPrice - minPrice);

    // --- Signal 2: Delivery fit ---
    // Lower delivery_days = higher score, same min-max normalization. A deadline
    // overrun (deliveryDate > requirement.deadline) applies a penalty on top — still
    // informational, never a hard block.
    let deliveryScore = maxDays === minDays ? 1 : (maxDays - Number(q.delivery_days)) / (maxDays - minDays);
    if (deadlineDays !== null && Number(q.delivery_days) > deadlineDays) {
      deliveryScore *= 0.5;
    }

    // --- Signal 3: Past performance ---
    // Blend of on_time_delivery_pct and invoice_accuracy_pct when both exist; falls
    // back to whichever one is available; neutral midpoint with zero confidence when
    // there's no history at all (cold start, Part 5.7).
    const hasHistory = risk && Number(risk.data_volume) > 0;
    let pastPerformanceScore = 0.5;
    if (hasHistory) {
      const metrics = [risk.on_time_delivery_pct, risk.invoice_accuracy_pct].filter(m => m != null).map(Number);
      pastPerformanceScore = metrics.length > 0 ? (metrics.reduce((a, b) => a + b, 0) / metrics.length) / 100 : 0.5;
    }
    // data_volume counts every recorded event with this vendor regardless of outcome
    // (per Part 5.2 — that's the correct meaning for the Context Gate's "how much
    // evidence exists" framing, and Agent 5 must keep counting it that way, untouched).
    // But for RANKING specifically, the question is different: "how many times has
    // this vendor actually proven themselves," not "how many times have we observed
    // them at all." A vendor with data_volume=14 and 13.77% accuracy has really only
    // demonstrated success roughly twice — ranking should size its trust in their
    // track record to that, not to all 14 observations, most of which were failures.
    // grn_on_time_count / invoice_decision_success_count are EXACT counters tracked
    // separately alongside the shared data_volume (see the migration's own comment for
    // why this couldn't just be reconstructed from data_volume — a single shared
    // counter across GRN/invoice/dispute events can't be un-mixed after the fact).
    // Pre-existing vendors (from before these counters existed) start at 0 here and
    // build up exact history from this point forward — see that migration for why
    // backfilling this specific number would have been dishonest guesswork.
    const successfulDeals = (Number(risk?.grn_on_time_count) || 0) + (Number(risk?.invoice_decision_success_count) || 0);
    const pastPerformanceDataVolume = successfulDeals;
    const pastPerformanceConfidence = pastPerformanceDataVolume > 0 ? 0.85 : 0;

    const signals = [
      { name: 'price', confidence: 1.0, data_volume: 1, score: priceScore },
      { name: 'delivery', confidence: 0.9, data_volume: 1, score: deliveryScore },
      { name: 'past_performance', confidence: pastPerformanceConfidence, data_volume: pastPerformanceDataVolume, score: pastPerformanceScore }
    ];

    const rawWeights = signals.map(s => s.confidence * Math.log(1 + s.data_volume));
    const totalRawWeight = rawWeights.reduce((sum, w) => sum + w, 0);
    const gateWeights = {};
    let finalScore = 0;
    signals.forEach((s, i) => {
      const w = totalRawWeight > 0 ? rawWeights[i] / totalRawWeight : 0;
      gateWeights[s.name] = w;
      finalScore += w * s.score;
    });

    ranked.push({ quotation: q, gateWeights, finalScore, hasHistory, dataVolume: pastPerformanceDataVolume });
  }

  ranked.sort((a, b) => b.finalScore - a.finalScore);

  // Generate plain-English reasoning for each quotation, explicitly noting when a
  // vendor's ranking leaned on Price/Delivery due to limited history (Prompt 4.1's
  // own requirement). One Groq call per quotation set would be slow for larger sets;
  // one batched call keeps this fast and gives the model the full comparative context
  // it needs to reason about relative ranking, not just each quote in isolation.
  const reasoningInput = ranked.map(r => ({
    vendor_name: r.quotation.vendor_name,
    price: r.quotation.price,
    delivery_days: r.quotation.delivery_days,
    final_score: r.finalScore.toFixed(2),
    weights: { price: r.gateWeights.price.toFixed(2), delivery: r.gateWeights.delivery.toFixed(2), past_performance: r.gateWeights.past_performance.toFixed(2) },
    has_history: r.hasHistory,
    successful_deals: r.dataVolume
  }));

  let reasoningByVendor = {};
  try {
    const systemPrompt = `You write a one-to-two sentence plain-English ranking explanation for EACH vendor quotation in a JSON array, addressed to a non-technical Procurement reviewer. Explicitly mention when a vendor's ranking leaned heavily on Price or Delivery because it has few or no successful deals with this company yet (not because it lacks activity — a vendor can have plenty of history and still have few successes in it). Respond ONLY with a JSON object: {"reasonings": [{"vendor_name": "...", "reasoning": "..."}, ...]}, one entry per input vendor, in the same order.`;
    const groqResult = await callGroqStructured(systemPrompt, JSON.stringify(reasoningInput));
    if (Array.isArray(groqResult?.reasonings)) {
      groqResult.reasonings.forEach(r => { reasoningByVendor[r.vendor_name] = r.reasoning; });
    }
  } catch (err) {
    console.error(`[rankQuotations] Groq reasoning failed for requirement ${requirementId}, using deterministic fallback: ${err.message}`);
  }

  const results = [];
  for (const r of ranked) {
    const fallbackReasoning = r.dataVolume > 0
      ? `Ranked with a final score of ${r.finalScore.toFixed(2)} — Price ${(r.gateWeights.price * 100).toFixed(0)}%, Delivery ${(r.gateWeights.delivery * 100).toFixed(0)}%, Past Performance ${(r.gateWeights.past_performance * 100).toFixed(0)}% weighted (${r.dataVolume} successful deal(s) with this company).`
      : `Ranked with a final score of ${r.finalScore.toFixed(2)}, leaning almost entirely on Price (${(r.gateWeights.price * 100).toFixed(0)}%) and Delivery (${(r.gateWeights.delivery * 100).toFixed(0)}%) — this vendor has ${r.hasHistory ? 'a track record with too few successes yet to trust' : 'no track record with your company yet'}, so Past Performance carried no real weight.`;
    const reasoning = reasoningByVendor[r.quotation.vendor_name] || fallbackReasoning;

    await db.query(
      `UPDATE quotations SET ai_rank_score = $1, ai_rank_reasoning = $2 WHERE id = $3`,
      [r.finalScore, reasoning, r.quotation.id]
    );
    results.push({ ...r.quotation, ai_rank_score: r.finalScore, ai_rank_reasoning: reasoning, gate_weights: r.gateWeights });
  }

  return results;
}

module.exports = { runRankQuotationsAgent };

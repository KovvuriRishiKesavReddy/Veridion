// /ai-service/src/utils/taxAmount.js
//
// Shared by Agent 2 (Matching) and Agent 3 (Compliance). Both agents need the
// invoice's PRE-TAX base amount, and both had the same bug independently: they were
// using structured_data.total_amount directly, which is GST-INCLUSIVE on a standard
// tax invoice. That meant:
//   - Compliance recalculated "expected GST" as rate * total_amount instead of
//     rate * base_amount — taxing the tax-inclusive figure again, always overshooting
//     by a factor of (1 + rate) and flagging every single correctly-GST-compliant
//     invoice as a mismatch.
//   - Matching compared invoice.total_amount (GST-inclusive) directly against the
//     PO's agreed_price (pre-tax, by design — see Part 7.2: a PO's tax estimate can
//     go stale, so GST is deliberately recalculated fresh at invoice time rather than
//     baked into the agreed price). That's comparing two different bases, so it
//     mismatched by exactly the GST amount on every legitimate invoice.
//
// Fixing this required one correct, shared definition of "the real pre-tax base
// amount" rather than two independent (and differently wrong) guesses.
//
// Preferred source: sum of line_items[].amount. This is a genuinely independent
// check — it doesn't trust total_amount or gst_amount being self-consistent at all,
// it recomputes the base straight from the extracted line-item breakdown. This is
// also what actually catches a fraud pattern the other method can't: a vendor whose
// total/GST are internally consistent with each other but don't match what their own
// line items actually add up to.
//
// Fallback (line items missing/unreliable): back the base out algebraically from
// total_amount and the SUBMITTED gst_amount — base = total - submitted_gst. This is
// NOT circular despite using submitted_gst: total is fixed independently of the
// check, so if a vendor inflates gst_amount without correspondingly adjusting total,
// the derived base shrinks, and re-taxing that shrunk base at the correct statutory
// rate will legitimately disagree with the (inflated) submitted_gst — still catches
// the fraud case, just via one fewer independent signal than the line-item method.
function computeBaseAmount(structured, fallbackTotal, fallbackGst) {
  const lineItems = Array.isArray(structured?.line_items) ? structured.line_items : [];
  const lineItemSum = lineItems.reduce((sum, li) => sum + (Number(li?.amount) || 0), 0);
  if (lineItems.length > 0 && lineItemSum > 0) {
    return { baseAmount: lineItemSum, source: 'line_items_sum' };
  }

  const total = Number(structured?.total_amount ?? fallbackTotal ?? 0);
  const submittedGst = Number(structured?.gst_amount ?? fallbackGst ?? 0);
  if (total > 0 && submittedGst > 0 && submittedGst < total) {
    return { baseAmount: total - submittedGst, source: 'total_minus_submitted_gst' };
  }

  // Nothing reliable to derive a base from (e.g. total-only, no GST breakdown at all,
  // or OCR extraction failed entirely) — caller should treat this as "unavailable"
  // rather than silently taxing the wrong figure.
  return { baseAmount: 0, source: 'unavailable' };
}

module.exports = { computeBaseAmount };

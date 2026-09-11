const db = require('../db');
const { callGroqStructured } = require('../groqClient');

// runVendorCommunicationAgent: Agent 7 — Vendor Communication.
//
// Called automatically by Agent 8 (decide.js) in TWO cases:
//   - 'flagged' — a normal Matching/Compliance mismatch.
//   - 'suspicious' — a high-severity fraud signal was found. This dispute record
//     exists ALONGSIDE the Platform Admin fraud review (fraud_flags), not instead of
//     it — Finance gets visibility and can request clarification, while the fraud
//     signal itself is still reviewed separately by Platform Admin. Nothing here is
//     ever sent automatically either way (see status='pending_send' below) — a human
//     always reviews and explicitly clicks Send before a suspected-fraud vendor is
//     contacted at all.
//
// Drafts a short, factual, non-accusatory message via Groq and inserts a
// vendor_communications row with status='pending_send' for Finance to review, edit,
// and send. `fraudFlags` (optional) is the array of high-severity flags from Agent 4,
// passed only for the 'suspicious' case — used to steer the drafted wording toward a
// generic "please provide supporting documentation" request WITHOUT revealing the
// specific fraud signal (e.g. never mentions a shared bank account or GSTIN mismatch
// outright) — that framing would tip off a genuinely fraudulent vendor and could
// compromise Platform Admin's own review.
async function runVendorCommunicationAgent(invoiceId, fraudFlags = null) {
  const invRes = await db.query(
    `SELECT inv.*, v.company_name as vendor_name, r.title as requirement_title, po.company_id
     FROM invoices inv
     JOIN vendors v ON v.id = inv.vendor_id
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN requirements r ON r.id = po.requirement_id
     WHERE inv.id = $1`,
    [invoiceId]
  );
  const invoice = invRes.rows[0];
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  const matchingRes = await db.query(`SELECT * FROM matching_results WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
  const complianceRes = await db.query(`SELECT * FROM compliance_checks WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
  const matching = matchingRes.rows[0];
  const compliance = complianceRes.rows[0];

  const isFraudReview = Array.isArray(fraudFlags) && fraudFlags.length > 0;

  // A short, stable label for what this dispute is actually about — shown in the
  // Finance dispute list without anyone having to open the full mismatch_fields JSON.
  // A fraud-review case is labelled distinctly and takes priority over any matching/
  // compliance label, since that's definitionally why this invoice landed here at all
  // — Matching/Compliance may or may not also have issues, but they aren't the reason
  // this dispute exists. Otherwise, preference order mirrors severity: a genuine
  // item-description problem or an amount/quantity mismatch is the vendor's own doing;
  // a GST/compliance issue may just be a stale rate; anything else falls back to a
  // generic label.
  const mismatchFields = matching?.mismatch_fields || {};
  let mismatchType;
  if (isFraudReview) {
    mismatchType = 'vendor_identity_review';
  } else {
    mismatchType = 'other';
    if (mismatchFields.item_description) mismatchType = 'item_description_mismatch';
    else if (mismatchFields.quantity) mismatchType = 'quantity_mismatch';
    else if (mismatchFields.amount) mismatchType = 'amount_mismatch';
    else if (mismatchFields.form_vs_document) mismatchType = 'form_vs_document_mismatch';
    else if (compliance && !compliance.gst_valid) mismatchType = 'gst_compliance';
  }

  const systemPrompt = isFraudReview
    ? `You draft a short, polite, professional message from a procurement company to one of its vendors, requesting documentation to verify the vendor's identity before an invoice can be processed. Never accusatory, never mention fraud, suspicion, or any specific discrepancy — this must read as a routine verification step. The message MUST explicitly ask for: (1) a copy of the vendor's GST registration certificate, and (2) a recent bank statement or cancelled cheque confirming the bank account on file — these are the only two documents that matter here, do not substitute generic documents like a purchase order or delivery receipt instead. State all amounts in Indian Rupees (₹), never $ or USD. Keep it under 150 words. Respond ONLY with a JSON object: {"message": "..."}`
    : `You draft a short, polite, factual dispute message from a procurement company to one of its vendors, explaining why an invoice was flagged for review. Never accusatory — assume good faith and an honest mistake unless the evidence says otherwise. State all amounts in Indian Rupees (₹), never $ or USD. Keep it under 150 words. Respond ONLY with a JSON object: {"message": "..."}`;
  const userPrompt = JSON.stringify({
    vendor_name: invoice.vendor_name,
    requirement_title: invoice.requirement_title,
    invoice_number: invoice.invoice_number || `#${invoice.id}`,
    invoice_amount: invoice.invoice_amount,
    mismatch_type: mismatchType,
    mismatch_fields: isFraudReview ? {} : mismatchFields,
    compliance_issues: isFraudReview ? [] : (compliance?.issues_found || [])
  });

  let draftText;
  try {
    const result = await callGroqStructured(systemPrompt, userPrompt);
    draftText = result?.message;
  } catch (err) {
    console.error(`[vendorCommunication] Groq draft failed for invoice ${invoiceId}, using deterministic fallback: ${err.message}`);
  }

  if (!draftText) {
    // Deterministic fallback — no Groq key configured, or the call failed. Still a
    // real, sendable message; just not generated language.
    if (isFraudReview) {
      draftText = `Hello ${invoice.vendor_name}, thank you for submitting invoice ${invoice.invoice_number || `#${invoice.id}`} for "${invoice.requirement_title}". As part of our standard verification process, could you please share supporting documentation for this invoice (e.g. your GST registration certificate and a recent bank statement confirming the account on file) before we proceed? We appreciate your cooperation.`;
    } else {
      const fieldNote = Object.keys(mismatchFields).length
        ? `Specifically: ${JSON.stringify(mismatchFields)}.`
        : (compliance?.issues_found?.length ? `Specifically: ${compliance.issues_found.join('; ')}.` : '');
      draftText = `Hello ${invoice.vendor_name}, thank you for submitting invoice ${invoice.invoice_number || `#${invoice.id}`} for "${invoice.requirement_title}". Our automated review found a discrepancy that needs a quick clarification before we can process payment. ${fieldNote} Could you please review and let us know if this was an oversight, or share any additional documentation that explains it? We appreciate your prompt response.`;
    }
  }

  const result = await db.query(
    `INSERT INTO vendor_communications (invoice_id, vendor_id, draft_text, mismatch_type, company_id, invoice_number_snapshot, vendor_name_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (invoice_id) WHERE invoice_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [invoiceId, invoice.vendor_id, draftText, mismatchType, invoice.company_id, invoice.invoice_number || `#${invoice.id}`, invoice.vendor_name]
  );
  if (result.rows[0]) return result.rows[0];
  // A concurrent call already created this invoice's dispute (see the unique index's
  // own comment in the migration) -- return the existing row rather than nothing, so
  // callers never have to special-case "no row came back."
  const existing = await db.query(`SELECT * FROM vendor_communications WHERE invoice_id = $1`, [invoiceId]);
  return existing.rows[0];
}

module.exports = { runVendorCommunicationAgent };

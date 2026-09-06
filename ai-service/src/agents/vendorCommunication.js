const db = require('../db');
const { callGroqStructured } = require('../groqClient');

// runVendorCommunicationAgent: Agent 7 — Vendor Communication.
// Called automatically by Agent 8 (decide.js) whenever a decision comes back
// 'flagged' (never 'suspicious' — a fraud-routed invoice goes to Platform Admin
// review instead, per Part 6.3/9 of the build doc; drafting a polite dispute message
// for a suspected-fraud case would be the wrong tone entirely).
//
// Drafts a short, factual, non-accusatory explanation of the mismatch via Groq and
// inserts a vendor_communications row with status='pending_send' for Finance to
// review, edit, and send.
async function runVendorCommunicationAgent(invoiceId) {
  const invRes = await db.query(
    `SELECT inv.*, v.company_name as vendor_name, r.title as requirement_title
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

  // A short, stable label for what this dispute is actually about — shown in the
  // Finance dispute list without anyone having to open the full mismatch_fields JSON.
  // Preference order mirrors severity: a genuine item-description problem or an
  // amount/quantity mismatch is the vendor's own doing; a GST/compliance issue may
  // just be a stale rate; anything else falls back to a generic label.
  const mismatchFields = matching?.mismatch_fields || {};
  let mismatchType = 'other';
  if (mismatchFields.item_description) mismatchType = 'item_description_mismatch';
  else if (mismatchFields.quantity) mismatchType = 'quantity_mismatch';
  else if (mismatchFields.amount) mismatchType = 'amount_mismatch';
  else if (mismatchFields.form_vs_document) mismatchType = 'form_vs_document_mismatch';
  else if (compliance && !compliance.gst_valid) mismatchType = 'gst_compliance';

  const systemPrompt = `You draft a short, polite, factual dispute message from a procurement company to one of its vendors, explaining why an invoice was flagged for review. Never accusatory — assume good faith and an honest mistake unless the evidence says otherwise. Keep it under 150 words. Respond ONLY with a JSON object: {"message": "..."}`;
  const userPrompt = JSON.stringify({
    vendor_name: invoice.vendor_name,
    requirement_title: invoice.requirement_title,
    invoice_number: invoice.invoice_number || `#${invoice.id}`,
    invoice_amount: invoice.invoice_amount,
    mismatch_type: mismatchType,
    mismatch_fields: mismatchFields,
    compliance_issues: compliance?.issues_found || []
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
    const fieldNote = Object.keys(mismatchFields).length
      ? `Specifically: ${JSON.stringify(mismatchFields)}.`
      : (compliance?.issues_found?.length ? `Specifically: ${compliance.issues_found.join('; ')}.` : '');
    draftText = `Hello ${invoice.vendor_name}, thank you for submitting invoice ${invoice.invoice_number || `#${invoice.id}`} for "${invoice.requirement_title}". Our automated review found a discrepancy that needs a quick clarification before we can process payment. ${fieldNote} Could you please review and let us know if this was an oversight, or share any additional documentation that explains it? We appreciate your prompt response.`;
  }

  const result = await db.query(
    `INSERT INTO vendor_communications (invoice_id, vendor_id, draft_text, mismatch_type)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [invoiceId, invoice.vendor_id, draftText, mismatchType]
  );
  return result.rows[0];
}

module.exports = { runVendorCommunicationAgent };

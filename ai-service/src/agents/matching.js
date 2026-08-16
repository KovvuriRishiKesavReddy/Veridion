const db = require('../db');

// runMatchingAgent: Agent 2 — Semantic Matching.
// Three checks now, not two:
// 1. GRN check — what the invoice claims vs what the warehouse actually confirmed
//    received (cumulative across every GRN on the PO).
// 2. PO amount check — what the invoice claims vs the PO's agreed price.
// 3. Document self-consistency check (NEW) — what the vendor TYPED into the upload
//    form vs what Agent 1 actually extracted from the uploaded document itself. This
//    is the check that catches a vendor claiming one GSTIN/amount/quantity in the
//    form while the real invoice document says something else — a meaningfully
//    different kind of problem from a PO/GRN mismatch, since it's about whether the
//    submission is internally honest, not whether the deal terms were met.
async function runMatchingAgent(invoiceId) {
  const invRes = await db.query(
    `SELECT inv.*, po.agreed_price, po.agreed_quantity, po.id as po_id
     FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id
     WHERE inv.id = $1`,
    [invoiceId]
  );
  const invoice = invRes.rows[0];
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  const extractionRes = await db.query(
    `SELECT * FROM document_extractions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`,
    [invoiceId]
  );
  const extraction = extractionRes.rows[0];
  const structured = extraction?.structured_data || {};
  // Only meaningful when Agent 1 actually read something from the real document —
  // comparing self-reported data against itself (the vendor_submitted_fallback case)
  // would always "match" and tell us nothing.
  const documentWasReallyExtracted = structured.__source !== 'vendor_submitted_fallback';

  const receivedRes = await db.query(
    `SELECT COALESCE(SUM(received_quantity), 0) as total_received FROM goods_receipt_notes WHERE po_id = $1`,
    [invoice.po_id]
  );
  const grnQuantity = Number(receivedRes.rows[0].total_received);

  const invoiceQuantity = Number(structured.quantity ?? invoice.invoice_quantity ?? 0);
  const invoiceAmount = Number(structured.total_amount ?? invoice.invoice_amount ?? 0);
  const agreedAmount = Number(invoice.agreed_price);

  const mismatchFields = {};
  let overallMatch = true;
  let dataVolume = 2; // GRN check + PO amount check, always present

  // --- Check 1: quantity vs GRN-confirmed receipt ---
  const quantityDelta = invoiceQuantity - grnQuantity;
  if (Math.abs(quantityDelta) > 0.01) {
    mismatchFields.quantity = { invoice_claims: invoiceQuantity, grn_confirmed: grnQuantity, delta: quantityDelta };
    overallMatch = false;
  }

  // --- Check 2: amount vs PO agreed price ---
  const amountDelta = invoiceAmount - agreedAmount;
  if (Math.abs(amountDelta) > 1) {
    mismatchFields.amount = { invoice_claims: invoiceAmount, po_agreed: agreedAmount, delta: amountDelta };
    overallMatch = false;
  }

  // --- Check 3: form fields vs what's actually in the uploaded document ---
  if (documentWasReallyExtracted) {
    dataVolume += 1;
    const formVsDoc = {};

    const formGstin = (invoice.gstin_on_invoice || '').trim().toUpperCase();
    const docGstin = (structured.gstin || '').trim().toUpperCase();
    if (formGstin && docGstin && formGstin !== docGstin) {
      formVsDoc.gstin = { form_entered: formGstin, document_shows: docGstin };
    }

    const formQty = Number(invoice.invoice_quantity);
    const docQty = structured.quantity != null ? Number(structured.quantity) : null;
    if (docQty != null && !isNaN(docQty) && Math.abs(formQty - docQty) > 0.01) {
      formVsDoc.quantity = { form_entered: formQty, document_shows: docQty };
    }

    const formAmount = Number(invoice.invoice_amount);
    const docAmount = structured.total_amount != null ? Number(structured.total_amount) : null;
    if (docAmount != null && !isNaN(docAmount) && Math.abs(formAmount - docAmount) > 1) {
      formVsDoc.total_amount = { form_entered: formAmount, document_shows: docAmount };
    }

    const formGst = Number(invoice.gst_amount);
    const docGst = structured.gst_amount != null ? Number(structured.gst_amount) : null;
    if (docGst != null && !isNaN(docGst) && Math.abs(formGst - docGst) > 1) {
      formVsDoc.gst_amount = { form_entered: formGst, document_shows: docGst };
    }

    if (Object.keys(formVsDoc).length > 0) {
      mismatchFields.form_vs_document = formVsDoc;
      overallMatch = false;
    }
  }

  const issueType = overallMatch ? 'informational' : 'mismatch';
  const poMatchScore = agreedAmount > 0 ? Math.max(0, 1 - Math.abs(amountDelta) / agreedAmount) : 0;
  const grnMatchScore = grnQuantity > 0 ? Math.max(0, 1 - Math.abs(quantityDelta) / grnQuantity) : (invoiceQuantity === 0 ? 1 : 0);

  // confidence_score reflects how much we trust the underlying data. When the document
  // was genuinely extracted AND self-consistent with the form, confidence goes UP — an
  // invoice that matches its own uploaded document is more trustworthy than one that's
  // just self-reported with nothing to check it against.
  let confidenceScore = extraction?.confidence_score != null ? Number(extraction.confidence_score) : 0.5;
  if (documentWasReallyExtracted && !mismatchFields.form_vs_document) {
    confidenceScore = Math.min(1, confidenceScore + 0.1); // document confirms the form — small trust boost
  }

  const result = await db.query(
    `INSERT INTO matching_results (invoice_id, po_match_score, grn_match_score, mismatch_fields, overall_match, confidence_score, data_volume, issue_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [invoiceId, poMatchScore, grnMatchScore, JSON.stringify(mismatchFields), overallMatch, confidenceScore, dataVolume, issueType]
  );
  return result.rows[0];
}

module.exports = { runMatchingAgent };

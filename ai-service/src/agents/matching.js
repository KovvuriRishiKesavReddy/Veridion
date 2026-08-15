const db = require('../db');

// runMatchingAgent: Agent 2 — Semantic Matching.
// Compares what the invoice claims against the GRN-confirmed cumulative received
// quantity for the PO — NOT the PO's original agreed_quantity directly. This matters:
// Flow 1 already enforces that a PO must be fully fulfilled before an invoice can even
// be submitted, so at this point cumulative received should equal (or, in an overage
// case, exceed) the agreed quantity — that's the actual ground truth to check against,
// consistent with how fulfillment is tracked everywhere else in the system.
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

  // Quantity check: informational if it matches GRN-confirmed receipt (even if that
  // differs from the PO's original agreed_quantity — an approved overage is legitimate,
  // per the GRN's own variance tracking from Flow 1); a genuine mismatch otherwise.
  const quantityDelta = invoiceQuantity - grnQuantity;
  if (Math.abs(quantityDelta) > 0.01) {
    mismatchFields.quantity = { invoice_claims: invoiceQuantity, grn_confirmed: grnQuantity, delta: quantityDelta };
    overallMatch = false;
  }

  // Amount check: compare against the PO's agreed price (tolerate small rounding).
  const amountDelta = invoiceAmount - agreedAmount;
  if (Math.abs(amountDelta) > 1) {
    mismatchFields.amount = { invoice_claims: invoiceAmount, po_agreed: agreedAmount, delta: amountDelta };
    overallMatch = false;
  }

  const issueType = overallMatch ? 'informational' : 'mismatch';
  const poMatchScore = agreedAmount > 0 ? Math.max(0, 1 - Math.abs(amountDelta) / agreedAmount) : 0;
  const grnMatchScore = grnQuantity > 0 ? Math.max(0, 1 - Math.abs(quantityDelta) / grnQuantity) : (invoiceQuantity === 0 ? 1 : 0);

  // confidence_score reflects how much we trust the underlying data: OCR extraction
  // confidence caps it, since a mismatch found on a low-confidence extraction (e.g. a
  // blurry scan) shouldn't be trusted as much as one found on clean, verified data.
  const confidenceScore = extraction?.confidence_score != null ? Number(extraction.confidence_score) : 0.5;
  const dataVolume = 2; // two comparable fields checked (quantity, amount) — no per-line-item detail in this schema yet

  const result = await db.query(
    `INSERT INTO matching_results (invoice_id, po_match_score, grn_match_score, mismatch_fields, overall_match, confidence_score, data_volume, issue_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [invoiceId, poMatchScore, grnMatchScore, JSON.stringify(mismatchFields), overallMatch, confidenceScore, dataVolume, issueType]
  );
  return result.rows[0];
}

module.exports = { runMatchingAgent };

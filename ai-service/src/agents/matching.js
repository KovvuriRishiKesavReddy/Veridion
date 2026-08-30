const db = require('../db');
const { computeBaseAmount } = require('../utils/taxAmount');

// Loose, conservative token-overlap comparison — same technique as fraud.js's vendor
// name check, applied to product descriptions instead of company names. Deliberately
// tolerant of real-world variance (a requirement titled "cement" matching an invoice
// line item "OPC 53 Grade Cement 50kg bags" should NOT be flagged — very different
// words, but the core product is genuinely the same), while still catching a
// completely unrelated product ("cement" vs "AC" / air conditioners) with confidence.
function normalizeItemText(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function itemSimilarity(a, b) {
  const tokensA = new Set(normalizeItemText(a).split(' ').filter(t => t.length > 1)); // drop single-char noise
  const tokensB = new Set(normalizeItemText(b).split(' ').filter(t => t.length > 1));
  if (tokensA.size === 0 || tokensB.size === 0) return null;
  // Containment-based rather than pure Jaccard: a short category ("cement") should
  // still score well against a long, specific line-item description ("OPC 53 Grade
  // Cement 50kg bags") even though the long string's OWN unrelated tokens (grade,
  // bags, kg) would drag a symmetric Jaccard score down unfairly. Score = fraction of
  // the SHORTER token set that's found in the longer one.
  const [shorter, longer] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  const matched = [...shorter].filter(t => [...longer].some(l => l.includes(t) || t.includes(l))).length;
  return matched / shorter.size;
}

// runMatchingAgent: Agent 2 — Semantic Matching.
// Four checks now, not three:
// 1. GRN check — what the invoice claims vs what the warehouse actually confirmed
//    received (cumulative across every GRN on the PO).
// 2. PO amount check — what the invoice claims vs the PO's agreed price.
// 3. Document self-consistency check — what the vendor TYPED into the upload
//    form vs what Agent 1 actually extracted from the uploaded document itself. This
//    is the check that catches a vendor claiming one GSTIN/amount/quantity in the
//    form while the real invoice document says something else — a meaningfully
//    different kind of problem from a PO/GRN mismatch, since it's about whether the
//    submission is internally honest, not whether the deal terms were met.
// 4. Item description consistency (NEW) — does what the invoice DOCUMENT actually
//    describes as the product bear any resemblance to what was ordered in the
//    REQUIREMENT? Every check above only ever compares quantities and amounts —
//    nothing compared WHAT those quantities/amounts were actually FOR. A vendor could
//    invoice the exact right quantity and amount, for a completely different product,
//    and every check above would happily pass it — quantity 100 matches, amount
//    matches, the form matches the document... but the company ordered air
//    conditioners and got billed for cement. This closes that gap.
async function runMatchingAgent(invoiceId) {
  const invRes = await db.query(
    `SELECT inv.*, po.agreed_price, po.agreed_quantity, po.id as po_id, r.title as requirement_title, r.category as requirement_category
     FROM invoices inv
     JOIN purchase_orders po ON po.id = inv.po_id
     JOIN requirements r ON r.id = po.requirement_id
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
  const invoiceAmount = Number(structured.total_amount ?? invoice.invoice_amount ?? 0); // GST-inclusive grand total — only valid to compare against another GST-inclusive figure (Check 3 below)
  const agreedAmount = Number(invoice.agreed_price); // PO's agreed_price is PRE-TAX by design (Part 7.2 — GST is recalculated fresh at invoice time, never baked into the PO)

  // FIXED: this check previously compared invoiceAmount (GST-inclusive) directly
  // against agreedAmount (pre-tax) — comparing two different bases meant EVERY
  // legitimately GST-compliant invoice mismatched by exactly its own GST amount.
  // Use the same pre-tax base derivation Compliance uses, so a correctly-taxed
  // invoice (base + GST = total) reconciles cleanly against the PO's pre-tax price.
  const { baseAmount: invoiceBaseAmount, source: baseAmountSource } = computeBaseAmount(structured, invoice.invoice_amount, invoice.gst_amount);

  const mismatchFields = {};
  let overallMatch = true;
  let dataVolume = 2; // GRN check + PO amount check, always present

  // --- Check 1: quantity vs GRN-confirmed receipt ---
  const quantityDelta = invoiceQuantity - grnQuantity;
  if (Math.abs(quantityDelta) > 0.01) {
    mismatchFields.quantity = { invoice_claims: invoiceQuantity, grn_confirmed: grnQuantity, delta: quantityDelta };
    overallMatch = false;
  }

  // --- Check 2: PRE-TAX amount vs PO agreed price, scaled proportionally to the
  // GRN-confirmed quantity when it legitimately differs from the original PO quantity.
  // Without the quantity scaling, a real, GRN-approved overage (e.g. PO agreed 100,
  // warehouse actually received and confirmed 110, vendor correctly bills for 110 at
  // the same per-unit rate) would always mismatch on amount — because 110 units'
  // worth of cost never equals the flat PO total for 100. That's a false positive on
  // a legitimate delivery, not a real discrepancy, and it's now handled correctly:
  // the "expected" amount scales with what the GRN actually confirmed, so a
  // proportional, honest overage or shortfall bill still matches cleanly, while
  // under/over-CHARGING relative to the agreed per-unit rate is still caught.
  const poAgreedQuantity = Number(invoice.agreed_quantity);
  const perUnitRate = poAgreedQuantity > 0 ? agreedAmount / poAgreedQuantity : agreedAmount;
  const expectedAmountForGrnQuantity = perUnitRate * grnQuantity;
  const amountDelta = invoiceBaseAmount - expectedAmountForGrnQuantity;
  const amountTolerance = Math.max(1, expectedAmountForGrnQuantity * 0.01); // 1% tolerance for rounding
  if (baseAmountSource === 'unavailable') {
    mismatchFields.amount = { issue: 'Could not determine a pre-tax base amount to compare against the PO — no line items and no usable total/GST breakdown' };
    overallMatch = false;
  } else if (Math.abs(amountDelta) > amountTolerance) {
    mismatchFields.amount = { invoice_claims_pretax: Math.round(invoiceBaseAmount * 100) / 100, invoice_claims_total_with_gst: invoiceAmount, expected_for_grn_quantity: Math.round(expectedAmountForGrnQuantity * 100) / 100, po_agreed_total: agreedAmount, delta: Math.round(amountDelta * 100) / 100, base_amount_source: baseAmountSource };
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

    // FIXED: same base-amount bug as Check 2 and Compliance's GST recalculation, just
    // in a third location. invoice.invoice_amount (the vendor's own form entry) is
    // PRE-TAX by design — matches the PO's agreed_price, with GST tracked separately
    // in invoice.gst_amount (see Check 2's comment above for the full reasoning).
    // structured.total_amount (from the document) is GST-INCLUSIVE. Comparing them
    // directly meant every honest vendor who correctly entered the pre-tax amount on
    // the form (matching their own PO) got flagged the instant their invoice PDF
    // showed a GST-inclusive total — which is every compliant invoice with GST added.
    // Compare the form's pre-tax entry against the document's own pre-tax base instead
    // (both sides of this check now mean the same thing).
    const formAmount = Number(invoice.invoice_amount);
    const { baseAmount: docBaseAmount, source: formVsDocBaseSource } = computeBaseAmount(structured, null, null);
    if (formVsDocBaseSource !== 'unavailable' && Math.abs(formAmount - docBaseAmount) > 1) {
      formVsDoc.total_amount = { form_entered_pretax: formAmount, document_shows_pretax: Math.round(docBaseAmount * 100) / 100, document_shows_total_with_gst: structured.total_amount, base_amount_source: formVsDocBaseSource };
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

  // --- Check 4: does the invoiced PRODUCT bear any resemblance to what was ordered? ---
  // Only meaningful once line_items are genuinely present — depends on the OCR/Groq
  // fixes actually extracting them, which previously silently failed on some real
  // invoices (see ocr.js). A quantity/amount match alone proves nothing about WHAT was
  // delivered; this is the check that actually looks at that.
  let itemMismatchSevere = false;
  if (documentWasReallyExtracted && Array.isArray(structured.line_items) && structured.line_items.length > 0) {
    dataVolume += 1;
    const itemDescriptions = structured.line_items.map(li => li.description).filter(Boolean).join(' ');
    const requirementText = [invoice.requirement_title, invoice.requirement_category].filter(Boolean).join(' ');
    const similarity = itemSimilarity(requirementText, itemDescriptions);
    if (similarity !== null && similarity < 0.2) {
      mismatchFields.item_description = {
        requirement_ordered: requirementText,
        invoice_line_items_describe: itemDescriptions,
        similarity: Math.round(similarity * 100) / 100,
      };
      overallMatch = false;
      itemMismatchSevere = true; // this is categorically worse than a quantity/amount variance
    }
  }

  // A product-mismatch is serious enough to warrant fraud_suspect over a plain
  // 'mismatch' — being billed for a completely different item than what was ordered
  // is not the kind of thing a rounding error or a stale PO estimate explains.
  const issueType = overallMatch ? 'informational' : (itemMismatchSevere ? 'fraud_suspect' : 'mismatch');
  const poMatchScore = expectedAmountForGrnQuantity > 0 ? Math.max(0, 1 - Math.abs(amountDelta) / expectedAmountForGrnQuantity) : 0;
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

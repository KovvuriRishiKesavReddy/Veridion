const db = require('../db');

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// Simplified GST rate lookup by requirement category — a stand-in for a real GSTN
// sandbox call (no GSTN_SANDBOX_API_KEY configured, matching the doc's own guidance
// to use a clearly-commented mock when unavailable). Rates are illustrative, not
// authoritative — swap this for a real lookup/API before using this for anything real.
const GST_RATES_BY_CATEGORY = {
  cement: 0.28,
  bricks: 0.05,
  steel: 0.18,
  default: 0.18
};

// runComplianceAgent: Agent 3 — Compliance.
// Validates GSTIN format, and independently recalculates what the GST SHOULD be for
// this item category as of today — never compares against any PO-stored estimate,
// which is the exact rule from Part 7.2 (a PO's original tax figure can go stale
// between when it was generated and when the invoice is actually raised).
async function runComplianceAgent(invoiceId) {
  const invRes = await db.query(
    `SELECT inv.*, r.category
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
  const structured = extractionRes.rows[0]?.structured_data || {};
  const gstin = structured.gstin || invoice.gstin_on_invoice;

  const issuesFound = [];
  const gstValid = !!gstin && GSTIN_REGEX.test(gstin);
  if (!gstin) issuesFound.push('No GSTIN present on invoice');
  else if (!gstValid) issuesFound.push('GSTIN does not match the standard 15-character format');

  const rate = GST_RATES_BY_CATEGORY[invoice.category] ?? GST_RATES_BY_CATEGORY.default;
  const baseAmount = Number(structured.total_amount ?? invoice.invoice_amount ?? 0);
  const expectedGst = Math.round(baseAmount * rate * 100) / 100;
  const submittedGst = Number(structured.gst_amount ?? invoice.gst_amount ?? 0);
  const gstDelta = submittedGst - expectedGst;

  if (Math.abs(gstDelta) > Math.max(1, expectedGst * 0.02)) { // >2% tolerance
    issuesFound.push(`GST amount ₹${submittedGst} does not match the recalculated expected amount ₹${expectedGst} (${(rate * 100).toFixed(0)}% of ₹${baseAmount})`);
  }

  const confidenceScore = gstin ? 0.9 : 0.4; // format check is deterministic and reliable when a GSTIN exists at all
  const dataVolume = 1; // single invoice-level check, no historical GST-rate volume tracked yet

  const result = await db.query(
    `INSERT INTO compliance_checks (invoice_id, gst_valid, gst_details, issues_found, confidence_score, data_volume, gst_rate_used, gst_rate_reference_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE) RETURNING *`,
    [
      invoiceId, gstValid,
      JSON.stringify({ gstin, expected_gst: expectedGst, submitted_gst: submittedGst, base_amount: baseAmount }),
      issuesFound, confidenceScore, dataVolume, rate
    ]
  );
  return result.rows[0];
}

module.exports = { runComplianceAgent };

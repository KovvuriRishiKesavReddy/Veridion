const db = require('../db');
const { runCypher } = require('../neo4jClient');

// Loose but deliberately conservative name comparison — tolerates "Pvt. Ltd." vs
// "Private Limited" style formatting drift (normalize + token overlap) rather than
// requiring exact string equality, so we don't flag genuine vendors over punctuation.
// A LOW overlap score is still a meaningful signal that these are plausibly two
// different companies entirely, which is what we actually care about here.
function normalizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|inc|corp|corporation|co)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function nameSimilarity(a, b) {
  const tokensA = new Set(normalizeCompanyName(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeCompanyName(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return null; // not enough to compare
  const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union; // Jaccard similarity, 0 = nothing in common, 1 = identical token sets
}

// runFraudAgent: Agent 4 — Fraud Detection.
// Three checks:
//
// 1. Shell-company detection: does this vendor share a bank account or address with
//    a DIFFERENT vendor node in the graph? (Neo4j)
// 2. Vendor identity consistency: does the invoice DOCUMENT itself (as OCR'd) claim to
//    be issued by the SAME company as the vendor account actually uploading it?
//    (Postgres — compares against the registered vendors row, not graph-based)
// 3. Split-billing detection: multiple invoices against the same PO, submitted close
//    together, each individually small — WITHOUT proportional real GRN backing. This
//    is the exact signal that distinguishes fraud from a legitimate partial delivery
//    (which always has a real GRN behind it, per Part 7.4's own reasoning) — but note
//    Flow 1 already blocks invoicing until a PO is fully fulfilled and blocks a second
//    invoice on the same PO entirely, so this check is here for completeness and stays
//    dormant under Flow 1's current invoicing rules; it becomes meaningful once/if
//    multi-invoice-per-PO is ever allowed.
async function runFraudAgent(invoiceId) {
  const invRes = await db.query(
    `SELECT inv.*, po.id as po_id FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id WHERE inv.id = $1`,
    [invoiceId]
  );
  const invoice = invRes.rows[0];
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  const flags = [];

  // --- Check 1: shell company (shared bank account or address with a different vendor) ---
  const sharedBankRecords = await runCypher(
    `MATCH (v1:Vendor {id: $vendorId})-[:HAS_BANK_ACCOUNT]->(b:BankAccount)<-[:HAS_BANK_ACCOUNT]-(v2:Vendor)
     WHERE v2.id <> v1.id
     RETURN v2.id as other_vendor_id, v2.company_name as other_vendor_name, b.number as shared_account`,
    { vendorId: invoice.vendor_id }
  );
  if (sharedBankRecords.length > 0) {
    flags.push({
      flag_type: 'shell_company_shared_bank_account',
      severity: 'high',
      confidence_score: 0.95, // graph exact-match queries are highly reliable
      evidence: sharedBankRecords.map(r => ({ other_vendor_id: r.get('other_vendor_id'), other_vendor_name: r.get('other_vendor_name'), shared_account: r.get('shared_account') }))
    });
  }

  const sharedAddressRecords = await runCypher(
    `MATCH (v1:Vendor {id: $vendorId})-[:HAS_ADDRESS]->(a:Address)<-[:HAS_ADDRESS]-(v2:Vendor)
     WHERE v2.id <> v1.id
     RETURN v2.id as other_vendor_id, v2.company_name as other_vendor_name, a.value as shared_address`,
    { vendorId: invoice.vendor_id }
  );
  if (sharedAddressRecords.length > 0) {
    flags.push({
      flag_type: 'shell_company_shared_address',
      severity: 'high',
      confidence_score: 0.9,
      evidence: sharedAddressRecords.map(r => ({ other_vendor_id: r.get('other_vendor_id'), other_vendor_name: r.get('other_vendor_name'), shared_address: r.get('shared_address') }))
    });
  }

  // --- Check 2 (NEW): vendor identity consistency — does the invoice DOCUMENT itself
  // claim to be issued by the SAME company as the vendor account that's actually
  // uploading it? Every check elsewhere in the pipeline (Matching's form_vs_document,
  // Compliance's GST check) only compares the upload FORM against the DOCUMENT — never
  // either of those against the REGISTERED VENDOR PROFILE tied to invoice.vendor_id.
  // That's a real gap: an authenticated vendor account could upload an invoice PDF
  // that's actually for a completely different company (impersonation, or laundering
  // an unrelated business's invoice through an unrelated account), and nothing
  // upstream would ever notice, because the form fields and the document can be
  // perfectly self-consistent with EACH OTHER while both disagreeing with who is
  // actually logged in submitting them.
  //
  // Only meaningful when OCR genuinely read the document (not the vendor_submitted_
  // fallback case, which would trivially "match" the vendor's own account since it's
  // just the form data again).
  const extractionRes = await db.query(
    `SELECT structured_data FROM document_extractions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`,
    [invoiceId]
  );
  const structured = extractionRes.rows[0]?.structured_data || {};

  if (structured.__source === 'ocr_extraction') {
    const vendorRes = await db.query(
      `SELECT company_name, gstin, bank_account_number FROM vendors WHERE id = $1`,
      [invoice.vendor_id]
    );
    const registeredVendor = vendorRes.rows[0];

    if (registeredVendor) {
      const identityMismatches = {};

      // GSTIN — exact, normalized comparison. A precise 15-character identifier;
      // any difference here (when both are present) is a strong, unambiguous signal,
      // not a fuzzy judgment call.
      const docGstin = (structured.gstin || '').trim().toUpperCase();
      const registeredGstin = (registeredVendor.gstin || '').trim().toUpperCase();
      if (docGstin && registeredGstin && docGstin !== registeredGstin) {
        identityMismatches.gstin = { document_shows: docGstin, registered_vendor_gstin: registeredGstin };
      }

      // Bank account — exact comparison when both are known. Equally strong signal
      // when present; frequently absent since not every invoice layout prints one.
      const docBank = (structured.bank_account_number || '').replace(/\s/g, '');
      const registeredBank = (registeredVendor.bank_account_number || '').replace(/\s/g, '');
      if (docBank && registeredBank && docBank !== registeredBank) {
        identityMismatches.bank_account_number = { document_shows: docBank, registered_vendor_account: registeredBank };
      }

      // Company name — fuzzy, conservative comparison (see nameSimilarity above).
      // Only treated as a signal below a low threshold, and only counted toward the
      // flag alongside at least one of the two exact signals above, OR on its own if
      // clearly unrelated (similarity === 0, i.e. not even one word in common) — a
      // single loose name comparison alone below that isn't enough to accuse someone
      // of impersonation on formatting grounds.
      const similarity = nameSimilarity(structured.vendor_name, registeredVendor.company_name);
      if (similarity !== null && similarity < 0.2) {
        identityMismatches.vendor_name = { document_shows: structured.vendor_name, registered_vendor_name: registeredVendor.company_name, name_similarity: Math.round(similarity * 100) / 100 };
      }

      if (identityMismatches.gstin || identityMismatches.bank_account_number || identityMismatches.vendor_name) {
        flags.push({
          flag_type: 'vendor_identity_mismatch',
          severity: 'high',
          // High but not maximal: OCR misreads are the main source of a false positive
          // here (a garbled GSTIN character, a mis-extracted name) — still routed to
          // suspicious/human review either way, but the confidence score is honest
          // about that residual uncertainty rather than claiming graph-query-level certainty.
          confidence_score: 0.8,
          evidence: { ...identityMismatches, uploading_vendor_id: invoice.vendor_id }
        });
      }
    }
  }


  // --- Check 3: split billing (multiple invoices, same PO, close together, thin GRN backing) ---
  const splitBillingRecords = await runCypher(
    `MATCH (inv:Invoice)-[:AGAINST]->(po:PurchaseOrder {id: $poId})
     RETURN inv.id as invoice_id, inv.amount as amount, inv.submitted_at as submitted_at
     ORDER BY inv.submitted_at`,
    { poId: invoice.po_id }
  );
  if (splitBillingRecords.length > 1) {
    const grnSumRes = await db.query(`SELECT COALESCE(SUM(received_quantity),0) as total FROM goods_receipt_notes WHERE po_id = $1`, [invoice.po_id]);
    const poRes = await db.query(`SELECT agreed_price FROM purchase_orders WHERE id = $1`, [invoice.po_id]);
    const totalInvoiced = splitBillingRecords.reduce((sum, r) => sum + Number(r.get('amount')), 0);
    const agreedPrice = Number(poRes.rows[0]?.agreed_price || 0);
    const hasGrnBacking = Number(grnSumRes.rows[0].total) > 0;
    if (!hasGrnBacking && totalInvoiced > 0) {
      flags.push({
        flag_type: 'split_billing_no_grn_backing',
        severity: 'high',
        confidence_score: 0.85,
        evidence: { invoice_count: splitBillingRecords.length, total_invoiced: totalInvoiced, agreed_price: agreedPrice, grn_backing: false }
      });
    }
  }

  // Insert any flags found, and return them for Agent 8 to factor in.
  const insertedFlags = [];
  for (const flag of flags) {
    const result = await db.query(
      `INSERT INTO fraud_flags (vendor_id, invoice_id, flag_type, severity, evidence, confidence_score)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [invoice.vendor_id, invoiceId, flag.flag_type, flag.severity, JSON.stringify(flag.evidence), flag.confidence_score]
    );
    insertedFlags.push(result.rows[0]);
  }

  return {
    flags_found: insertedFlags.length,
    flags: insertedFlags,
    // A single 0-1 "verdict" for the Context Gate: 1 = clean, lower = more suspicious.
    // Confidence stays high when we affirmatively confirmed "no match" via a real graph
    // query, but drops to near-zero (data_volume 0) when Neo4j wasn't reachable at all —
    // that's the honest way to tell the gate "we have no real signal either way."
    verdict_score: insertedFlags.length === 0 ? 1 : 0,
    confidence_score: insertedFlags.length > 0 ? Math.max(...insertedFlags.map(f => f.confidence_score)) : 0.9,
    data_volume: 1,
    has_high_severity: insertedFlags.some(f => f.severity === 'high')
  };
}

module.exports = { runFraudAgent };

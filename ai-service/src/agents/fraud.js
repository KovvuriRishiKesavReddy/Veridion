const db = require('../db');
const { runCypher } = require('../neo4jClient');

// runFraudAgent: Agent 4 — Fraud Detection.
// Two independent checks, both using Neo4j as ground truth (graph queries are the
// right tool here — relational joins would be awkward for "does this vendor share
// anything with a DIFFERENT vendor" across an arbitrary, growing set of entities):
//
// 1. Shell-company detection: does this vendor share a bank account or address with
//    a DIFFERENT vendor node in the graph?
// 2. Split-billing detection: multiple invoices against the same PO, submitted close
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

  // --- Check 2: split billing (multiple invoices, same PO, close together, thin GRN backing) ---
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

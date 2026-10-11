// Shared invoice/dispute housekeeping, used by invoices.js (pay / withdraw) and
// grnCorrections.js (an approved GRN correction removes the invoices that were verified
// against the wrong goods receipt).

// closeDisputesFor: when an invoice leaves the dispute path, every still-open dispute on it --
// sent, or still an unsent draft -- is CLOSED (resolved = true) with a closed_reason
// ('payment', 'withdrawn', 'verified'), never deleted: message history and the record that a
// dispute existed are kept. Deliberately NOT a "resolution": it never calls the vendor-risk
// dispute-resolved update and records no resolution time, so no score or metric changes.
// `q` is a pg client or the pool.
async function closeDisputesFor(q, invoiceId, reason, userId = null) {
  await q.query(
    `UPDATE vendor_communications
     SET resolved = true, resolved_at = now(), resolved_by = $2, closed_reason = $3
     WHERE invoice_id = $1 AND resolved = false`,
    [invoiceId, userId, reason]
  );
}

// removeInvoiceRecord: the shared "this invoice is going away" sequence, in the order it must
// run: close its disputes (invoice_id is nulled by the delete, so first), snapshot the invoice
// details onto its fraud flags (same reason), then delete it.
async function removeInvoiceRecord(q, invoiceId) {
  await closeDisputesFor(q, invoiceId, 'withdrawn');
  await q.query(
    `UPDATE fraud_flags ff
     SET invoice_number_snapshot = COALESCE(ff.invoice_number_snapshot, inv.invoice_number),
         invoice_ref_snapshot = COALESCE(ff.invoice_ref_snapshot, inv.id),
         invoice_amount_snapshot = COALESCE(ff.invoice_amount_snapshot, inv.invoice_amount)
     FROM invoices inv WHERE inv.id = ff.invoice_id AND ff.invoice_id = $1`, [invoiceId]);
  await q.query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);
}

// grnCorrectionPending: is a GRN correction request open on this PO? While one is, payment of
// any invoice on the PO is on hold -- it would be paying against receipts that may be voided.
async function grnCorrectionPending(q, poId) {
  const r = await q.query(`SELECT 1 FROM grn_correction_requests WHERE po_id = $1 AND status = 'pending' LIMIT 1`, [poId]);
  return r.rows.length > 0;
}

module.exports = { closeDisputesFor, removeInvoiceRecord, grnCorrectionPending };

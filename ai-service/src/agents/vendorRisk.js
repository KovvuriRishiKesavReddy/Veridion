const db = require('../db');

// updateVendorMetric: the exact running-average formula from the spec.
// new_value = (old_value * old_data_volume + this_event_value) / (old_data_volume + 1)
// new_data_volume = old_data_volume + 1
// this_event_value is 100 for a "good" outcome, 0 for "bad" — data_volume increases by
// exactly 1 regardless of good/bad, since it tracks how much evidence exists, not how
// good the vendor is. Scoped to (company_id, vendor_id) — one company's experience with
// a vendor never affects what another company sees (Part 5.7.1's isolation principle).
//
// exactCounters (optional): { countColumn, successColumn } — when given, ALSO
// increments these two columns atomically in the same update: countColumn always by
// 1, successColumn by 1 only when eventValue is a "good" (100) outcome. This exists
// purely so quotation ranking can read an EXACT per-metric event/success count
// (grn_count/grn_on_time_count, invoice_decision_count/invoice_decision_success_count)
// instead of reconstructing an estimate from the shared data_volume above — it has no
// effect on data_volume or the metric average itself, which remain exactly as spec'd.
async function updateVendorMetric(companyId, vendorId, metricName, eventValue, exactCounters = null) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const existingRes = await client.query(
      `SELECT * FROM vendor_risk_scores WHERE company_id = $1 AND vendor_id = $2 FOR UPDATE`,
      [companyId, vendorId]
    );
    let row = existingRes.rows[0];

    if (!row) {
      // First-ever event for this (company, vendor) pair — data_volume starts at 0,
      // no fabricated default score. This is the cold-start-by-design principle: a
      // brand-new relationship has genuinely zero evidence until a real event happens.
      const insertRes = await client.query(
        `INSERT INTO vendor_risk_scores (company_id, vendor_id, data_volume, platform_verified_event_count)
         VALUES ($1,$2,0,0) RETURNING *`,
        [companyId, vendorId]
      );
      row = insertRes.rows[0];
    }

    const oldValue = row[metricName] != null ? Number(row[metricName]) : null;
    const oldDataVolume = Number(row.data_volume);
    const newValue = oldValue === null
      ? eventValue // first event for this metric specifically: no prior value to average with
      : (oldValue * oldDataVolume + eventValue) / (oldDataVolume + 1);
    const newDataVolume = oldDataVolume + 1;

    // Column names here come only from the fixed whitelist callers below pass in
    // (never from request input), so building this fragment is safe.
    const exactCounterSet = exactCounters
      ? `, ${exactCounters.countColumn} = ${exactCounters.countColumn} + 1, ${exactCounters.successColumn} = ${exactCounters.successColumn} + ${eventValue === 100 ? 1 : 0}`
      : '';

    const updateRes = await client.query(
      `UPDATE vendor_risk_scores
       SET ${metricName} = $1, data_volume = $2, platform_verified_event_count = platform_verified_event_count + 1, last_updated = now()${exactCounterSet}
       WHERE company_id = $3 AND vendor_id = $4 RETURNING *`,
      [newValue, newDataVolume, companyId, vendorId]
    );

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// onGrnConfirmed: fires the moment a GRN is recorded. onTime = received_date compared
// to the PO's agreed_delivery_date.
async function onGrnConfirmed(poId, grnId) {
  const poRes = await db.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]);
  const po = poRes.rows[0];
  if (!po) throw new Error(`PO ${poId} not found`);

  const grnRes = await db.query(`SELECT * FROM goods_receipt_notes WHERE id = $1`, [grnId]);
  const grn = grnRes.rows[0];
  if (!grn) throw new Error(`GRN ${grnId} not found`);

  const onTime = !po.agreed_delivery_date || grn.received_date <= po.agreed_delivery_date;
  return updateVendorMetric(po.company_id, po.vendor_id, 'on_time_delivery_pct', onTime ? 100 : 0, { countColumn: 'grn_count', successColumn: 'grn_on_time_count' });
}

// onInvoiceDecisionFinalised: fires from Agent 8 after every decision (and again from
// the backend's override-and-pay route, with finalDecision effectively forced to
// 'auto_approved', as a corrective event when Finance overturns a flagged decision).
// accuracy is "good" whenever the Context Gate did NOT flag/reject the invoice.
async function onInvoiceDecisionFinalised(invoiceId, finalDecision) {
  const invRes = await db.query(
    `SELECT inv.*, po.company_id FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id WHERE inv.id = $1`,
    [invoiceId]
  );
  const invoice = invRes.rows[0];
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  const wasAccurate = finalDecision === 'auto_approved';
  return updateVendorMetric(invoice.company_id, invoice.vendor_id, 'invoice_accuracy_pct', wasAccurate ? 100 : 0, { countColumn: 'invoice_decision_count', successColumn: 'invoice_decision_success_count' });
}

// onDisputeResolved: not wired to anything yet — the dispute/vendor_communications
// flow is Flow 4 territory. This exists now so Flow 4 can call it directly without
// touching Agent 5's logic at all, exactly as the build doc stages it.
async function onDisputeResolved(companyId, vendorId, wasDisputed) {
  return updateVendorMetric(companyId, vendorId, 'dispute_rate', wasDisputed ? 0 : 100);
}

// legacyImport: one-time seeding of a company's own offline history with a vendor,
// per Part 5.7.1. Only allowed when NO vendor_risk_scores row exists yet for this
// (company_id, vendor_id) pair -- the moment any real event happens, this option must
// disappear permanently (enforced here by SELECT ... FOR UPDATE inside a transaction,
// which also serializes two concurrent legacy-import attempts for the same pair; the
// UNIQUE(company_id, vendor_id) constraint on legacy_vendor_imports is the second,
// independent guard -- belt and suspenders).
//
// The discount: data_volume_stored = min(floor(reported_transactions / 2), CAP). CAP
// is a named constant (not a magic number) because it's a policy decision, not a
// technical limit -- see the comment on the constant itself for the reasoning.
const LEGACY_IMPORT_DATA_VOLUME_CAP = 12; // log(1+data_volume) plateaus meaningfully
// past ~12-15 -- this bounds an unverified claim, no matter how large, to roughly the
// trust level of a moderately-proven vendor, never competitive with genuine platform
// history at real scale (log(1+30) already exceeds log(1+CAP) for any CAP <= 12).
//
// Also seeds the EXACT ranking counters from 012_exact_success_counters.sql, not just
// data_volume/on_time_delivery_pct. rankQuotations.js's Past Performance signal does
// NOT read data_volume -- it reads grn_on_time_count + invoice_decision_success_count
// specifically, because data_volume mixes GRN/invoice/dispute events into one number
// that can't be reliably split apart for ranking. Leaving these at 0 would make a
// legacy-imported vendor rank exactly like a brand-new vendor with zero history in
// Quotation Comparison -- silently defeating the feature in the one place (Part
// 3.3.1) it was most meant to help.
async function legacyImport(companyId, vendorId, importedBy, reported) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const existingRes = await client.query(
      `SELECT id FROM vendor_risk_scores WHERE company_id = $1 AND vendor_id = $2 FOR UPDATE`,
      [companyId, vendorId]
    );
    if (existingRes.rows[0]) {
      await client.query('ROLLBACK');
      const err = new Error('This vendor already has platform history with your company — legacy import is only available before any real activity exists.');
      err.status = 409;
      throw err;
    }

    const dataVolume = Math.min(
      Math.floor(reported.transactionCount / 2),
      LEGACY_IMPORT_DATA_VOLUME_CAP
    );

    // Approximate the exact ranking counters from the reported percentage -- necessarily
    // an estimate, since legacy import has no per-event breakdown to draw an exact count
    // from. Attributed entirely to the GRN/delivery counters (grn_count, grn_on_time_count)
    // since a company's "known offline history" most plausibly reflects delivery
    // reliability rather than invoice-decision history specifically. If the company also
    // supplied invoice_accuracy_pct, mirror the same dataVolume into the invoice counters
    // too -- this double-counts dataVolume across both metrics for ranking purposes, which
    // is acceptable here since the whole figure is already a labeled approximation, not
    // exact evidence.
    const approxOnTimeCount = Math.round(dataVolume * (reported.onTimePct / 100));
    const approxInvoiceSuccessCount = reported.invoiceAccuracyPct != null
      ? Math.round(dataVolume * (reported.invoiceAccuracyPct / 100))
      : 0;
    const invoiceDecisionCount = reported.invoiceAccuracyPct != null ? dataVolume : 0;

    const inserted = await client.query(
      `INSERT INTO vendor_risk_scores
         (company_id, vendor_id, score, on_time_delivery_pct, dispute_rate,
          invoice_accuracy_pct, data_volume, data_source, platform_verified_event_count,
          grn_count, grn_on_time_count, invoice_decision_count, invoice_decision_success_count)
       VALUES ($1,$2,$3,$3,$4,$5,$6,'self_reported',0,$6,$7,$8,$9) RETURNING *`,
      // Note: `score` and `on_time_delivery_pct` both take reported.onTimePct here --
      // mirrors how updateVendorMetric treats these as the same running-average field.
      // grn_count is set equal to dataVolume (not halved-and-capped again) -- dataVolume
      // IS the already-discounted figure at this point, and grn_count should track "how
      // many delivery events does ranking believe happened," which is exactly that same
      // discounted number, not a second independent count.
      [
        companyId, vendorId, reported.onTimePct, reported.disputeRate ?? null,
        reported.invoiceAccuracyPct ?? null, dataVolume,
        approxOnTimeCount, invoiceDecisionCount, approxInvoiceSuccessCount
      ]
    );

    await client.query(
      `INSERT INTO legacy_vendor_imports
         (company_id, vendor_id, imported_by, reported_transaction_count, reported_on_time_pct,
          reported_dispute_rate, reported_invoice_accuracy_pct, stored_data_volume,
          justification, confirmed_unverified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [companyId, vendorId, importedBy, reported.transactionCount, reported.onTimePct,
        reported.disputeRate ?? null, reported.invoiceAccuracyPct ?? null, dataVolume, reported.justification]
    );

    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { updateVendorMetric, onGrnConfirmed, onInvoiceDecisionFinalised, onDisputeResolved, legacyImport };

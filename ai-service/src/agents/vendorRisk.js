const db = require('../db');

// updateVendorMetrics: the running-average formula from the spec, for N metrics observed from
// the SAME underlying event (one GRN tells you both on-time-ness and quality).
//
// Default per metric (every pre-existing caller): new_value = (old_value * old_data_volume +
// this_event_value) / (old_data_volume + 1), i.e. weight 1 per event against data_volume.
// this_event_value is 100 for a "good" outcome, 0 for "bad".
//
// data_volume and platform_verified_event_count increment exactly ONCE for the whole call, never
// once per metric and never affected by a metric's custom weight: they mean "how much evidence
// exists" (Agent 8's Context Gate reads data_volume directly), and one GRN is one piece of
// evidence however many things it tells us.
//
// A metric may instead pass its OWN { weight, weightColumn }: its running average is then
// weighted by `weight` (e.g. units received) against its OWN accumulator column, leaving
// data_volume's meaning untouched. quality_score uses this so a 60-unit Excellent delivery
// outweighs a 40-unit Very Poor one.
//
// Scoped to (company_id, vendor_id) -- one company's experience with a vendor never affects
// what another company sees (Part 5.7.1's isolation principle).
//
// weightFromColumn (optional, per metric): the column whose CURRENT value is how many events this
// metric's running average already stands for (e.g. invoice_decision_count for invoice_accuracy_pct,
// grn_count for on_time_delivery_pct). Without it the old value is weighted by the SHARED data_volume,
// which counts every kind of event (GRNs, invoices, disputes, the legacy-import placeholder), so a
// metric with few events of its own got averaged as if it had many: a legacy-imported vendor (data_volume
// 12, no invoice accuracy supplied) whose first invoice was flagged and second was good ended at
// (0 x 13 + 100) / 14 = 7% instead of 1 good of 2 = 50%. Reading the metric's own exact counter
// (already kept for ranking, and seeded by legacyImport) fixes that. data_volume itself is unchanged:
// it is still the overall "how much evidence" figure the Context Gate and ranking use for confidence.
//
// exactCounters (optional, per metric): { countColumn, successColumn } -- ALSO increments these
// two columns atomically: countColumn always by 1, successColumn by 1 only when eventValue is a
// "good" (100) outcome. This exists so quotation ranking can read an EXACT per-metric count
// (grn_count/grn_on_time_count, invoice_decision_count/invoice_decision_success_count) instead
// of an estimate from the shared data_volume.
async function updateVendorMetrics(companyId, vendorId, metrics) {
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

    const oldDataVolume = Number(row.data_volume);
    const newDataVolume = oldDataVolume + 1; // ONE increment for the whole event, always

    // Column names here come only from the fixed whitelist callers below pass in (never from
    // request input), so building these fragments is safe.
    const setClauses = [];
    const params = [];
    for (const m of metrics) {
      const weight = m.weight != null ? Number(m.weight) : 1;
      const oldWeight = m.weightColumn ? (Number(row[m.weightColumn]) || 0)
        : m.weightFromColumn ? (Number(row[m.weightFromColumn]) || 0)
        : oldDataVolume;
      const newWeight = oldWeight + weight;
      const oldValue = row[m.name] != null ? Number(row[m.name]) : null;
      // First event for this metric specifically: no prior value to average with. A zero total
      // weight (e.g. a 0-quantity GRN as a metric's first event) falls back to the raw value.
      const newValue = oldValue === null || newWeight <= 0
        ? m.eventValue
        : (oldValue * oldWeight + m.eventValue * weight) / newWeight;
      params.push(newValue);
      setClauses.push(`${m.name} = $${params.length}`);
      if (m.weightColumn) {
        params.push(newWeight);
        setClauses.push(`${m.weightColumn} = $${params.length}`);
      }
      if (m.exactCounters) {
        setClauses.push(`${m.exactCounters.countColumn} = ${m.exactCounters.countColumn} + 1`);
        setClauses.push(`${m.exactCounters.successColumn} = ${m.exactCounters.successColumn} + ${m.eventValue === 100 ? 1 : 0}`);
      }
    }
    params.push(newDataVolume);
    setClauses.push(`data_volume = $${params.length}`);
    setClauses.push(`platform_verified_event_count = platform_verified_event_count + 1`);
    setClauses.push(`last_updated = now()`);
    params.push(companyId, vendorId);

    const updateRes = await client.query(
      `UPDATE vendor_risk_scores SET ${setClauses.join(', ')}
       WHERE company_id = $${params.length - 1} AND vendor_id = $${params.length} RETURNING *`,
      params
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

// updateVendorMetric: unchanged signature, now a thin wrapper -- every existing caller
// (onInvoiceDecisionFinalised, onDisputeResolved, legacyImport) keeps working exactly as
// before: one metric, weight 1 via data_volume, zero behavior change.
async function updateVendorMetric(companyId, vendorId, metricName, eventValue, exactCounters = null) {
  return updateVendorMetrics(companyId, vendorId, [{ name: metricName, eventValue, exactCounters }]);
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

  // Maps the 1-5 rating onto the same 0-100 scale every other metric uses:
  // 1 (Very Poor) -> 0, 2 -> 25, 3 (Neutral) -> 50, 4 -> 75, 5 (Excellent) -> 100.
  const qualityEventValue = (Number(grn.quality_rating) - 1) * 25;
  const receivedQty = Number(grn.received_quantity);

  return updateVendorMetrics(po.company_id, po.vendor_id, [
    { name: 'on_time_delivery_pct', eventValue: onTime ? 100 : 0, weightFromColumn: 'grn_count', exactCounters: { countColumn: 'grn_count', successColumn: 'grn_on_time_count' } },
    // Quality is weighted by units received (a 60-unit Excellent delivery outweighs a 40-unit
    // Very Poor one), not one flat vote per delivery. No exactCounters: quality isn't binary, so
    // forcing a "success count" onto it would throw away the Good-vs-Excellent distinction.
    { name: 'quality_score', eventValue: qualityEventValue, weight: receivedQty, weightColumn: 'quality_weighted_units' }
  ]);
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
  // Weighted by invoice_decision_count (this metric's own event count), so the accuracy is
  // "good decisions / all decisions on the platform" (plus a legacy figure at its discounted weight,
  // if one was supplied) -- not diluted by GRNs, disputes or the legacy placeholder in data_volume.
  return updateVendorMetrics(invoice.company_id, invoice.vendor_id, [
    { name: 'invoice_accuracy_pct', eventValue: wasAccurate ? 100 : 0, weightFromColumn: 'invoice_decision_count', exactCounters: { countColumn: 'invoice_decision_count', successColumn: 'invoice_decision_success_count' } }
  ]);
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

module.exports = { updateVendorMetric, updateVendorMetrics, onGrnConfirmed, onInvoiceDecisionFinalised, onDisputeResolved, legacyImport };

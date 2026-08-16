const db = require('../db');

// updateVendorMetric: the exact running-average formula from the spec.
// new_value = (old_value * old_data_volume + this_event_value) / (old_data_volume + 1)
// new_data_volume = old_data_volume + 1
// this_event_value is 100 for a "good" outcome, 0 for "bad" — data_volume increases by
// exactly 1 regardless of good/bad, since it tracks how much evidence exists, not how
// good the vendor is. Scoped to (company_id, vendor_id) — one company's experience with
// a vendor never affects what another company sees (Part 5.7.1's isolation principle).
async function updateVendorMetric(companyId, vendorId, metricName, eventValue) {
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

    const updateRes = await client.query(
      `UPDATE vendor_risk_scores
       SET ${metricName} = $1, data_volume = $2, platform_verified_event_count = platform_verified_event_count + 1, last_updated = now()
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
  return updateVendorMetric(po.company_id, po.vendor_id, 'on_time_delivery_pct', onTime ? 100 : 0);
}

// onInvoiceDecisionFinalised: fires from Agent 8 after every decision. accuracy is
// "good" whenever the Context Gate did NOT flag/reject the invoice.
async function onInvoiceDecisionFinalised(invoiceId, finalDecision) {
  const invRes = await db.query(
    `SELECT inv.*, po.company_id FROM invoices inv JOIN purchase_orders po ON po.id = inv.po_id WHERE inv.id = $1`,
    [invoiceId]
  );
  const invoice = invRes.rows[0];
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  const wasAccurate = finalDecision === 'auto_approved';
  return updateVendorMetric(invoice.company_id, invoice.vendor_id, 'invoice_accuracy_pct', wasAccurate ? 100 : 0);
}

// onDisputeResolved: not wired to anything yet — the dispute/vendor_communications
// flow is Flow 4 territory. This exists now so Flow 4 can call it directly without
// touching Agent 5's logic at all, exactly as the build doc stages it.
async function onDisputeResolved(companyId, vendorId, wasDisputed) {
  return updateVendorMetric(companyId, vendorId, 'dispute_rate', wasDisputed ? 0 : 100);
}

module.exports = { updateVendorMetric, onGrnConfirmed, onInvoiceDecisionFinalised, onDisputeResolved };

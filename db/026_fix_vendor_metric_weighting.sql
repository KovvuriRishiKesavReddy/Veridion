-- 026_fix_vendor_metric_weighting.sql
--
-- One-time repair of vendor_risk_scores.invoice_accuracy_pct and on_time_delivery_pct for rows
-- written by the OLD weighting. Until now each running average weighted its previous value by the
-- shared data_volume (every GRN, invoice, dispute and the legacy-import placeholder), not by that
-- metric's own number of events, so e.g. a legacy-imported vendor (data_volume 12) with one flagged
-- invoice followed by one good invoice showed 7% accuracy instead of 50%.
-- The code now weights each metric by its own exact counter (invoice_decision_count / grn_count);
-- this file recomputes the stored values from those same counters, which were always correct.
--
--   invoice accuracy = ( legacy_accuracy x legacy_events  +  100 x platform_good_decisions ) / invoice_decision_count
--   on-time          = ( legacy_on_time  x legacy_events  +  100 x platform_on_time_GRNs     ) / grn_count
--
-- legacy_events is legacy_vendor_imports.stored_data_volume (0 for invoice accuracy when no accuracy
-- was reported); the legacy "good" counts are the same rounded estimates legacyImport stored in the
-- counters, so they are subtracted back out to get the platform-only part. Vendors with no legacy
-- import reduce to plain good / total. Only rows that already have events for that metric are touched;
-- data_volume and the counters are never modified, so this is safe to run twice (it just recomputes
-- the same numbers).

UPDATE vendor_risk_scores v
SET invoice_accuracy_pct = calc.pct
FROM (
  SELECT v2.id,
         ( COALESCE(l.reported_invoice_accuracy_pct, 0) * lc.legacy_events
           + 100.0 * (v2.invoice_decision_success_count - lc.legacy_good) ) / v2.invoice_decision_count AS pct
  FROM vendor_risk_scores v2
  LEFT JOIN legacy_vendor_imports l ON l.company_id = v2.company_id AND l.vendor_id = v2.vendor_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN l.reported_invoice_accuracy_pct IS NOT NULL THEN l.stored_data_volume ELSE 0 END AS legacy_events,
           CASE WHEN l.reported_invoice_accuracy_pct IS NOT NULL
                THEN ROUND(l.stored_data_volume * l.reported_invoice_accuracy_pct / 100.0) ELSE 0 END AS legacy_good
  ) lc
  WHERE v2.invoice_decision_count > 0
) calc
WHERE v.id = calc.id;

UPDATE vendor_risk_scores v
SET on_time_delivery_pct = calc.pct
FROM (
  SELECT v2.id,
         ( COALESCE(l.reported_on_time_pct, 0) * lc.legacy_events
           + 100.0 * (v2.grn_on_time_count - lc.legacy_good) ) / v2.grn_count AS pct
  FROM vendor_risk_scores v2
  LEFT JOIN legacy_vendor_imports l ON l.company_id = v2.company_id AND l.vendor_id = v2.vendor_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(l.stored_data_volume, 0) AS legacy_events,
           COALESCE(ROUND(l.stored_data_volume * l.reported_on_time_pct / 100.0), 0) AS legacy_good
  ) lc
  WHERE v2.grn_count > 0
) calc
WHERE v.id = calc.id;

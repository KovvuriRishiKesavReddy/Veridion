-- Veridion Flow 5: Legacy Vendor Import + platform-wide aggregate.
--
-- vendor_risk_scores already has data_source, platform_verified_event_count, and a
-- company-scoped UNIQUE(company_id, vendor_id) from 003_vendor_risk.sql -- nothing to
-- add there. This migration adds:
-- 1. An audit trail for legacy imports (who imported what, and what was actually
--    claimed vs. what was stored after the halve-and-cap discount -- both numbers
--    matter for an honest audit, since the discount itself should be inspectable).
-- 2. A read-only view aggregating ONLY platform_verified_event_count-backed history
--    across companies, for a vendor's own dashboard and for a new company evaluating
--    an unfamiliar vendor. Self-reported data is structurally excluded, not just
--    filtered by convention, since it's a VIEW definition, not application logic.
CREATE TABLE legacy_vendor_imports (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  imported_by INTEGER NOT NULL REFERENCES users(id),
  reported_transaction_count INTEGER NOT NULL,
  reported_on_time_pct NUMERIC NOT NULL,
  reported_dispute_rate NUMERIC,
  reported_invoice_accuracy_pct NUMERIC,
  stored_data_volume INTEGER NOT NULL, -- the halved-and-capped value actually applied
  justification TEXT NOT NULL,
  confirmed_unverified BOOLEAN NOT NULL, -- the required checkbox, stored as evidence it was shown/checked
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id) -- one-time seeding only, matches the 409-on-existing-row rule in vendorRisk.js
);
CREATE INDEX idx_legacy_vendor_imports_vendor_id ON legacy_vendor_imports(vendor_id);

-- Read-only aggregate. Deliberately built ONLY from platform_verified_event_count and
-- the metrics it backs -- never from data_source = 'self_reported' rows or their
-- data_volume. If a self-reported figure leaked in here, one company's unverified
-- claim would contaminate every other company's and the vendor's own view of a
-- platform-wide number -- exactly the cross-company contamination problem the
-- (company_id, vendor_id) isolation was built to prevent, one level up.
--
-- aggregate_on_time_pct weights each company's row by its own grn_count (the exact
-- counter from 012_exact_success_counters.sql), not a flat average across companies --
-- a company with 40 real deliveries and a company with 2 shouldn't count equally
-- toward the vendor's platform-wide on-time percentage.
CREATE VIEW vendor_platform_summary AS
SELECT
  vendor_id,
  SUM(platform_verified_event_count) AS total_platform_verified_events,
  CASE
    WHEN SUM(platform_verified_event_count) > 0 THEN
      SUM(COALESCE(on_time_delivery_pct, 0) * grn_count) / NULLIF(SUM(grn_count), 0)
    ELSE NULL
  END AS aggregate_on_time_pct,
  COUNT(DISTINCT company_id) FILTER (WHERE platform_verified_event_count > 0) AS num_companies_worked_with,
  MAX(last_updated) AS last_updated
FROM vendor_risk_scores
GROUP BY vendor_id;

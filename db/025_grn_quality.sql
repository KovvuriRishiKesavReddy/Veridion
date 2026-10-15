-- 025: per-GRN delivery quality rating (1-5), entered by the warehouse team on every GRN,
-- plus a quantity-weighted vendor-level rollup used as a 4th signal in quotation ranking.

-- Nullable first: goods_receipt_notes may already have rows, and a NOT NULL column can't be
-- added directly to a table that has data without a default.
ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS quality_rating SMALLINT CHECK (quality_rating BETWEEN 1 AND 5);
ALTER TABLE goods_receipt_notes ADD COLUMN IF NOT EXISTS quality_notes TEXT;

-- Backfill pre-existing rows to a neutral 3, clearly labeled as retroactive rather than a real
-- rating, so old rows don't silently look like someone actually chose "Neutral" for them.
-- (These backfilled rows are NOT rolled into vendor_risk_scores.quality_score below.)
UPDATE goods_receipt_notes
SET quality_rating = 3,
    quality_notes = COALESCE(quality_notes, '') || ' [backfilled: no quality rating existed before this migration]'
WHERE quality_rating IS NULL;

-- Now safe to enforce: every GRN from this point on must carry a real rating.
ALTER TABLE goods_receipt_notes ALTER COLUMN quality_rating SET NOT NULL;

-- Vendor-level rollup, same nullable-until-first-event convention as on_time_delivery_pct and
-- invoice_accuracy_pct. quality_score is weighted by how many units each GRN delivered, so a
-- 60-unit Excellent delivery and a 40-unit Very Poor one land at 60, not a flat 50.
ALTER TABLE vendor_risk_scores ADD COLUMN IF NOT EXISTS quality_score NUMERIC;

-- Its OWN weight accumulator, deliberately separate from data_volume (which must keep meaning
-- "how many events happened": Agent 8's Context Gate reads it as an evidence count).
ALTER TABLE vendor_risk_scores ADD COLUMN IF NOT EXISTS quality_weighted_units NUMERIC NOT NULL DEFAULT 0;

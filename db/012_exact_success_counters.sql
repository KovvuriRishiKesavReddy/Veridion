-- Adds EXACT per-metric event/success counters, purely additive alongside the existing
-- spec'd fields (data_volume, on_time_delivery_pct, invoice_accuracy_pct) — those stay
-- completely untouched and continue driving Agent 8's decision math exactly as before
-- (per Part 5.5's pseudocode, data_volume is deliberately one shared counter across
-- every metric; changing that would be a real spec deviation with system-wide effect,
-- not a bug fix).
--
-- What this actually fixes: rankQuotations.js's "estimated successful deals" for Past
-- Performance had to approximate a per-metric event count from the shared data_volume
-- (Math.round(data_volume * success_rate)), because data_volume mixes GRN events,
-- invoice-decision events, and resolved disputes into one number. These new columns
-- track the two metrics ranking actually blends (on-time delivery, invoice accuracy)
-- with their own honest, separate counts, so ranking can use an EXACT number instead
-- of a reconstructed guess.
ALTER TABLE vendor_risk_scores
  ADD COLUMN grn_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN grn_on_time_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN invoice_decision_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN invoice_decision_success_count INTEGER NOT NULL DEFAULT 0;

-- Deliberately NOT backfilled from existing data_volume/percentage history: since
-- data_volume is a single counter shared across GRN, invoice, and dispute events
-- combined, there is no way to know how much of an existing row's data_volume came
-- from GRNs specifically versus invoice decisions specifically — any reconstruction
-- would be a guess layered on top of the estimate this migration is meant to replace,
-- and can even produce a mathematically inconsistent result (e.g. more "successes"
-- than total recorded events). Starting these at 0 is the honest choice: every event
-- from this point forward is tracked exactly; a vendor's pre-existing history keeps
-- driving the actual DECISION engine (Agent 8) at full, undiminished weight the whole
-- time (that logic is untouched) — only the ranking-specific "successful deals"
-- estimate starts counting fresh and converges to full precision as real events
-- accumulate.

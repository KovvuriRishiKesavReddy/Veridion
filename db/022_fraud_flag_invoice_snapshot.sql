-- Fraud flags must keep showing which invoice they were raised on even after that invoice is
-- withdrawn (deleted): fraud_flags.invoice_id is ON DELETE SET NULL, so the Platform Admin's
-- Fraud Review Queue lost the invoice number the moment a vendor withdrew and resubmitted.
-- Same fix as migration 010 applied to disputes: snapshot the invoice details onto the flag.
ALTER TABLE fraud_flags
  ADD COLUMN invoice_number_snapshot TEXT,
  ADD COLUMN invoice_ref_snapshot INTEGER,
  ADD COLUMN invoice_amount_snapshot NUMERIC;

-- Backfill every flag whose invoice still exists. (Flags whose invoice was ALREADY withdrawn
-- before this migration have lost the link and cannot be recovered.)
UPDATE fraud_flags ff
SET invoice_number_snapshot = inv.invoice_number,
    invoice_ref_snapshot = inv.id,
    invoice_amount_snapshot = inv.invoice_amount
FROM invoices inv
WHERE inv.id = ff.invoice_id;

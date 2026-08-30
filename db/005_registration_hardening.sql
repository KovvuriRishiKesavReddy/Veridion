-- Veridion: registration hardening — company proof document, vendor PAN proof
-- document, and the override audit trail for Finance approving a flagged invoice.

ALTER TABLE companies ADD COLUMN registration_proof_path TEXT;
ALTER TABLE vendors ADD COLUMN pan_proof_path TEXT;

-- Matches the doc's own agent_overrides design (Part 2.3), scoped to invoices rather
-- than a generic decision, since that's the concrete override this system needs right
-- now: Finance approving payment on an invoice the Context Gate flagged, with a reason
-- on record for audit.
CREATE TABLE invoice_overrides (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  decision_id INTEGER REFERENCES decisions(id) ON DELETE SET NULL,
  overridden_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  overridden_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoice_overrides_invoice_id ON invoice_overrides(invoice_id);

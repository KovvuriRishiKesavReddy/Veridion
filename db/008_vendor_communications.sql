-- Veridion Flow 4: Vendor Communication (Agent 7) — the dispute flow.
-- A flagged (not suspicious/fraud — that already routes to Platform Admin) invoice
-- gets an AI-drafted, factual, non-accusatory dispute message the moment Agent 8
-- decides 'flagged'. Finance reviews/edits/sends it; the vendor sees it and can
-- respond; Finance marks it resolved, which feeds Agent 5's dispute_rate metric via
-- the already-existing (Flow 3) onDisputeResolved function.
--
-- vendor_id is denormalized here (also reachable via invoice_id -> invoices.vendor_id)
-- purely so vendor-scoped queries (GET /api/vendor-communications for the vendor's own
-- disputes.html) don't need a join through invoices for every listing — the same
-- convenience-denormalization pattern already used elsewhere (e.g. quotations storing
-- vendor_id directly rather than only via requirement).
CREATE TABLE vendor_communications (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  draft_text TEXT NOT NULL,
  mismatch_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending_send' CHECK (status IN ('pending_send', 'sent')),
  sent_by INTEGER REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  vendor_response TEXT,
  vendor_responded_at TIMESTAMPTZ,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolution_time_hours NUMERIC,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vendor_communications_invoice_id ON vendor_communications(invoice_id);
CREATE INDEX idx_vendor_communications_vendor_id ON vendor_communications(vendor_id);
CREATE INDEX idx_vendor_communications_status ON vendor_communications(status);

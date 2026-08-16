-- Veridion Flow 3: Vendor Risk Scoring (Agent 5) + Fraud Detection (Agent 4)

CREATE TABLE vendor_risk_scores (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  score NUMERIC,
  on_time_delivery_pct NUMERIC,
  dispute_rate NUMERIC,
  invoice_accuracy_pct NUMERIC,
  data_volume INTEGER NOT NULL DEFAULT 0,
  data_source TEXT NOT NULL DEFAULT 'platform_verified' CHECK (data_source IN ('platform_verified', 'self_reported')),
  platform_verified_event_count INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id)
);

CREATE TABLE fraud_flags (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  evidence JSONB,
  confidence_score NUMERIC,
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vendor_risk_scores_company_vendor ON vendor_risk_scores(company_id, vendor_id);
CREATE INDEX idx_fraud_flags_vendor_id ON fraud_flags(vendor_id);
CREATE INDEX idx_fraud_flags_invoice_id ON fraud_flags(invoice_id);
CREATE INDEX idx_fraud_flags_resolved ON fraud_flags(resolved);

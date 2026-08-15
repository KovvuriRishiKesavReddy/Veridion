-- Veridion Flow 2: AI verification pipeline schema
-- (OCR/Structuring, Semantic Matching, Compliance, and the Context Gate's decisions)

-- The original invoices table (Flow 1) had no quantity field at all — only a total
-- amount. Semantic Matching needs something to compare against the GRN's confirmed
-- quantity, so this adds what the vendor is actually billing for.
ALTER TABLE invoices ADD COLUMN invoice_quantity NUMERIC;

CREATE TABLE document_extractions (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  raw_ocr_text TEXT,
  structured_data JSONB,
  confidence_score NUMERIC,
  bounding_boxes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_checks (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  gst_valid BOOLEAN,
  gst_details JSONB,
  issues_found TEXT[],
  confidence_score NUMERIC,
  data_volume NUMERIC,
  gst_rate_used NUMERIC,
  gst_rate_reference_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE matching_results (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  po_match_score NUMERIC,
  grn_match_score NUMERIC,
  mismatch_fields JSONB,
  overall_match BOOLEAN,
  confidence_score NUMERIC,
  data_volume NUMERIC,
  issue_type TEXT NOT NULL DEFAULT 'mismatch' CHECK (issue_type IN ('informational', 'mismatch', 'fraud_suspect')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE decisions (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  agent_inputs JSONB,
  gate_weights JSONB,
  final_score NUMERIC,
  final_decision TEXT CHECK (final_decision IN ('auto_approved', 'flagged', 'suspicious')),
  reasoning_text TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_extractions_invoice_id ON document_extractions(invoice_id);
CREATE INDEX idx_compliance_checks_invoice_id ON compliance_checks(invoice_id);
CREATE INDEX idx_matching_results_invoice_id ON matching_results(invoice_id);
CREATE INDEX idx_decisions_invoice_id ON decisions(invoice_id);

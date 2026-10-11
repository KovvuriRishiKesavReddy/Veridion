-- GRN corrections: a goods receipt note is an audit record and is never edited or deleted, but
-- people make mistakes (e.g. "all goods received" entered by accident). Instead of a free-form
-- edit, a mistaken GRN goes through a SUPPORT-STYLE request: someone raises a correction request
-- with a reason, a different person reviews it, and an approval VOIDS the GRN (kept on the
-- record, struck from every total) so the correct receipt can then be entered fresh.
ALTER TABLE goods_receipt_notes
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN void_reason TEXT;

CREATE TABLE grn_correction_requests (
  id SERIAL PRIMARY KEY,
  grn_id INTEGER NOT NULL REFERENCES goods_receipt_notes(id) ON DELETE CASCADE,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name TEXT NOT NULL,
  requested_by_role TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_name TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_grn_correction_company ON grn_correction_requests(company_id, status);
CREATE INDEX idx_grn_correction_po ON grn_correction_requests(po_id);
-- One open request per GRN at a time.
CREATE UNIQUE INDEX one_pending_correction_per_grn ON grn_correction_requests(grn_id) WHERE status = 'pending';

-- Company registration now requires Platform Admin approval, mirroring the vendor
-- verification flow (verification_status on vendors). A company can register and its
-- company_admin gets a valid login immediately, but the company can't actually DO
-- anything on the platform (post requirements, invite teammates, accept quotations,
-- record GRNs, review invoices) until a Platform Admin approves it.
--
-- Existing companies (from any prior migrate/seed run before this migration existed)
-- are explicitly backfilled to 'approved' below — this migration must never silently
-- lock out companies that were already active on the platform. Only companies
-- registered AFTER this migration default to 'pending'.
ALTER TABLE companies
  ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));

UPDATE companies SET approval_status = 'approved';

CREATE INDEX idx_companies_approval_status ON companies(approval_status);
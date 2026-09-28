-- A company_admin clicking "Send Invite" repeatedly for the same email (before this
-- fix) created a brand-new invitations row with a brand-new token every time,
-- silently orphaning every link already copied/sent from an earlier click. The
-- application layer (routes/company.js POST /invite) now reuses the existing
-- pending row instead of inserting a new one, but this partial unique index is the
-- actual backstop against ever having two pending invitations open for the same
-- company+email at once — including under a race (two rapid clicks before the
-- first request's SELECT-then-insert completes). Scoped to status='pending' only,
-- so a person can always be re-invited later after an earlier invite was accepted.

-- Clean up any duplicates the bug already created before the index can be added —
-- CREATE UNIQUE INDEX fails outright if duplicates still exist. Keeps only the most
-- recently created pending row per company+email; marks the older ones 'expired'
-- (an existing, already-allowed status — see the CHECK constraint in
-- 001_core_schema.sql) rather than deleting them, consistent with this app's
-- general soft-delete-and-keep-history approach elsewhere (e.g. user deactivation).
UPDATE invitations
SET status = 'expired'
WHERE status = 'pending'
  AND id NOT IN (
    SELECT DISTINCT ON (company_id, invited_email) id
    FROM invitations
    WHERE status = 'pending'
    ORDER BY company_id, invited_email, created_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_unique
  ON invitations (company_id, invited_email)
  WHERE status = 'pending';

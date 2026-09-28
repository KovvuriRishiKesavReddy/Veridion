-- Permanent deletion of a removed team member (routes/company.js
-- DELETE /team/:userId/permanent).
--
-- 007_user_deactivation.sql explains why a plain row DELETE isn't always viable:
-- requirements.created_by, grn.recorded_by, invoice overrides, dispute messages etc.
-- all reference users(id) with no ON DELETE behaviour, so a member who ever did
-- anything on the platform can't have their row removed without destroying (or being
-- blocked by) the audit trail. The route therefore tries a real DELETE first (works
-- for anyone with no linked records) and, only if Postgres refuses with a
-- foreign-key violation, ERASES their personal details in place instead — name,
-- email, password hash — and stamps deleted_at so they vanish from the Team page.
-- Past records keep pointing at the row and simply show "Deleted user".
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

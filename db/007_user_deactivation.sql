-- 007_user_deactivation.sql
--
-- Adds team-member removal for Company Admin. A hard DELETE on users is not viable:
-- requirements.created_by, goods_receipt_notes.recorded_by, invitations.invited_by,
-- invoice_overrides.overridden_by, and companies.created_by all reference users(id)
-- with no ON DELETE behavior — the moment a team member has done ANYTHING (posted one
-- requirement, recorded one GRN, sent one invite), deleting their row would fail on a
-- foreign key violation. Even where it wouldn't fail, deleting the row would silently
-- corrupt historical records ("who actually recorded this GRN?" becomes unanswerable).
--
-- is_active is a soft-delete flag instead: a removed team member's row (and their
-- history) stays intact, but requireAuth rejects their token on every subsequent
-- request, and they no longer appear in the active team listing.
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX idx_users_is_active ON users(is_active);

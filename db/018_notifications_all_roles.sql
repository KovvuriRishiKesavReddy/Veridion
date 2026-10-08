-- Flow 6 extension: notifications for company roles and Platform Admin, not just vendors.
-- A notification now targets ONE of:
--   * a vendor            -> vendor_id set, company_id/target_role NULL
--   * a company role      -> company_id + target_role set ('procurement'/'finance'/'warehouse'/'company_admin')
--   * Platform Admin      -> target_role = 'platform_admin', vendor_id and company_id NULL
-- Read state for company/admin notifications is shared by everyone holding that role in
-- that company (e.g. all Finance users of a company see the same bell entries).
ALTER TABLE notifications ALTER COLUMN vendor_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_role TEXT;
ALTER TABLE notifications ADD CONSTRAINT notifications_has_recipient
  CHECK (vendor_id IS NOT NULL OR target_role IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_notifications_company_role ON notifications(company_id, target_role) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_admin_unread ON notifications(target_role) WHERE vendor_id IS NULL AND company_id IS NULL AND is_read = false;

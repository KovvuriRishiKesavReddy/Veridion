-- Veridion Flow 6 (replacement): persistent vendor notifications.
-- vendor_id-scoped, not company-scoped — a notification belongs to the vendor account
-- that needs to see it, independent of which company triggered it. related_id + related_type
-- let the frontend build a "View" link without needing a separate table per notification kind.
-- (Replaces the OmniDimension-era outbound_notifications table from 016, which is left in
-- place but no longer written to.)
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  type TEXT NOT NULL,          -- e.g. 'quotation_accepted', 'invoice_flagged', 'dispute_message' — open-ended, not a CHECK constraint, since new notification types will keep getting added as the system grows
  message TEXT NOT NULL,
  related_id INTEGER,          -- e.g. the quotation_id or po_id this notification is about
  related_type TEXT,           -- e.g. 'quotation', 'po' — tells the frontend which page to link to
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_vendor_id ON notifications(vendor_id);
CREATE INDEX IF NOT EXISTS idx_notifications_vendor_unread ON notifications(vendor_id) WHERE is_read = false;

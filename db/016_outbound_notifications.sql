-- Flow 6: automated vendor notification (OmniDimension voice call).
-- One row per notification attempt — an audit trail ("the vendor says they were never
-- told") and a reusable extension point for later notification types (payment
-- reminders, dispute alerts) without inventing a new table each time.
--
-- This table is written to AFTER the purchase order has already been committed, never
-- inside the PO-creation transaction, so a failure here can never affect PO creation.
CREATE TABLE IF NOT EXISTS outbound_notifications (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  reference_type TEXT NOT NULL,                    -- e.g. 'quotation_accepted'
  reference_id INTEGER NOT NULL,                   -- e.g. purchase_orders.id
  channel TEXT NOT NULL CHECK (channel IN ('voice_call','sms','whatsapp','app_only')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  provider_message_id TEXT,                        -- OmniDimension requestId on success
  error_message TEXT,                              -- why it failed / was skipped
  to_number TEXT,                                  -- normalised number actually dialled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbound_notifications_vendor ON outbound_notifications(vendor_id);
CREATE INDEX IF NOT EXISTS idx_outbound_notifications_reference ON outbound_notifications(reference_type, reference_id);

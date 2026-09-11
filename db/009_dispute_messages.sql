-- Veridion Flow 4 follow-up: a proper message thread for disputes, instead of a
-- single vendor_communications.vendor_response column that gets silently overwritten
-- every time the vendor replies. That was confusing for Finance — there was no way to
-- tell "the vendor edited their earlier response" from "the vendor sent a NEW,
-- separate message," and any earlier reply was simply gone once a second one arrived.
--
-- The old vendor_communications.vendor_response / vendor_responded_at columns are left
-- in place (not dropped, not altered) so nothing already stored is lost or broken —
-- they simply stop being written to going forward; new replies land here instead as
-- individual rows, and the UI renders both.
--
-- sender_role is included (not vendor-only) so this can carry Finance's own follow-up
-- messages later without another schema change, even though only the vendor writes to
-- it today.
CREATE TABLE dispute_messages (
  id SERIAL PRIMARY KEY,
  vendor_communication_id INTEGER NOT NULL REFERENCES vendor_communications(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('vendor', 'finance')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dispute_messages_vendor_communication_id ON dispute_messages(vendor_communication_id);

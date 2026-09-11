-- Enables a real two-way conversation on disputes (previously only the vendor could
-- send individual messages; Finance had no way to reply in the same thread). Adding
-- sender_name (captured at send time, same denormalized-snapshot pattern already used
-- for vendor_communications' invoice_number_snapshot/vendor_name_snapshot) lets the UI
-- show "Shiva Industries" or "Priya (Finance)" at the top of each message rather than
-- just a generic role label, and survives a name changing later or an invoice being
-- withdrawn.
ALTER TABLE dispute_messages ADD COLUMN sender_name TEXT;

-- Backfill existing vendor messages with the vendor name already on file for their
-- dispute -- Finance messages don't exist yet (the route is new), so nothing to
-- backfill for those.
UPDATE dispute_messages dm
SET sender_name = COALESCE(vc.vendor_name_snapshot, v.company_name)
FROM vendor_communications vc
LEFT JOIN vendors v ON v.id = vc.vendor_id
WHERE dm.vendor_communication_id = vc.id AND dm.sender_role = 'vendor' AND dm.sender_name IS NULL;

-- Veridion Flow 3 follow-up: closes a real gap in shell-company fraud detection.
-- vendors.bank_account_number/bank_ifsc already existed in the schema but were never
-- actually collected anywhere, and vendors had no address field at all — meaning
-- SHARES_BANK_ACCOUNT_WITH and SHARES_ADDRESS_WITH (Part 2.6) had no real data to
-- ever detect. This adds the missing address column; bank fields just start being used.

ALTER TABLE vendors ADD COLUMN address TEXT;

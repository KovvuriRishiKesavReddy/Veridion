-- Fix: withdrawing an invoice (DELETE FROM invoices, in invoices.js's withdraw route)
-- was cascading through vendor_communications.invoice_id's ON DELETE CASCADE and
-- silently wiping out the ENTIRE dispute record -- including a resolved status and
-- every vendor message -- the moment a vendor withdrew their invoice to resubmit a
-- corrected one. Finance lost all trace the dispute had ever existed.
--
-- Fix has two parts:
-- 1. invoice_id becomes nullable with ON DELETE SET NULL (detaches instead of
--    cascading) so the vendor_communications row and its dispute_messages survive.
-- 2. A denormalized snapshot of the identifying details (company_id, invoice number,
--    vendor name) is captured at creation time, so the dispute stays meaningful --
--    and every route stays correctly scoped to the right company -- even after its
--    invoice is gone. This also removes the need for every route to JOIN all the way
--    through invoices -> purchase_orders just to check company ownership.
ALTER TABLE vendor_communications
  DROP CONSTRAINT vendor_communications_invoice_id_fkey,
  ADD CONSTRAINT vendor_communications_invoice_id_fkey
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

ALTER TABLE vendor_communications ALTER COLUMN invoice_id DROP NOT NULL;

ALTER TABLE vendor_communications
  ADD COLUMN company_id INTEGER REFERENCES companies(id),
  ADD COLUMN invoice_number_snapshot TEXT,
  ADD COLUMN vendor_name_snapshot TEXT;

-- Backfill existing rows whose invoice still exists (best-effort -- a row whose
-- invoice was ALREADY cascade-deleted before this fix can't recover invoice_number,
-- since that data is genuinely gone; only vendor_name and company_id, which are
-- recoverable via vendor_id/still-live company data, are backfilled for those).
UPDATE vendor_communications vc
SET company_id = po.company_id,
    invoice_number_snapshot = inv.invoice_number,
    vendor_name_snapshot = v.company_name
FROM invoices inv
JOIN purchase_orders po ON po.id = inv.po_id,
     vendors v
WHERE vc.invoice_id = inv.id AND v.id = vc.vendor_id;

CREATE INDEX idx_vendor_communications_company_id ON vendor_communications(company_id);

-- Prevents a rare but real race: if the decision pipeline is ever re-triggered for the
-- same invoice close together (e.g. a duplicate queue delivery during a broker
-- reconnect), the existing "check then insert" guard in decide.js is not atomic and
-- could otherwise create two separate dispute records for one invoice, splitting the
-- vendor's messages across two rows that look identical to Finance. A partial unique
-- index (only enforced while invoice_id is set) makes that structurally impossible;
-- multiple withdrawn (invoice_id NULL) historical rows for the same vendor remain
-- perfectly legitimate and are unaffected.
CREATE UNIQUE INDEX idx_vendor_communications_invoice_unique ON vendor_communications(invoice_id) WHERE invoice_id IS NOT NULL;

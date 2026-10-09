-- Vendor-Company Communication Channel: two new private message threads, same shape as
-- dispute_messages (009) deliberately -- one row per message, never a single overwritable
-- field, so a second message can't silently erase the first.
--
-- Pre-award: scoped to ONE quotation. Private between that one vendor and the company;
-- other vendors who quoted on the same requirement never see it. Price AND delivery-days
-- negotiation happen here; whatever gets agreed is written to quotations.price /
-- quotations.delivery_days by the PUT /api/quotations/:id route -- this table is only the
-- conversation that led to that edit.
CREATE TABLE quotation_messages (
  id SERIAL PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('vendor', 'procurement')),
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quotation_messages_quotation_id ON quotation_messages(quotation_id);

-- Post-award: scoped to ONE purchase order. Logistics only -- price is never touched here;
-- agreed_price stays locked exactly as today, so nothing in Matching / Compliance / Fraud /
-- the Context Gate needs to know this table exists. Warehouse is a sender/reader too, since
-- they act on whatever gets agreed (e.g. a split-delivery plan that produces the sourced
-- expected_next_delivery_date below).
CREATE TABLE po_messages (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('vendor', 'procurement', 'warehouse')),
  sender_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_po_messages_po_id ON po_messages(po_id);

-- The "proof" piece: links a GRN's self-reported expected_next_delivery_date back to the
-- SPECIFIC po_messages row it came from, if any. Nullable -- a date agreed by phone, or not
-- sourced from this thread at all, is still allowed, just without the citation. ON DELETE
-- SET NULL (not CASCADE) so a GRN record is never destroyed because an old message was
-- cleaned up: the GRN is the durable record, the link is a convenience on top of it.
ALTER TABLE goods_receipt_notes
  ADD COLUMN expected_next_delivery_source_message_id INTEGER REFERENCES po_messages(id) ON DELETE SET NULL;

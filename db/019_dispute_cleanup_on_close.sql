-- Dispute lifecycle cleanup.
--
-- Problem: an UNSENT dispute draft (status='pending_send') kept showing up on both the
-- Finance and Vendor sides after its invoice was withdrawn, verified or paid, and a
-- SENT dispute stayed open after the invoice was paid.
--
-- Rules from here on (enforced in the routes; this migration cleans up existing rows):
--   * invoice withdrawn / verified / paid  -> any unsent draft is CLOSED (kept as a record,
--     never shown to the vendor).
--   * invoice paid                         -> any SENT, still-open dispute is CLOSED
--     (resolved = true, closed_reason = 'payment'). Its message history is kept.
ALTER TABLE vendor_communications ADD COLUMN closed_reason TEXT;

-- Unsent drafts whose invoice is gone (withdrawn) or already verified / paid: CLOSED, not deleted.
UPDATE vendor_communications vc
SET resolved = true, resolved_at = now(),
    closed_reason = CASE WHEN vc.invoice_id IS NULL THEN 'withdrawn'
                         WHEN i.status = 'paid' THEN 'payment' ELSE 'verified' END
FROM (SELECT vc2.id AS vcid, i2.status FROM vendor_communications vc2 LEFT JOIN invoices i2 ON i2.id = vc2.invoice_id) i
WHERE i.vcid = vc.id AND vc.status = 'pending_send' AND vc.resolved = false
  AND (vc.invoice_id IS NULL OR i.status IN ('paid', 'verified'));

-- Sent-but-open disputes on invoices that have since been paid.
UPDATE vendor_communications vc
SET resolved = true,
    resolved_at = now(),
    resolution_time_hours = EXTRACT(EPOCH FROM (now() - vc.sent_at)) / 3600.0,
    closed_reason = 'payment'
FROM invoices i
WHERE i.id = vc.invoice_id
  AND i.status = 'paid'
  AND vc.status = 'sent'
  AND vc.resolved = false;

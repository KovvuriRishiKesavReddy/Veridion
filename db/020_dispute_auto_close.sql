-- Auto-closed disputes are NOT resolutions. Follow-up to 019:
--   * disputes already closed by payment carry no resolution time (it is not a real
--     resolution, and must not feed any resolution-time metric);
--   * sent, still-open disputes whose invoice was withdrawn (invoice_id NULL) are
--     closed with closed_reason = 'withdrawn' (history kept).
UPDATE vendor_communications SET resolution_time_hours = NULL WHERE closed_reason = 'payment';

UPDATE vendor_communications
SET resolved = true, resolved_at = now(), closed_reason = 'withdrawn'
WHERE invoice_id IS NULL AND status = 'sent' AND resolved = false;

-- Catch-all (idempotent): unsent drafts still open on a withdrawn / verified / paid
-- invoice are CLOSED rather than left hanging in Finance's Pending list.
UPDATE vendor_communications vc
SET resolved = true, resolved_at = now(),
    closed_reason = CASE WHEN vc.invoice_id IS NULL THEN 'withdrawn' WHEN i.status = 'paid' THEN 'payment' ELSE 'verified' END
FROM vendor_communications vc2 LEFT JOIN invoices i ON i.id = vc2.invoice_id
WHERE vc2.id = vc.id AND vc.status = 'pending_send' AND vc.resolved = false
  AND (vc.invoice_id IS NULL OR i.status IN ('paid', 'verified'));

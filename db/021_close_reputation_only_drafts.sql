-- Unsent dispute drafts that exist on invoices whose latest decision says the flag was
-- driven SOLELY by the vendor's risk score (Matching, Compliance and Fraud all clean)
-- never applied -- there is nothing on the invoice to dispute. Close them (kept as a
-- record, never shown to the vendor). Disputes already SENT are left untouched.
UPDATE vendor_communications vc
SET resolved = true, resolved_at = now(), closed_reason = 'reputation_only'
WHERE vc.status = 'pending_send' AND vc.resolved = false
  AND (SELECT d.agent_inputs->'vendor_risk'->>'counted_as_positive_despite_flag'
       FROM decisions d WHERE d.invoice_id = vc.invoice_id ORDER BY d.id DESC LIMIT 1) = 'true';

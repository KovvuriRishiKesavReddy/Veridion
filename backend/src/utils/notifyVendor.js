// backend/src/utils/notifyVendor.js
//
// Flow 6 — automated vendor notification when a quotation is accepted.
//
// DESIGN RULES (see Veridion design doc, Part 9.5):
//   1. NON-BLOCKING. This must never delay or break Purchase Order generation. The caller
//      (POST /api/quotations/:id/accept) invokes it AFTER the PO transaction has committed
//      and does NOT await it before responding. notifyQuotationAccepted() itself never
//      throws — every failure is caught and recorded in outbound_notifications instead.
//   2. INDEPENDENT AUDIT TRAIL. Each attempt is its own outbound_notifications row with its
//      own status ('queued' -> 'sent' | 'failed' | 'skipped'), never part of the PO's
//      transaction.
//   3. The message is purely informational — the call never asks the vendor to respond.
//
// Provider: OmniDimension (voice AI). Docs: POST https://backend.omnidim.io/api/v1/calls/dispatch
//   body: { agent_id, to_number (+country code), from_number_id, call_context, metadata }
//   -> { success: true, status: 'dispatched', requestId }
// The agent's spoken script is configured in the OmniDimension dashboard (see
// docs/FLOW6_OMNIDIMENSION_SETUP.md); we pass the specifics as call_context variables.
const db = require('../db');

const DEFAULT_BASE_URL = 'https://backend.omnidim.io/api/v1';
const REQUEST_TIMEOUT_MS = 10000;

// Vendors typed their phone number by hand at registration, so it may or may not carry a
// country code. OmniDimension requires E.164 ("+" + country code). Returns the normalised
// number, or null if it can't be made into a plausible one.
function normalizePhoneNumber(raw, defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '+91') {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    s = s.replace(/^0+/, ''); // national trunk prefix, e.g. 09876543210
    const cc = String(defaultCountryCode).replace(/\D/g, '');
    // Already includes the default country code without the "+" (e.g. 919876543210)?
    if (cc && s.startsWith(cc) && s.length >= cc.length + 10) s = '+' + s;
    else s = '+' + cc + s;
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

function buildMessage({ companyName, item }) {
  return `This is an automated message from Veridion on behalf of ${companyName}. ` +
    `Your quotation for ${item} has been accepted. A purchase order has been generated and is ` +
    `available on your Veridion vendor dashboard. Thank you.`;
}

async function updateRow(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await db.query(`UPDATE outbound_notifications SET ${sets} WHERE id = $1`, [id, ...keys.map(k => fields[k])]);
}

// Places the voice call through OmniDimension. Throws on any failure (caught by caller).
async function dispatchOmniDimensionCall({ toNumber, context, metadata }) {
  const apiKey = process.env.OMNIDIMENSION_API_KEY;
  const agentId = process.env.OMNIDIMENSION_AGENT_ID;
  const fromNumberId = process.env.OMNIDIMENSION_OUTBOUND_NUMBER_ID;
  const baseUrl = (process.env.OMNIDIMENSION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const body = {
    agent_id: Number.isNaN(Number(agentId)) ? agentId : Number(agentId),
    to_number: toNumber,
    call_context: context,
    metadata
  };
  // from_number_id is optional per the API (platform default number is used if omitted).
  if (fromNumberId) body.from_number_id = Number.isNaN(Number(fromNumberId)) ? fromNumberId : Number(fromNumberId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/calls/dispatch`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
    if (!res.ok || (json && json.success === false)) {
      const detail = (json && (json.error || json.message || json.detail)) || text.slice(0, 200);
      throw new Error(`OmniDimension returned ${res.status}: ${detail}`);
    }
    return { requestId: json && json.requestId !== undefined ? String(json.requestId) : null };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`OmniDimension request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// notifyQuotationAccepted(vendorId, poId)
// Never throws. Resolves to the final outbound_notifications row (or null if even the audit
// row couldn't be written) — callers should not depend on the result.
async function notifyQuotationAccepted(vendorId, poId) {
  let rowId = null;
  try {
    const infoRes = await db.query(
      `SELECT v.phone_number, v.preferred_notification_channel AS channel,
              c.name AS company_name, r.title AS item
       FROM purchase_orders po
       JOIN vendors v ON v.id = po.vendor_id
       JOIN companies c ON c.id = po.company_id
       JOIN requirements r ON r.id = po.requirement_id
       WHERE po.id = $1 AND po.vendor_id = $2`,
      [poId, vendorId]
    );
    const info = infoRes.rows[0];
    if (!info) {
      console.error(`[notifyVendor] PO ${poId} / vendor ${vendorId} not found — nothing to notify`);
      return null;
    }

    const channel = info.channel || 'sms';
    const ins = await db.query(
      `INSERT INTO outbound_notifications (vendor_id, reference_type, reference_id, channel, status)
       VALUES ($1,'quotation_accepted',$2,$3,'queued') RETURNING id`,
      [vendorId, poId, channel]
    );
    rowId = ins.rows[0].id;

    // Only the voice channel has a provider wired up. The vendor chose something else (or
    // 'app_only'): record that honestly instead of pretending a text was sent. The PO is
    // always visible on their dashboard regardless.
    if (channel !== 'voice_call') {
      await updateRow(rowId, {
        status: 'skipped',
        error_message: channel === 'app_only'
          ? 'Vendor prefers in-app notifications only'
          : `No provider configured for channel '${channel}' — only voice_call is automated`
      });
      return await fetchRow(rowId);
    }

    if (!process.env.OMNIDIMENSION_API_KEY || !process.env.OMNIDIMENSION_AGENT_ID) {
      await updateRow(rowId, { status: 'skipped', error_message: 'OmniDimension is not configured (OMNIDIMENSION_API_KEY / OMNIDIMENSION_AGENT_ID missing)' });
      return await fetchRow(rowId);
    }

    const toNumber = normalizePhoneNumber(info.phone_number);
    if (!toNumber) {
      await updateRow(rowId, { status: 'failed', error_message: `Invalid or missing vendor phone number: ${info.phone_number === null ? '(none)' : JSON.stringify(info.phone_number)}` });
      return await fetchRow(rowId);
    }

    const message = buildMessage({ companyName: info.company_name, item: info.item });
    const { requestId } = await dispatchOmniDimensionCall({
      toNumber,
      context: {
        company_name: info.company_name,
        item: info.item,
        po_id: String(poId),
        message
      },
      metadata: { source: 'veridion', reference_type: 'quotation_accepted', po_id: poId, vendor_id: vendorId }
    });

    await updateRow(rowId, { status: 'sent', provider_message_id: requestId, to_number: toNumber, sent_at: new Date().toISOString() });
    return await fetchRow(rowId);
  } catch (err) {
    console.error(`[notifyVendor] notification for PO ${poId} failed (PO unaffected): ${err.message}`);
    if (rowId) {
      try { await updateRow(rowId, { status: 'failed', error_message: String(err.message).slice(0, 500) }); } catch (_) { /* nothing more we can do */ }
      try { return await fetchRow(rowId); } catch (_) { return null; }
    }
    return null;
  }
}

async function fetchRow(id) {
  const r = await db.query(`SELECT * FROM outbound_notifications WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

module.exports = { notifyQuotationAccepted, normalizePhoneNumber, buildMessage };

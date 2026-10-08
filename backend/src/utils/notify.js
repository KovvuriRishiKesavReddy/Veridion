// backend/src/utils/notify.js
//
// Single entry point for creating notifications. Each one is written to Postgres (the
// guaranteed, persistent layer) AND emitted over Socket.io if the recipient happens to be
// connected right now (the real-time layer). The DB write always happens; the socket emit is
// best-effort and never allowed to throw — same fire-and-forget posture as grn.js's
// notifyGrnConfirmed and aiService.js's callAiService, which never let a side-channel failure
// break the actual business action.
//
// Recipients:
//   notifyVendor(vendorId, ...)                  -> room vendor_<id>
//   notifyCompanyRole(companyId, roles, ...)     -> room company_<id>_<role>, one row per role
//   notifyPlatformAdmins(...)                    -> room platform_admin
const db = require('../db');

// Set once from server.js after `io` is created.
let ioInstance = null;
function setSocketIo(io) {
  ioInstance = io;
}

function emit(room, notification) {
  try {
    if (ioInstance) ioInstance.to(room).emit('notification', notification);
  } catch (err) {
    console.error(`[notify] Socket emit to ${room} failed (notification still saved):`, err.message);
  }
}

async function notifyVendor(vendorId, type, message, relatedId = null, relatedType = null) {
  const result = await db.query(
    `INSERT INTO notifications (vendor_id, type, message, related_id, related_type)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [vendorId, type, message, relatedId, relatedType]
  );
  const notification = result.rows[0];
  emit(`vendor_${vendorId}`, notification);
  return notification;
}

// roles: a role name or an array, e.g. 'finance' or ['procurement', 'company_admin'].
async function notifyCompanyRole(companyId, roles, type, message, relatedId = null, relatedType = null) {
  const out = [];
  for (const role of [].concat(roles)) {
    const result = await db.query(
      `INSERT INTO notifications (company_id, target_role, type, message, related_id, related_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [companyId, role, type, message, relatedId, relatedType]
    );
    out.push(result.rows[0]);
    emit(`company_${companyId}_${role}`, result.rows[0]);
  }
  return out;
}

async function notifyPlatformAdmins(type, message, relatedId = null, relatedType = null) {
  const result = await db.query(
    `INSERT INTO notifications (target_role, type, message, related_id, related_type)
     VALUES ('platform_admin',$1,$2,$3,$4) RETURNING *`,
    [type, message, relatedId, relatedType]
  );
  emit('platform_admin', result.rows[0]);
  return result.rows[0];
}

// Every call site is fire-and-forget; this wrapper keeps that one line instead of a
// .catch(...) block at each of them, and guarantees a notification bug can't surface as an
// unhandled rejection or fail the business action it rides on.
function safely(promise, label = 'notification') {
  Promise.resolve(promise).catch(err => console.error(`[notify] ${label} failed (business action unaffected):`, err.message));
}

// Which user may read which notifications — used by the REST routes so the scoping rule lives
// next to the code that writes them. Returns { where, params } or null if this user has none.
function recipientFilter(user) {
  if (user.role === 'vendor') return user.vendor_id ? { where: 'vendor_id = $1', params: [user.vendor_id] } : null;
  if (user.role === 'platform_admin') return { where: `target_role = 'platform_admin' AND vendor_id IS NULL AND company_id IS NULL`, params: [] };
  if (user.company_id) return { where: 'company_id = $1 AND target_role = $2', params: [user.company_id, user.role] };
  return null;
}

module.exports = { notifyVendor, notifyCompanyRole, notifyPlatformAdmins, safely, setSocketIo, recipientFilter };

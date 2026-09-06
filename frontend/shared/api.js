// Change this if your backend runs somewhere other than localhost:4000
const API_BASE = 'http://localhost:4000';

// Session storage strategy: sessionStorage (tab-scoped) is checked first, with a
// fallback to localStorage (device-scoped) for a "Remember Me" login. This combines
// both behaviors deliberately:
//   - A tab that has explicitly logged in (sessionStorage set) always uses ITS OWN
//     login, regardless of what's remembered elsewhere — this is what keeps
//     Admin/Vendor/Company tabs fully isolated from each other (see the note below).
//   - A fresh tab with no explicit login of its own falls back to whatever was
//     "remembered" in localStorage — this is what lets a user open a new tab (or
//     restart the browser) and still be signed in, instead of being logged out the
//     moment a tab closes.
// setSession(..., remember) decides which storage a NEW login goes into:
//   - remember=true  -> localStorage (persists across tabs and browser restarts)
//   - remember=false -> sessionStorage only, scoped to this one tab, cleared on tab close
// logout() always clears both — "log out" should end the session everywhere, not just
// hide it from the current tab.
function getToken() {
  return sessionStorage.getItem('veridion_token') || localStorage.getItem('veridion_token');
}

function getUser() {
  const raw = sessionStorage.getItem('veridion_user') || localStorage.getItem('veridion_user');
  return raw ? JSON.parse(raw) : null;
}

function setSession(token, user, remember = false) {
  if (remember) {
    localStorage.setItem('veridion_token', token);
    localStorage.setItem('veridion_user', JSON.stringify(user));
    // Clear any non-remembered login this same tab had, so getToken()'s
    // sessionStorage-first check doesn't shadow the remembered one we just set.
    sessionStorage.removeItem('veridion_token');
    sessionStorage.removeItem('veridion_user');
  } else {
    sessionStorage.setItem('veridion_token', token);
    sessionStorage.setItem('veridion_user', JSON.stringify(user));
  }
}

function clearSession() {
  sessionStorage.removeItem('veridion_token');
  sessionStorage.removeItem('veridion_user');
  localStorage.removeItem('veridion_token');
  localStorage.removeItem('veridion_user');
}

// isEditingWithin(containerId): true if the currently focused element is a text input
// or textarea inside the given container. Pass this (wrapped) as pollEvery's skipIf on
// any page that re-renders editable fields, so a live poll never overwrites text
// someone is mid-way through typing.
function isEditingWithin(containerId) {
  const el = document.activeElement;
  if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return false;
  const container = document.getElementById(containerId);
  return !!(container && container.contains(el));
}

// hasOpenDetailsWithin(containerId): true if any <details> element inside the
// container is currently expanded (open). Re-rendering a container via innerHTML
// destroys and recreates its DOM nodes, which silently resets every <details> back to
// closed — this is what "AI ranking reasoning" / "agent weights" panels closing on
// their own, or refusing to stay open, actually is. Guarding on this lets a poll pause
// itself while someone is reading an expanded explanation, instead of yanking it shut
// out from under them every second.
function hasOpenDetailsWithin(containerId) {
  const container = document.getElementById(containerId);
  return !!(container && container.querySelector('details[open]'));
}

// hasSelectionWithin(containerId): true if there's a non-empty text selection
// currently anchored inside the container. The same innerHTML re-render that resets
// <details> also silently clears any in-progress text selection — which is why
// copying a GSTIN, bank account number, or any other detail off a live-polling page
// can feel impossible: the selection vanishes within a second of making it. Guarding
// on this pauses polling for that container while the user is mid-select/copy.
function hasSelectionWithin(containerId) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
  const container = document.getElementById(containerId);
  return !!(container && container.contains(sel.anchorNode));
}

// pollBlockedBy(...containerIds): the combined guard almost every polled page wants —
// skip this poll tick if the user is typing into a field, has an explanation/details
// panel open, or is in the middle of selecting/copying text, in ANY of the given
// containers. This is what actually stops live-refresh from fighting the user.
function pollBlockedBy(...containerIds) {
  return containerIds.some(id => isEditingWithin(id) || hasOpenDetailsWithin(id) || hasSelectionWithin(id));
}

// pollEvery: calls fn() once immediately, then every `ms` milliseconds (default 1000).
// Used throughout the app so status pages (invoice status, PO fulfillment, dispute
// state, admin approval queues, etc.) reflect changes live, without the user needing
// to manually refresh. Returns the interval id in case a page ever needs to stop it.
//
// skipIf (optional): a zero-arg function checked before each poll tick (not before the
// very first call) — if it returns true, that tick is skipped entirely. Most pages
// should pass `() => pollBlockedBy('containerId', ...)` here rather than writing this
// check by hand.
function pollEvery(fn, ms = 1000, skipIf = null) {
  fn();
  return setInterval(() => { if (!skipIf || !skipIf()) fn(); }, ms);
}

// fetchWithAuth: attaches Bearer token, redirects to login on 401.
// If body is a FormData instance, Content-Type is left for the browser to set (multipart boundary).
async function fetchWithAuth(path, options = {}) {
  const token = getToken();
  const headers = options.headers || {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const isFormData = options.body instanceof FormData;
  if (!isFormData && options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearSession();
    window.location.href = '/login.html';
    return null;
  }
  return res;
}

function requireLogin(allowedRoles) {
  const user = getUser();
  if (!user || !getToken()) {
    window.location.href = '/login.html';
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    alert('You do not have access to this page.');
    window.location.href = '/login.html';
    return null;
  }
  return user;
}

function logout() {
  clearSession();
  window.location.href = '/login.html';
}

function statusBadgeClass(status) {
  const map = {
    submitted: 'bg-secondary', pending: 'bg-secondary',
    selected: 'bg-primary', issued: 'bg-primary', open: 'bg-primary',
    fulfilled: 'bg-success', verified: 'bg-success', accepted: 'bg-success', approved: 'bg-success',
    partially_fulfilled: 'bg-warning text-dark',
    rejected: 'bg-danger', flagged: 'bg-danger', closed: 'bg-dark'
  };
  return map[status] || 'bg-secondary';
}

// Renders the exact shortfall/excess amount as a small badge, given a signed
// variance_quantity (received_quantity - agreed_quantity): negative = short,
// positive = excess (over-delivery), 0 = exact match. Used on every page that
// shows GRN/fulfillment data so the actual number is visible, not just "Short".
function varianceBadge(variance) {
  const v = Number(variance);
  if (v < 0) return ` <span class="badge bg-warning text-dark">${Math.abs(v)} short</span>`;
  if (v > 0) return ` <span class="badge bg-info text-dark">${v} excess</span>`;
  return ` <span class="badge bg-success">Exact match</span>`;
}

// invoice.invoice_amount is the PRE-TAX amount (matches the PO's agreed_price by
// design — GST is tracked separately in invoice.gst_amount and recalculated fresh
// at invoice time rather than baked into the PO; see ai-service's taxAmount.js for
// the full reasoning). The actual amount payable to the vendor is always
// invoice_amount + gst_amount, not invoice_amount alone. Shared here so every page
// that shows a payable amount computes it the same way rather than each page
// re-deriving it (and risking drifting out of sync with each other).
function invoiceTotal(invoice) {
  const base = Number(invoice.invoice_amount) || 0;
  const gst = Number(invoice.gst_amount) || 0;
  return base + gst;
}

// Formats an invoice's payable total with the base+GST breakdown alongside it, so
// Finance can verify the figure at a glance without opening the review page —
// e.g. "₹11,800 (₹10,000 + ₹1,800 GST)".
function formatInvoiceTotal(invoice) {
  const total = invoiceTotal(invoice);
  const gst = Number(invoice.gst_amount) || 0;
  if (!gst) return `₹${total}`;
  return `₹${total} <span class="text-muted small">(₹${Number(invoice.invoice_amount) || 0} + ₹${gst} GST)</span>`;
}

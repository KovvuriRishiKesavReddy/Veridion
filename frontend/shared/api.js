// Change this if your backend runs somewhere other than localhost:4000
const API_BASE = 'http://localhost:4000';

function getToken() {
  return localStorage.getItem('veridion_token');
}

function getUser() {
  const raw = localStorage.getItem('veridion_user');
  return raw ? JSON.parse(raw) : null;
}

function setSession(token, user) {
  localStorage.setItem('veridion_token', token);
  localStorage.setItem('veridion_user', JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem('veridion_token');
  localStorage.removeItem('veridion_user');
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

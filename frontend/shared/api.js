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
  // A readonly or disabled field can still receive focus (e.g. clicking into a
  // read-only draft message to select/copy text from it), but there is nothing being
  // "edited" there — blocking a poll on that basis was a real bug: it silently
  // stopped a whole dispute list from refreshing for as long as focus sat in a
  // read-only textarea, which is exactly what made new messages seem to stop arriving.
  if (el.readOnly || el.disabled) return false;
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

// ---------------------------------------------------------------------------
// Sort/filter toolbar — used on every page listing POs, invoices, GRNs,
// quotations, payments, or disputes, so a growing list of numbered documents
// doesn't get confusing for the vendor, company, or admin looking at it: sort by
// recency, by document number, or narrow to a date range, consistently, everywhere.
// ---------------------------------------------------------------------------

// sortAndFilterItems(items, state, config): pure function, no DOM — filters by a free-text
// search (against config.searchFields, case-insensitive, matches if ANY field contains the
// text), then sorts by state.sortBy: 'newest'/'oldest' against config.dateField,
// 'number_asc'/'number_desc' against config.numberField, or 'text:<field>' (alphabetical,
// A → Z) against whichever field name follows the colon. Never mutates the input array.
function sortAndFilterItems(items, state, config) {
  let result = items.slice();
  if (state.search && config.searchFields && config.searchFields.length) {
    const q = state.search.toLowerCase();
    result = result.filter(item =>
      config.searchFields.some(field => String(item[field] ?? '').toLowerCase().includes(q))
    );
  }
  const byDate = (a, b) => new Date(a[config.dateField] || 0) - new Date(b[config.dateField] || 0);
  const byNumber = (a, b) => (Number(a[config.numberField]) || 0) - (Number(b[config.numberField]) || 0);
  if (state.sortBy && state.sortBy.startsWith('text:')) {
    const field = state.sortBy.slice(5);
    result.sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')));
    return result;
  }
  switch (state.sortBy) {
    case 'oldest': result.sort(byDate); break;
    case 'number_asc': result.sort(byNumber); break;
    case 'number_desc': result.sort((a, b) => byNumber(b, a)); break;
    case 'newest': default: result.sort((a, b) => byDate(b, a)); break;
  }
  return result;
}

// renderSortToolbar(containerId, onChange, options): renders the toolbar ONCE into
// containerId — a free-text Search box, a Sort by dropdown, and a Clear button, laid
// out exactly like the Open Requirements page — and wires its controls to call
// onChange(state) whenever either of them change. Deliberately NOT re-rendered by the
// page's poll loop (only the results list below it is) — re-rendering this every
// second would reset the search box/dropdown back to their defaults while someone has
// them set, exactly the bug already fixed once for the requirement dropdown on
// quotation-comparison.html. Call this once at page load; call the returned getState()
// from inside your load()/render function each time you need the current search/sort
// to apply (typically passed straight into sortAndFilterItems's `state` argument,
// whose `config.searchFields` says which item fields the search box matches against).
//
// options.searchPlaceholder: placeholder text for the search box (defaults to a
// generic "Search..."). The toolbar itself carries a bottom margin (mb-3) so there's
// always breathing room between it and whatever list/table follows, the same gap
// Open Requirements has.
//
// options.sortOptions: extra <option> entries appended after the always-present
// "Newest first" / "Oldest first", as [{ value, label }] — e.g.
// [{ value: 'text:vendor_name', label: 'Vendor: A → Z' }]. This is what keeps every
// page's Sort by dropdown looking and behaving the same way as Open Requirements'
// (Newest first, Oldest first, then a couple of relevant "X: A → Z" choices) instead
// of each page inventing its own set of options. Defaults to the generic
// low-to-high/high-to-low numeric pair for any page that doesn't pass its own.
function renderSortToolbar(containerId, onChange, options = {}) {
  const searchPlaceholder = options.searchPlaceholder || 'Search...';
  const sortOptions = options.sortOptions || [
    { value: 'number_asc', label: 'Number: low to high' },
    { value: 'number_desc', label: 'Number: high to low' }
  ];
  const container = document.getElementById(containerId);
  if (!container) return () => ({ search: '', sortBy: 'newest' });
  container.innerHTML = `
    <div class="filter-toolbar mb-3">
      <div class="d-flex flex-wrap gap-3 align-items-end">
        <div class="flex-grow-1" style="min-width:220px;">
          <label class="form-label small mb-1" for="${containerId}-search">Search</label>
          <input class="form-control form-control-sm" id="${containerId}-search" placeholder="${searchPlaceholder}">
        </div>
        <div style="min-width:180px;">
          <label class="form-label small mb-1" for="${containerId}-sort">Sort by</label>
          <select class="form-select form-select-sm" id="${containerId}-sort" style="width:auto;">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            ${sortOptions.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="${containerId}-clear">Clear</button>
      </div>
    </div>`;

  const searchEl = document.getElementById(`${containerId}-search`);
  const sortEl = document.getElementById(`${containerId}-sort`);
  const clearBtn = document.getElementById(`${containerId}-clear`);
  const getState = () => ({ search: searchEl.value.trim().toLowerCase(), sortBy: sortEl.value });

  searchEl.addEventListener('input', () => onChange(getState()));
  sortEl.addEventListener('change', () => onChange(getState()));
  clearBtn.addEventListener('click', () => {
    searchEl.value = ''; sortEl.value = 'newest';
    onChange(getState());
  });

  return getState;
}

// ---------------------------------------------------------------------------
// New-item toast notifications — used on pages where something appearing while
// you're not looking at it is worth an active nudge (a new dispute raised against
// you), not just a live-updating list you'd have to notice yourself.
// ---------------------------------------------------------------------------

// showToast(message): a small dismissible notification in the corner of the screen,
// auto-hides after 6 seconds. Stacks if called more than once. No dependency beyond
// Bootstrap (already loaded on every page).
function showToast(message) {
  let stack = document.getElementById('veridion-toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'veridion-toast-stack';
    stack.style.cssText = 'position:fixed; top:80px; right:16px; z-index:1080; display:flex; flex-direction:column; gap:8px; max-width:320px;';
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = 'alert alert-warning shadow-sm mb-0 py-2 px-3 small';
  toast.style.cssText = 'animation: veridion-toast-in 0.2s ease-out;';
  toast.innerHTML = `<button type="button" class="btn-close btn-close-sm float-end" style="font-size:0.65rem;" aria-label="Close"></button>${message}`;
  toast.querySelector('.btn-close').addEventListener('click', () => toast.remove());
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

// withButtonState(button, asyncFn): wraps an async action with a visible
// loading -> success/error sequence on a `.hbg-core` button (see
// dock-navbar.css's stateful-button styling), instead of a button that just
// sits there giving no feedback until the request finishes. Usage:
//   <button class="hbg-core" onclick="withButtonState(this, () => resolveDispute(id))">
// asyncFn's own return value decides which outcome is shown:
//   - `false` (or a thrown error)      -> red "Failed" flash
//   - `null`                           -> silent revert, no flash at all —
//     for a genuine no-op, like the user dismissing a confirm() dialog
//     inside asyncFn; nothing happened, so neither success nor failure
//     would be honest here
//   - anything else (including undefined) -> green "Done" flash
// This means adding stateful feedback to an existing handler needs no
// rewrite of its logic — only `return false`/`return null` at the specific
// early-exit points that should show something other than plain success.
async function withButtonState(button, asyncFn) {
  if (!button || button.dataset.state === 'loading') return;
  const originalHTML = button.innerHTML;
  button.dataset.state = 'loading';
  button.disabled = true;
  button.innerHTML = '<span class="btn-state-label"><span class="btn-spinner"></span>Working...</span>';

  let result;
  try {
    result = await asyncFn();
  } catch (err) {
    result = false;
  }

  if (result === null) {
    button.dataset.state = 'idle';
    button.innerHTML = originalHTML;
    button.disabled = false;
    return;
  }

  const ok = result !== false;
  button.dataset.state = ok ? 'success' : 'error';
  button.innerHTML = ok ? '<span class="btn-state-label">✓ Done</span>' : '<span class="btn-state-label">✕ Failed</span>';
  setTimeout(() => {
    button.dataset.state = 'idle';
    button.innerHTML = originalHTML;
    button.disabled = false;
  }, ok ? 1100 : 1700);
}

// ---------------------------------------------------------------------------
// Alert Dialog — a real modal (Bootstrap-based, since bootstrap.bundle is
// already loaded on every page) instead of the browser's native confirm()/
// prompt(). Used for the app's genuinely high-stakes actions — approving a
// payment, overriding a flag, withdrawing an invoice, resolving a dispute —
// so they get a moment of visual weight a plain OS popup doesn't carry, and
// so the reason/context is presented alongside the actual choice instead of
// a bare yes/no. Both return a Promise, so existing `if (!confirm(...)) return;`
// call sites become `if (!(await confirmDialog(...))) return;` with no other
// logic changed.
// ---------------------------------------------------------------------------

// confirmDialog({ title, message, confirmText, cancelText, danger }): resolves
// true if the user confirms, false if they cancel OR dismiss the dialog any
// other way (backdrop click is disabled deliberately — a decision this
// consequential shouldn't be dismissible by an accidental click outside it;
// Escape and the Cancel button both still work).
function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const id = 'veridion-alert-dialog-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade veridion-alert-modal" id="${id}" tabindex="-1" data-bs-backdrop="static">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-body p-4">
              <div class="d-flex align-items-start gap-3">
                <div class="alert-dialog-icon ${danger ? 'alert-dialog-icon-danger' : ''}"><i class="bi ${danger ? 'bi-exclamation-triangle-fill' : 'bi-question-circle-fill'}"></i></div>
                <div>
                  <h6 class="mb-1">${title}</h6>
                  <p class="small text-muted mb-0">${message}</p>
                </div>
              </div>
            </div>
            <div class="modal-footer border-0 pt-0">
              <button type="button" class="btn btn-sm btn-outline-secondary" data-role="cancel">${cancelText}</button>
              <span class="hbg ${danger ? 'hbg-danger' : ''} d-inline-block"><button type="button" class="hbg-core" data-role="confirm">${confirmText}</button></span>
            </div>
          </div>
        </div>
      </div>`);
    const el = document.getElementById(id);
    const modal = new bootstrap.Modal(el);
    let resolved = false;
    el.querySelector('[data-role="confirm"]').addEventListener('click', () => { resolved = true; modal.hide(); resolve(true); });
    el.querySelector('[data-role="cancel"]').addEventListener('click', () => { resolved = true; modal.hide(); resolve(false); });
    el.addEventListener('hidden.bs.modal', () => { if (!resolved) resolve(false); el.remove(); });
    modal.show();
  });
}

// promptDialog({ title, message, placeholder, confirmText, cancelText }):
// resolves the trimmed text entered, or null if cancelled/dismissed/left empty
// — matching the existing `if (!reason || !reason.trim()) return;` pattern
// every call site already used with the native prompt().
function promptDialog({ title = 'Enter details', message = '', placeholder = '', confirmText = 'Submit', cancelText = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const id = 'veridion-prompt-dialog-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade veridion-alert-modal" id="${id}" tabindex="-1" data-bs-backdrop="static">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-body p-4">
              <h6 class="mb-1">${title}</h6>
              <p class="small text-muted mb-2">${message}</p>
              <textarea class="form-control" data-role="input" rows="3" placeholder="${placeholder}"></textarea>
            </div>
            <div class="modal-footer border-0 pt-0">
              <button type="button" class="btn btn-sm btn-outline-secondary" data-role="cancel">${cancelText}</button>
              <span class="hbg hbg-danger d-inline-block"><button type="button" class="hbg-core" data-role="confirm">${confirmText}</button></span>
            </div>
          </div>
        </div>
      </div>`);
    const el = document.getElementById(id);
    const modal = new bootstrap.Modal(el);
    const input = el.querySelector('[data-role="input"]');
    let resolved = false;
    const submit = () => { const val = input.value.trim(); resolved = true; modal.hide(); resolve(val || null); };
    el.querySelector('[data-role="confirm"]').addEventListener('click', submit);
    el.querySelector('[data-role="cancel"]').addEventListener('click', () => { resolved = true; modal.hide(); resolve(null); });
    el.addEventListener('hidden.bs.modal', () => { if (!resolved) resolve(null); el.remove(); });
    el.addEventListener('shown.bs.modal', () => input.focus());
    modal.show();
  });
}

// wirePasswordStrength: attaches a live rule-checklist below a password field and a
// live match indicator below its confirm field, and keeps Confirm Password disabled
// until Password satisfies every rule (so the user matches against a password that's
// actually going to be accepted, not one they'll have to go back and change).
// Mirrors backend/src/utils/validation.js's isStrongPassword EXACTLY (length 8+, one
// uppercase, one special character) so nothing the client accepts is ever rejected by
// the server, and vice versa. One implementation shared by every registration page
// rather than copy-pasted per page.
const PASSWORD_SPECIAL_CHARS_RE = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;
function isStrongPasswordClient(password) {
  return password.length >= 8 && /[A-Z]/.test(password) && PASSWORD_SPECIAL_CHARS_RE.test(password);
}

function wirePasswordStrength(passwordId, confirmId) {
  const passwordEl = document.getElementById(passwordId);
  const confirmEl = document.getElementById(confirmId);
  if (!passwordEl || !confirmEl) return;

  const rules = document.createElement('div');
  rules.className = 'pw-rules';
  rules.innerHTML = `
    <div class="pw-rule" data-rule="length"><i class="bi bi-circle"></i> At least 8 characters</div>
    <div class="pw-rule" data-rule="upper"><i class="bi bi-circle"></i> One uppercase letter (A-Z)</div>
    <div class="pw-rule" data-rule="special"><i class="bi bi-circle"></i> One special character (e.g. ! @ # $)</div>`;
  passwordEl.closest('.mb-3').after(rules);

  const matchBox = document.createElement('div');
  matchBox.className = 'pw-match d-none';
  confirmEl.closest('.mb-3').after(matchBox);

  confirmEl.disabled = true;
  confirmEl.placeholder = 'Meets the requirements above first';
  // Locked from the very start, same as confirmEl itself — updateRules() below only
  // re-locks/unlocks this button on a Password 'input' event, so without this line
  // it stays clickable the whole time before the user has typed anything at all.
  const initialEyeBtn = confirmEl.closest('.auth-icon-field')?.querySelector('.auth-eye-toggle');
  if (initialEyeBtn) initialEyeBtn.disabled = true;

  function updateRules() {
    const pw = passwordEl.value;
    const checks = { length: pw.length >= 8, upper: /[A-Z]/.test(pw), special: PASSWORD_SPECIAL_CHARS_RE.test(pw) };
    Object.entries(checks).forEach(([key, met]) => {
      const row = rules.querySelector(`[data-rule="${key}"]`);
      row.classList.toggle('met', met);
      row.querySelector('i').className = met ? 'bi bi-check-circle-fill' : 'bi bi-circle';
    });
    const strong = checks.length && checks.upper && checks.special;
    passwordEl.setCustomValidity(pw && !strong ? 'Password must be at least 8 characters and include an uppercase letter and a special character.' : '');
    // The eye-toggle button next to Confirm Password (see the auth-icon-field
    // markup on every registration/accept-invite page) locks in step with the
    // field itself — otherwise it stays clickable over a disabled, empty field,
    // which looks broken even though nothing harmful actually happens.
    const confirmEyeBtn = confirmEl.closest('.auth-icon-field')?.querySelector('.auth-eye-toggle');
    if (!strong) {
      confirmEl.disabled = true;
      confirmEl.value = '';
      confirmEl.type = 'password'; // reset to hidden so it starts hidden again next time it unlocks
      matchBox.classList.add('d-none');
      confirmEl.setCustomValidity('');
      if (confirmEyeBtn) {
        confirmEyeBtn.disabled = true;
        confirmEyeBtn.innerHTML = '<i class="bi bi-eye-slash"></i>';
        confirmEyeBtn.setAttribute('aria-label', 'Show password');
      }
    } else {
      confirmEl.disabled = false;
      confirmEl.placeholder = '';
      if (confirmEyeBtn) confirmEyeBtn.disabled = false;
    }
    return strong;
  }

  function updateMatch() {
    if (confirmEl.disabled) return;
    const cpw = confirmEl.value;
    if (!cpw) { matchBox.classList.add('d-none'); confirmEl.setCustomValidity(''); return; }
    const matches = passwordEl.value === cpw;
    matchBox.classList.remove('d-none');
    matchBox.classList.toggle('match', matches);
    matchBox.classList.toggle('no-match', !matches);
    matchBox.innerHTML = matches
      ? '<i class="bi bi-check-circle-fill"></i> Passwords match'
      : '<i class="bi bi-x-circle-fill"></i> Passwords do not match';
    confirmEl.setCustomValidity(matches ? '' : 'Passwords do not match');
  }

  passwordEl.addEventListener('input', () => { updateRules(); updateMatch(); });
  confirmEl.addEventListener('input', updateMatch);
}

// Shared password show/hide toggle — used on every password field across login,
// registration, and accept-invite pages.
function wireEyeToggle(inputId, buttonId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(buttonId);
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
}

// qtyWithUnit: formats a quantity with its requirement's unit (e.g. "500 kg"), or
// just the bare number if no unit was set on the requirement (unit is optional —
// see requirements.js's POST route). One helper so every GRN/PO page that shows a
// quantity formats it identically instead of each page deciding on its own whether/
// how to append the unit.
function qtyWithUnit(qty, unit) {
  return unit ? `${qty} ${unit}` : `${qty}`;
}


// ---------------------------------------------------------------------------
// Live-refresh helpers (used by the dispute pages)
// ---------------------------------------------------------------------------

// escapeHtml: user-typed text (chat messages, names, drafts) must never be dropped into
// innerHTML raw -- it breaks the layout on stray < > characters and is an XSS hole.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// setHtmlPreserving(container, html): the polling-safe replacement for `el.innerHTML = html`.
//   * If nothing changed since the last render, does NOTHING at all -- no DOM churn, so
//     scrolling, selecting and typing are never interrupted by a poll tick.
//   * If something did change, it carries over what a rebuild would otherwise destroy:
//     text the user typed into any textarea/input (by id), which field has focus and the
//     caret position, and the scroll position of every element marked data-scroll-key.
//     A scroll box that was at the bottom stays pinned to the bottom (so a new message
//     is visible); one the user scrolled up in keeps its position (so they can read back).
function setHtmlPreserving(container, html) {
  if (!container) return;
  if (container.dataset.lastHtml === html) return;

  const typed = {};
  container.querySelectorAll('textarea[id], input[id]').forEach(el => {
    if (!el.readOnly && !el.disabled && el.value !== el.defaultValue) typed[el.id] = el.value;
  });
  const active = document.activeElement;
  const focus = (active && container.contains(active) && active.id)
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const scrolls = {};
  container.querySelectorAll('[data-scroll-key]').forEach(el => {
    scrolls[el.dataset.scrollKey] = { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 24 };
  });

  container.innerHTML = html;
  container.dataset.lastHtml = html;

  Object.entries(typed).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el && !el.readOnly) el.value = value;
  });
  container.querySelectorAll('[data-scroll-key]').forEach(el => {
    const prev = scrolls[el.dataset.scrollKey];
    el.scrollTop = (!prev || prev.atBottom) ? el.scrollHeight : prev.top;
  });
  if (focus) {
    const el = document.getElementById(focus.id);
    if (el) {
      el.focus({ preventScroll: true });
      if (focus.start != null && el.setSelectionRange) { try { el.setSelectionRange(focus.start, focus.end); } catch (_) {} }
    }
  }
}

// renderChatThread(thread, viewerRole): shared chat layout for both sides of a dispute.
// Alignment is by VIEWER (your own messages on the right, the other side's on the left);
// colour is by SENDER ROLE and identical on both screens -- vendor messages are always
// yellow, Finance messages always the neutral green-grey -- so the same conversation looks
// the same to both parties. Back-to-back messages from one sender are grouped under one
// avatar, each in its own bubble on its own line; line breaks inside a message are kept.
function renderChatThread(thread, viewerRole) {
  // Group back-to-back messages from the same sender. Roles: 'vendor' (yellow) versus every
  // company-side role -- finance / procurement / warehouse -- (neutral grey).
  const groups = [];
  thread.forEach(m => {
    const role = m.sender_role || 'finance';
    const name = m.sender_name || (role === 'vendor' ? 'Vendor' : role.charAt(0).toUpperCase() + role.slice(1));
    const last = groups[groups.length - 1];
    if (last && last.role === role && last.name === name) last.messages.push(m);
    else groups.push({ role, name, messages: [m] });
  });
  return groups.map(g => {
    const mine = g.role === viewerRole;
    const tone = g.role === 'vendor' ? 'vendor' : 'finance';
    const initial = String(g.name).trim().charAt(0).toUpperCase() || '?';
    const lastMsg = g.messages[g.messages.length - 1];
    const avatar = `<div class="chat-avatar chat-avatar-${tone}">${escapeHtml(initial)}</div>`;
    return `
    <div class="chat-row ${mine ? 'chat-row-mine' : 'chat-row-theirs'}">
      ${!mine ? avatar : ''}
      <div class="chat-col">
        ${g.messages.map(m => `<div class="chat-bubble chat-bubble-${tone}">${escapeHtml(m.message)}</div>`).join('')}
        <div class="chat-meta">${escapeHtml(g.name)} · ${new Date(lastMsg.created_at).toLocaleString()}</div>
      </div>
      ${mine ? avatar : ''}
    </div>`;
  }).join('');
}

// buildDisputeThread(c, vendorName): the full conversation for one dispute, in the order it
// happened, identical for both sides: the dispute message Finance SENT is the first bubble
// (a Finance message sent at sent_at), then the legacy single vendor response if there is
// one, then every message since. Showing the original as a normal bubble -- instead of a
// separate grey box on one screen and an editable textarea on the other -- is what keeps
// the two sides looking the same. An UNSENT draft is not part of the thread (Finance edits
// it in the draft box; the vendor never sees it).
function buildDisputeThread(c, vendorName) {
  const items = [];
  if (c.status === 'sent' && c.draft_text) {
    items.push({ sender_role: 'finance', sender_name: 'Finance', message: c.draft_text, created_at: c.sent_at || c.created_at });
  }
  if (c.vendor_response) {
    items.push({ sender_role: 'vendor', sender_name: vendorName, message: c.vendor_response, created_at: c.vendor_responded_at });
  }
  (c.messages || []).forEach(m => items.push(m));
  return items.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}


// ---------------------------------------------------------------------------
// openThreadModal(opts): the shared message-thread dialog used by the quotation (pre-award)
// and purchase-order (post-award) conversations, on both the vendor and company sides. One
// implementation so the five pages that use it can never drift apart. Live while open (polls
// once a second, non-destructively -- see setHtmlPreserving -- so scrolling back through
// history and typing a reply both survive a refresh) and stops polling when closed.
//
//   title, subtitle  - header text
//   listUrl          - GET  -> [{ sender_role, sender_name, message, created_at, id }]
//   postUrl          - POST { message }
//   viewerRole       - 'vendor' | 'procurement' | 'warehouse' (decides which side is "mine")
//   statusUrl        - optional GET -> { closed: bool }  (e.g. a paid PO) -> reply box disabled,
//                      history stays visible
//   getTerms         - optional () => { price, delivery_days } | null. Shown live as the
//                      "current terms" strip; returning null means the item no longer exists
//                      in the open list (decided), so the thread is treated as closed.
//   closedNote       - text shown in place of the reply box when closed
//   readOnly         - true: show history only, no reply box (e.g. Warehouse just reading)
//   propose          - optional { mode: 'update' | 'counter', putUrl?, onUpdated? }
//        'update'  (vendor): inputs prefilled with the current terms; "Update my quotation"
//                  calls PUT putUrl, then drops a one-line note in the thread.
//        'counter' (procurement): "Propose new price / delivery days" posts the proposal as a
//                  message -- Procurement never edits a quotation directly, the vendor applies
//                  it with their own update.
// ---------------------------------------------------------------------------
let activeThreadModal = null;
function closeThreadModal() { if (activeThreadModal) activeThreadModal.close(); }

function openThreadModal(opts) {
  closeThreadModal();
  const overlay = document.createElement('div');
  overlay.className = 'thread-overlay';
  const p = opts.propose;
  overlay.innerHTML = `
    <div class="thread-dialog card p-3" role="dialog" aria-modal="true">
      <button type="button" class="thread-x" aria-label="Close">&times;</button>
      <div class="d-flex justify-content-between align-items-start thread-head-main">
        <div>
          <strong>${escapeHtml(opts.title)}</strong>
          ${opts.subtitle ? `<div class="text-muted small">${escapeHtml(opts.subtitle)}</div>` : ''}
        </div>
        <span class="badge bg-warning text-dark" id="threadBadge">Open</span>
      </div>
      <div class="alert alert-secondary mt-2 mb-0 py-2 small" id="threadTerms" style="display:none;"></div>
      <div class="mt-2">
        <label class="form-label small text-muted mb-1">Conversation</label>
        <div class="dispute-thread" id="threadBody" data-scroll-key="thread-modal"><p class="text-muted small">Loading...</p></div>
      </div>
      ${p ? `
      <div class="border rounded p-3 mt-3 bg-light" id="threadPropose">
        <p class="small mb-2"><strong>${p.mode === 'update' ? 'Update my quotation' : 'Propose new terms'}</strong> <span class="text-muted">— ${p.mode === 'update' ? 'changes the numbers on your quotation; the buyer sees them immediately.' : 'sent to the vendor as a message; only they can change their quotation.'}</span></p>
        <div class="row g-2">
          <div class="col-6"><label class="form-label small mb-1">${p.mode === 'update' ? 'Price (₹)' : 'Propose new price (₹)'}</label><input type="number" min="0" step="0.01" class="form-control" id="threadNewPrice"></div>
          <div class="col-6"><label class="form-label small mb-1">${p.mode === 'update' ? 'Delivery days' : 'Propose new delivery days'}</label><input type="number" min="1" step="1" class="form-control" id="threadNewDays"></div>
        </div>
        <div class="dispute-actions mt-2">
          <span class="hbg hbg-outline d-inline-block"><button type="button" class="hbg-core dispute-btn" id="threadProposeBtn">${p.mode === 'update' ? 'Update Quotation' : 'Send Proposal'}</button></span>
        </div>
        <div class="small mt-2" id="threadProposeMsg"></div>
      </div>` : ''}
      <div id="threadReplyBox">
        <div class="mt-2"><textarea class="form-control" id="threadReply" rows="2" placeholder="${escapeHtml(opts.placeholder || 'Send a message...')}"></textarea></div>
        <div class="dispute-actions mt-3">
          <span class="hbg d-inline-block"><button type="button" class="hbg-core dispute-btn" id="threadSend">Send Message</button></span>
        </div>
      </div>
      <div class="alert alert-secondary mt-2 mb-0 small" id="threadNote" style="display:none;"></div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = id => overlay.querySelector('#' + id);
  let timer = null, closed = false, prefilled = false, busy = false;

  function setClosed(isClosed) {
    closed = isClosed;
    const show = !isClosed && !opts.readOnly;
    $('threadReplyBox').style.display = show ? '' : 'none';
    if ($('threadPropose')) $('threadPropose').style.display = show ? '' : 'none';
    const badge = $('threadBadge');
    badge.className = isClosed ? 'badge bg-secondary' : 'badge bg-warning text-dark';
    badge.textContent = isClosed ? 'Closed' : (opts.openLabel || 'Open');
    const note = $('threadNote');
    const text = isClosed ? (opts.closedNote || 'This conversation is closed — history stays visible.')
      : (opts.readOnly ? 'Read-only — you can read this conversation but not post in it.' : '');
    note.textContent = text;
    note.style.display = text ? '' : 'none';
  }

  async function refresh() {
    if (!overlay.isConnected) return;
    const [mRes, sRes] = await Promise.all([fetchWithAuth(opts.listUrl), opts.statusUrl ? fetchWithAuth(opts.statusUrl) : Promise.resolve(null)]);
    if (!mRes || !mRes.ok) return;
    const messages = await mRes.json();
    let isClosed = false;
    if (sRes && sRes.ok) isClosed = !!(await sRes.json()).closed;

    if (opts.getTerms) {
      const t = opts.getTerms();
      const termsEl = $('threadTerms');
      if (t) {
        termsEl.style.display = '';
        termsEl.innerHTML = `Current terms: <strong>₹${escapeHtml(t.price)}</strong> · delivery in <strong>${escapeHtml(t.delivery_days)} days</strong>`;
        if (p && !prefilled) { $('threadNewPrice').value = t.price; $('threadNewDays').value = t.delivery_days; prefilled = true; }
      } else {
        isClosed = true; // no longer an open quotation: accepted or rejected
        termsEl.style.display = 'none';
      }
    }
    setClosed(isClosed);
    const sel = window.getSelection && window.getSelection();
    const body = $('threadBody');
    if (sel && !sel.isCollapsed && body.contains(sel.anchorNode)) return; // don't wipe a text selection
    setHtmlPreserving(body, messages.length
      ? renderChatThread(messages, opts.viewerRole)
      : `<p class="text-muted small">${escapeHtml(opts.emptyText || 'No messages yet.')}</p>`);
  }

  async function post(text) {
    const res = await fetchWithAuth(opts.postUrl, { method: 'POST', body: JSON.stringify({ message: text }) });
    if (!res) return false;
    if (!res.ok) { const e = await res.json().catch(() => ({})); alert(e.error || 'Failed to send'); return false; }
    return true;
  }

  $('threadSend').onclick = () => withButtonState($('threadSend'), async () => {
    const ta = $('threadReply'); const text = ta.value;
    if (!text.trim() || busy) return null;          // nothing to send: just reset the button
    busy = true;
    try {
      const ok = await post(text);
      if (ok) { ta.value = ''; await refresh(); }
      return ok;
    } finally { busy = false; }
  });
  $('threadReply').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('threadSend').click(); });

  if (p) {
    $('threadProposeBtn').onclick = () => withButtonState($('threadProposeBtn'), async () => {
      if (busy) return null;
      const price = $('threadNewPrice').value, days = $('threadNewDays').value;
      const msg = $('threadProposeMsg');
      if (!price && !days) { msg.className = 'small mt-2 text-danger'; msg.textContent = 'Enter a price and/or delivery days.'; return null; }
      busy = true;
      try {
        let ok = false;
        if (p.mode === 'update') {
          const res = await fetchWithAuth(p.putUrl, { method: 'PUT', body: JSON.stringify({ price: price || undefined, delivery_days: days || undefined }) });
          if (!res) return false;
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { msg.className = 'small mt-2 text-danger'; msg.textContent = data.error || 'Update failed'; return false; }
          msg.className = 'small mt-2 text-success'; msg.textContent = 'Quotation updated — the buyer sees the new numbers immediately.';
          await post(`Updated my quotation: price ₹${data.price}, delivery in ${data.delivery_days} days.`);
          if (p.onUpdated) p.onUpdated(data);
          ok = true;
        } else {
          const parts = [];
          if (price) parts.push(`price ₹${price}`);
          if (days) parts.push(`delivery in ${days} days`);
          ok = await post(`Counter-proposal: ${parts.join(', ')}. Please update your quotation if you can meet this.`);
          if (ok) { msg.className = 'small mt-2 text-success'; msg.textContent = 'Proposal sent.'; }
        }
        await refresh();
        return ok;
      } finally { busy = false; }
    });
  }

  function close() {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    activeThreadModal = null;
    if (opts.onClose) opts.onClose();
  }
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.thread-x').onclick = close;
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

  activeThreadModal = { close };
  refresh();
  timer = setInterval(refresh, 1000);
}

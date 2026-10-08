// frontend/shared/notifications.js
//
// Flow 6 — notifications for every role (vendor, procurement, finance, warehouse, company
// admin, platform admin). Loaded automatically by navbar.js, so every page that has the
// dock gets it without its own <script> tag. The backend decides which notifications a
// given login may see; this file just shows them. Two layers:
//   1. Persistent: the bell icon + dropdown read from GET /api/notifications/mine, so a
//      notification is waiting even if the vendor's tab was closed when it happened.
//   2. Real-time: a Socket.io connection (authenticated with the same JWT as the REST calls)
//      pops a toast the instant a notification is created, if this page is open.
// If the socket can't connect for ANY reason, layer 1 keeps working — this file never
// depends on the socket to show notifications.
(function () {
  const user = typeof getUser === 'function' ? getUser() : null;
  if (!user) return;
  const token = getToken();
  if (!token) return;

  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Where clicking a notification should take this role, by related_type.
  const LINKS = {
    vendor: { po: () => '/vendor/purchase-orders.html', po_invoice: () => '/vendor/my-invoices.html', quotation: () => '/vendor/my-quotations.html', invoice: () => '/vendor/my-invoices.html', dispute: () => '/vendor/disputes.html', account: () => '/vendor/dashboard.html' },
    procurement: { quotation: () => '/company/quotation-comparison.html', po: () => '/company/purchase-orders.html' },
    finance: { invoice: id => `/company/invoice-review.html?id=${id}`, dispute: () => '/company/disputes.html' },
    warehouse: { po: () => '/company/grn-entry.html' },
    company_admin: { account: () => '/company/dashboard.html' },
    platform_admin: { vendor: () => '/admin/vendor-verification.html', company: () => '/admin/company-verification.html', fraud_flag: () => '/admin/fraud-review.html' }
  };
  function linkFor(type, id) {
    const fn = (LINKS[user.role] || {})[type];
    return fn ? fn(id) : null;
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'notification-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000); // auto-dismiss, Uber-style
  }

  async function refreshUnreadBadge() {
    const badge = document.querySelector('.notification-badge');
    if (!badge) return;
    try {
      const res = await fetchWithAuth('/api/notifications/unread-count');
      if (!res || !res.ok) return;
      const { count } = await res.json();
      badge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '';
    } catch (_) { /* badge is cosmetic — never throw */ }
  }

  // ---- bell dropdown --------------------------------------------------------
  let dropdown = null;

  function closeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
  }

  function renderItems(rows) {
    if (!dropdown) return;
    const body = dropdown.querySelector('.notification-list');
    if (!rows.length) { body.innerHTML = '<div class="notification-empty">No notifications yet.</div>'; return; }
    body.innerHTML = rows.map(n => `
      <div class="notification-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-type="${esc(n.related_type || '')}" data-related="${esc(n.related_id == null ? '' : n.related_id)}">
        ${esc(n.message)}
        <span class="notification-time">${new Date(n.created_at).toLocaleString()}</span>
      </div>`).join('');
    body.querySelectorAll('.notification-item').forEach(el => {
      el.addEventListener('click', async () => {
        const id = el.dataset.id;
        const link = linkFor(el.dataset.type, el.dataset.related);
        try { await fetchWithAuth(`/api/notifications/${id}/read`, { method: 'POST' }); } catch (_) {}
        el.classList.remove('unread');
        refreshUnreadBadge();
        if (link) window.location.href = link;
      });
    });
  }

  async function loadDropdownItems() {
    try {
      const res = await fetchWithAuth('/api/notifications/mine');
      if (!res) return;
      const rows = await res.json();
      renderItems(res.ok ? rows : []);
    } catch (_) { renderItems([]); }
  }

  function toggleDropdown(bell) {
    if (dropdown) { closeDropdown(); return; }
    // Appended to <body>, not the dock: the dock has a CSS transform, which would turn
    // position:fixed inside it into position-relative-to-the-dock.
    dropdown = document.createElement('div');
    dropdown.className = 'notification-dropdown';
    dropdown.innerHTML = '<div class="notification-dropdown-head">Notifications</div><div class="notification-list"><div class="notification-empty">Loading...</div></div>';
    const r = bell.getBoundingClientRect();
    dropdown.style.top = (r.bottom + 14) + 'px';
    dropdown.style.right = Math.max(12, window.innerWidth - r.right - 20) + 'px';
    document.body.appendChild(dropdown);
    loadDropdownItems();
  }

  // The dropdown is position:fixed beneath the dock, and the dock slides away on scroll —
  // so close the dropdown on any scroll instead of leaving it floating on its own.
  window.addEventListener('scroll', closeDropdown, { passive: true });

  const bell = document.getElementById('notificationBell');
  if (bell) {
    bell.addEventListener('click', e => { e.stopPropagation(); toggleDropdown(bell); });
    document.addEventListener('click', e => { if (dropdown && !dropdown.contains(e.target)) closeDropdown(); });
  }
  refreshUnreadBadge();

  // ---- real-time layer ------------------------------------------------------
  function connectSocket() {
    const socket = io(API_BASE, { auth: { token } });
    socket.on('notification', notification => {
      showToast(notification.message);
      refreshUnreadBadge();
      if (dropdown) loadDropdownItems();
    });
    // Reconnects (e.g. after the backend restarts) may have missed events — resync the badge.
    socket.on('connect', refreshUnreadBadge);
    socket.on('connect_error', err => console.warn('[notifications] socket unavailable (bell still works):', err.message));
  }

  // The Socket.io server serves its own browser client at /socket.io/socket.io.js, so there is
  // no CDN or build step to depend on. If it can't be loaded, we just don't get live toasts.
  if (typeof io === 'function') connectSocket();
  else {
    const s = document.createElement('script');
    s.src = `${API_BASE}/socket.io/socket.io.js`;
    s.onload = () => { if (typeof io === 'function') connectSocket(); };
    s.onerror = () => console.warn('[notifications] could not load the Socket.io client; live toasts disabled (bell still works)');
    document.head.appendChild(s);
  }
})();

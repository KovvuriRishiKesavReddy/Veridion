// Renders a role-aware floating glassmorphism dock navbar into
// <div id="navbar-root"></div>. Injects its stylesheet and an icon font
// dynamically so no page's <head> needs editing to pick this up.
(function injectDockAssets() {
  if (!document.getElementById('dock-navbar-css')) {
    const link = document.createElement('link');
    link.id = 'dock-navbar-css';
    link.rel = 'stylesheet';
    link.href = '/shared/dock-navbar.css';
    document.head.appendChild(link);
  }
  if (!document.getElementById('bootstrap-icons-css')) {
    const link = document.createElement('link');
    link.id = 'bootstrap-icons-css';
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css';
    document.head.appendChild(link);
  }
})();

// Icon per link label — purely cosmetic, matched by hand to what each page
// actually does rather than a generic default per section.
const DOCK_ICONS = {
  'Dashboard': 'bi-house-door-fill',
  'Browse Requirements': 'bi-search',
  'My Quotations': 'bi-file-earmark-text',
  'Purchase Orders': 'bi-cart-check',
  'Deliveries (GRN)': 'bi-truck',
  'My Invoices': 'bi-receipt',
  'Disputes': 'bi-chat-left-text',
  'Payment Status': 'bi-cash-coin',
  'My Profile': 'bi-person-circle',
  'Vendor Directory': 'bi-diagram-3',
  'Team': 'bi-people',
  'Company Profile': 'bi-building',
  'Post Requirement': 'bi-plus-square',
  'Quotations': 'bi-file-earmark-text',
  'GRN Documents': 'bi-clipboard-check',
  'Invoices': 'bi-receipt',
  'Payments': 'bi-cash-coin',
  'GRN Entry': 'bi-box-seam',
  'Vendor Verification': 'bi-person-check-fill',
  'Company Verification': 'bi-building-check',
  'Fraud Review Queue': 'bi-shield-exclamation',
  'Override Log': 'bi-arrow-repeat' // a "cycle/override" glyph, distinct from the shield used for fraud
};

// Which dock links get a red notification dot, per role — keyed by [role][label]
// rather than by label alone, since several roles share a label (e.g. "Purchase
// Orders", "GRN Documents") but only some of them actually have something new to be
// notified about on that page. Adding a new notification anywhere is two steps: add
// an entry here (picks the dot's DOM id), then a matching watcher function below
// that calls updateDot(...) with that same id.
const DOCK_DOT_IDS = {
  vendor: {
    'Browse Requirements': 'dockNewReqDot',
    'Purchase Orders': 'dockOrderDot',
    'Deliveries (GRN)': 'dockGrnDot',
    'My Invoices': 'dockInvoiceDot',
    'Disputes': 'dockDisputeDot',
    'Payment Status': 'dockPaymentDot'
  },
  procurement: {
    'Quotations': 'dockQuotationDot',
    'GRN Documents': 'dockGrnDocDot'
  },
  finance: {
    'Invoices': 'dockInvoiceReviewDot',
    'Disputes': 'dockDisputeDot'
  },
  warehouse: {
    'GRN Entry': 'dockGrnEntryDot'
  },
  platform_admin: {
    'Vendor Verification': 'dockVendorVerifyDot',
    'Company Verification': 'dockCompanyVerifyDot',
    'Fraud Review Queue': 'dockFraudDot',
    'Override Log': 'dockOverrideDot'
  }
};

function renderNavbar() {
  const root = document.getElementById('navbar-root');
  if (!root) return;
  document.body.classList.add('has-dock-nav');
  const user = getUser();

  if (!user) {
    root.innerHTML = `
      <div class="dock-wrap" id="dockNav">
        <div class="dock-panel">
          <div class="dock-brand"><span class="dock-mark">V</span><span class="dock-label">VERIDION</span></div>
        </div>
      </div>`;
    return;
  }

  const linksByRole = {
    vendor: [
      ['/vendor/dashboard.html', 'Dashboard'],
      ['/vendor/requirements.html', 'Browse Requirements'],
      ['/vendor/my-quotations.html', 'My Quotations'],
      ['/vendor/purchase-orders.html', 'Purchase Orders'],
      ['/vendor/grn-documents.html', 'Deliveries (GRN)'],
      ['/vendor/my-invoices.html', 'My Invoices'],
      ['/vendor/disputes.html', 'Disputes'],
      ['/vendor/payments.html', 'Payment Status'],
      ['/vendor/profile.html', 'My Profile']
    ],
    company_admin: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/team.html', 'Team'],
      ['/company/vendor-directory.html', 'Vendor Directory'],
      ['/company/profile.html', 'Company Profile']
    ],
    procurement: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/post-requirement.html', 'Post Requirement'],
      ['/company/quotation-comparison.html', 'Quotations'],
      ['/company/purchase-orders.html', 'Purchase Orders'],
      ['/company/grn-documents.html', 'GRN Documents'],
      ['/company/vendor-directory.html', 'Vendor Directory']
    ],
    finance: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/purchase-orders.html', 'Purchase Orders'],
      ['/company/grn-documents.html', 'GRN Documents'],
      ['/company/invoices.html', 'Invoices'],
      ['/company/disputes.html', 'Disputes'],
      ['/company/payment.html', 'Payments']
    ],
    warehouse: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/grn-entry.html', 'GRN Entry'],
      ['/company/purchase-orders.html', 'Purchase Orders'],
      ['/company/grn-documents.html', 'GRN Documents']
    ],
    platform_admin: [
      ['/admin/dashboard.html', 'Dashboard'],
      ['/admin/vendor-verification.html', 'Vendor Verification'],
      ['/admin/company-verification.html', 'Company Verification'],
      ['/admin/fraud-review.html', 'Fraud Review Queue'],
      ['/admin/override-log.html', 'Override Log']
    ]
  };

  const currentPath = window.location.pathname;
  const links = (linksByRole[user.role] || [])
    .map(([href, label]) => {
      const icon = DOCK_ICONS[label] || 'bi-circle';
      const active = currentPath === href ? ' active' : '';
      const dotId = DOCK_DOT_IDS[user.role]?.[label];
      const dot = dotId ? `<span class="dock-dot" id="${dotId}" style="display:none;"></span>` : '';
      return `<a class="dock-item${active}" href="${href}" data-title="${label}"><i class="bi ${icon}"></i>${dot}</a>`;
    })
    .join('');

  root.innerHTML = `
    <div class="dock-wrap" id="dockNav">
      <div class="dock-panel">
        <div class="dock-brand"><span class="dock-mark">V</span><span class="dock-label">VERIDION</span></div>
        <div class="dock-items">${links}</div>
        <div class="dock-divider"></div>
        <div class="dock-user">
          <span class="dock-user-name">${user.name} · <span class="dock-user-role">${user.role}</span></span>
          <button class="dock-bell" id="notificationBell" data-title="Notifications" aria-label="Notifications"><i class="bi bi-bell-fill"></i><span class="notification-badge"></span></button>
          <button class="dock-logout" data-title="Log out" onclick="logout()"><i class="bi bi-box-arrow-right"></i></button>
        </div>
      </div>
    </div>`;

  initDockScrollHide();
  initDockMagnification();
  initDockTooltip();

  // Flow 6: every logged-in role gets the live-notification layer (socket + bell dropdown)
  // on every page that renders this navbar, without each page needing its own <script> tag.
  if (!document.getElementById('notifications-js')) {
    const s = document.createElement('script');
    s.id = 'notifications-js';
    s.src = '/shared/notifications.js';
    document.body.appendChild(s);
  }
}

// initDockMagnification: the actual "macOS dock" behavior — icons scale up
// continuously based on how close the cursor is, not just a flat on/off hover
// state, and the effect ripples smoothly to neighbouring icons too. Distance is
// computed on every mousemove and translated straight into a transform, and CSS's
// own transition (see .dock-item's `transition: transform ...` rule) smooths the
// motion between updates, giving one continuous, fluid motion as the cursor
// travels along the dock rather than a series of separate hover snaps.
function initDockMagnification() {
  const items = document.getElementById('dockNav')?.querySelectorAll('.dock-item, .dock-logout, .dock-bell');
  const track = document.querySelector('#dockNav .dock-items');
  if (!items || !items.length) return;

  const MAX_SCALE = 1.4;
  const FALLOFF = 110; // px — how far the magnification influence reaches
  const LIFT = 10;     // px — how high the peak icon rises
  const TILT = 5;       // deg — subtle lean toward the cursor, like a real dock

  // Cosine falloff instead of a straight line: the hovered icon peaks sharply
  // and neighbours taper off in a smooth bell curve, which reads much closer
  // to a real dock's magnification than a linear ramp does.
  function influenceFor(dist) {
    if (dist >= FALLOFF) return 0;
    return (Math.cos((dist / FALLOFF) * Math.PI) + 1) / 2;
  }

  // Batched through requestAnimationFrame (rather than recalculating on every
  // raw mousemove event) so the magnification stays fluid even on fast
  // cursor movement, with the CSS transition below smoothing each step into
  // one continuous, springy motion.
  let targetX = null;
  let rafId = null;
  function frame() {
    rafId = null;
    if (targetX === null) return;
    items.forEach(el => {
      const rect = el.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const dist = Math.abs(targetX - center);
      const influence = influenceFor(dist);
      const scale = 1 + influence * (MAX_SCALE - 1);
      const lift = influence * LIFT;
      const tilt = ((targetX - center) / FALLOFF) * TILT * influence;
      el.style.transform = `translateY(-${lift.toFixed(2)}px) scale(${scale.toFixed(3)}) rotate(${tilt.toFixed(2)}deg)`;
      // Bigger icons render above smaller ones, so the icon under the cursor
      // always sits in front of its shrinking neighbours instead of them
      // fighting for the same stacking layer.
      el.style.zIndex = influence > 0 ? String(10 + Math.round(influence * 10)) : '';
    });
  }
  function apply(mouseX) {
    targetX = mouseX;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  function reset() {
    targetX = null;
    items.forEach(el => { el.style.transform = ''; el.style.zIndex = ''; });
  }

  (track || document.getElementById('dockNav')).addEventListener('mousemove', (e) => apply(e.clientX));
  (track || document.getElementById('dockNav')).addEventListener('mouseleave', reset);
}

// initDockTooltip: a single tooltip element appended to <body>, shown/moved
// via getBoundingClientRect() on hover/focus rather than a per-icon CSS
// ::after. Living outside the dock entirely means it can never be clipped by
// a parent's overflow — which a purely-CSS tooltip inside the scrolling icon
// row kept running into.
function initDockTooltip() {
  let tip = document.getElementById('dockTooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'dockTooltip';
    tip.className = 'dock-tooltip';
    document.body.appendChild(tip);
  }
  const dock = document.getElementById('dockNav');
  if (!dock) return;
  const targets = dock.querySelectorAll('.dock-item, .dock-logout, .dock-bell');

  function show(el) {
    const title = el.getAttribute('data-title');
    if (!title) return;
    tip.textContent = title;
    const rect = el.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${rect.bottom + 10}px`;
    tip.classList.add('visible');
  }
  function hide() {
    tip.classList.remove('visible');
  }

  targets.forEach(el => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
  });
}

// Floating Navbar behavior: hides as the page scrolls down, reappears the
// moment the page scrolls up — so the dock never blocks content on a long
// page, but is always immediately available again. Registered once per
// render (safe to call repeatedly; only the latest listener does anything
// since it reads the current #dockNav element each time).
let dockScrollHideBound = false;
function initDockScrollHide() {
  if (dockScrollHideBound) return;
  dockScrollHideBound = true;
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const dock = document.getElementById('dockNav');
    if (!dock) return;
    const y = window.scrollY;
    if (y > lastY && y > 80) {
      dock.classList.add('dock-hidden');
    } else {
      dock.classList.remove('dock-hidden');
    }
    lastY = y;
  }, { passive: true });
}
document.addEventListener('DOMContentLoaded', () => {
  renderNavbar();
  enforceVendorVerification();
  enforceCompanyApproval();
  startVendorNotifications();
  startCompanyNotifications();
  startProcurementNotifications();
  startWarehouseNotifications();
  startAdminNotifications();
});

// --- Persistent "seen" state for dock notification dots ---------------------
// Dot-seen baselines live in localStorage, namespaced per user id — not
// sessionStorage. sessionStorage is scoped to a single tab and is gone the moment
// that tab closes, so a dot that had already been cleared by opening its page would
// come back the next time the app was opened in a new tab/window (including a
// "Remember Me" login being picked up fresh in a brand-new tab) — nothing new had
// actually happened, but the dot had no memory of already being seen. localStorage
// persists at the browser/device level, exactly like the "Remember Me" login itself
// (see setSession in api.js), so a cleared dot now STAYS cleared across every kind
// of reload — soft navigation, a hard refresh, closing and reopening the tab, even a
// full browser restart — until something genuinely new shows up. Namespacing by
// user id keeps one account's read-state from leaking onto another's dots on a
// shared browser.
//
// This is separate from the toast SEEN_* keys still used below, which stay in
// sessionStorage on purpose — a toast is a one-time pop-in, not a persistent unread
// indicator, so it's fine (arguably correct) for it to be able to announce itself
// again in a fresh tab.
function dotSeenKey(user, key) {
  return `veridion_dot_seen:${user.id}:${key}`;
}
function getDotSeen(user, key) {
  return Number(localStorage.getItem(dotSeenKey(user, key)) || 0);
}
function setDotSeen(user, key, value) {
  localStorage.setItem(dotSeenKey(user, key), String(value));
}

// updateDot: the shared logic behind every dock notification dot below.
//   user      - the logged-in user (for namespacing the persisted baseline)
//   key       - a stable string identifying this particular notification stream
//   elementId - the <span class="dock-dot"> id to show/hide
//   count     - how many "notification-worthy" items exist right now
//   onOwnPage - true when the user is currently sitting on the page this dot
//               points to; marks everything as seen immediately (every poll tick,
//               so it stays clear while they remain there) rather than waiting for
//               them to navigate there some other time.
function updateDot(user, key, elementId, count, onOwnPage) {
  if (onOwnPage) setDotSeen(user, key, count);
  const seen = getDotSeen(user, key);
  const dot = document.getElementById(elementId);
  if (dot) dot.style.display = count > seen ? 'block' : 'none';
}

// startVendorNotifications: runs on EVERY page (not just the page each of these
// events would naturally show up on), so a vendor finds out immediately no matter
// what page they're on — a toast only on the relevant page would mean they'd have
// to already be looking at that specific page to ever see it. Vendor-only; a no-op
// for every other role. Checks every 5 seconds (lighter than the 1-second
// live-refresh used on content pages — this is a background check, not a page's
// main data).
//
// Covers, each against its own last-seen baseline:
//   1. A new open requirement appearing to browse (Browse Requirements).
//   2. A quotation being accepted (status='selected') — the order is confirmed
//      (Purchase Orders).
//   3. A new GRN recorded against one of their POs — a delivery was logged
//      (Deliveries (GRN)).
//   4. An invoice's AI decision being reached (My Invoices).
//   5. An invoice being marked paid (Payment Status).
//   6. A new dispute being raised (status='sent' — the point it actually becomes
//      visible to the vendor; a still-drafting 'pending_send' dispute isn't
//      something they'd ever see) and new messages in an existing dispute
//      (Disputes).
// Every toast baseline follows the same pattern: the first check after login only
// records the current count and never toasts — otherwise every pre-existing item
// from before this session would incorrectly announce itself as "new" the moment
// the vendor logs in. Dot baselines (see updateDot) don't need that same guard —
// showing a dot for genuinely pre-existing unseen items is correct, not a
// false positive.
function startVendorNotifications() {
  const user = getUser();
  if (!user || user.role !== 'vendor') return;

  const SEEN_ORDER_KEY = 'veridion_seen_selected_quotation_count';
  const SEEN_DISPUTE_KEY = 'veridion_seen_sent_dispute_count';
  const SEEN_MESSAGE_KEY = 'veridion_seen_finance_message_count';

  async function checkRequirements() {
    try {
      const res = await fetchWithAuth('/api/requirements');
      if (!res || !res.ok) return;
      const open = await res.json();
      updateDot(user, 'new_requirements', 'dockNewReqDot', open.length,
        window.location.pathname.endsWith('/vendor/requirements.html'));
    } catch (err) {
      // Silent and non-critical — the next check five seconds later will catch up.
    }
  }

  async function checkOrders() {
    try {
      const res = await fetchWithAuth('/api/quotations/mine');
      if (!res || !res.ok) return;
      const all = await res.json();
      const accepted = all.filter(q => q.status === 'selected');

      updateDot(user, 'selected_quotations', 'dockOrderDot', accepted.length,
        window.location.pathname.endsWith('/vendor/purchase-orders.html'));

      const seenRaw = sessionStorage.getItem(SEEN_ORDER_KEY);
      if (seenRaw !== null) {
        const seen = Number(seenRaw);
        if (accepted.length > seen) {
          const newest = accepted.slice().sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))[0];
          showToast(`Your quotation for "${newest?.requirement_title || 'a requirement'}" was accepted — a Purchase Order has been generated. <a href="/vendor/purchase-orders.html">view it</a>.`);
        }
      }
      sessionStorage.setItem(SEEN_ORDER_KEY, String(accepted.length));
    } catch (err) {
      // Silent and non-critical — a missed check is never worth surfacing an
      // error over; the next check five seconds later will catch up.
    }
  }

  async function checkGrn() {
    try {
      const res = await fetchWithAuth('/api/grn/vendor');
      if (!res || !res.ok) return;
      const all = await res.json();
      updateDot(user, 'grn_deliveries', 'dockGrnDot', all.length,
        window.location.pathname.endsWith('/vendor/grn-documents.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  async function checkInvoices() {
    try {
      const res = await fetchWithAuth('/api/invoices/mine');
      if (!res || !res.ok) return;
      const all = await res.json();
      const decided = all.filter(inv => inv.final_decision);
      const paid = all.filter(inv => inv.status === 'paid');

      updateDot(user, 'invoice_decisions', 'dockInvoiceDot', decided.length,
        window.location.pathname.endsWith('/vendor/my-invoices.html'));
      updateDot(user, 'invoices_paid', 'dockPaymentDot', paid.length,
        window.location.pathname.endsWith('/vendor/payments.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  async function checkDisputes() {
    try {
      const res = await fetchWithAuth('/api/vendor-communications/mine');
      if (!res || !res.ok) return;
      const all = await res.json();
      const sent = all.filter(d => d.status === 'sent');
      const unresolved = sent.filter(d => !d.resolved);

      updateDot(user, 'sent_disputes', 'dockDisputeDot', unresolved.length,
        window.location.pathname.endsWith('/vendor/disputes.html'));

      const seenDisputeRaw = sessionStorage.getItem(SEEN_DISPUTE_KEY);
      if (seenDisputeRaw !== null) {
        const seen = Number(seenDisputeRaw);
        if (sent.length > seen) {
          const newest = sent.slice().sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
          const label = newest ? (newest.invoice_number || `#${newest.invoice_id}`) : '';
          showToast(`A new dispute was raised on Invoice ${label} — <a href="/vendor/disputes.html">view it</a>.`);
        }
      }
      sessionStorage.setItem(SEEN_DISPUTE_KEY, String(sent.length));

      // New message within an EXISTING dispute conversation — Finance replying,
      // not the dispute itself first appearing (that's the check above).
      const financeMessageCount = all.reduce((sum, d) => sum + (d.messages || []).filter(m => m.sender_role === 'finance').length, 0);
      const seenMessageRaw = sessionStorage.getItem(SEEN_MESSAGE_KEY);
      if (seenMessageRaw !== null) {
        const seenMsgs = Number(seenMessageRaw);
        if (financeMessageCount > seenMsgs) {
          showToast(`New message from Finance on a dispute — <a href="/vendor/disputes.html">view it</a>.`);
        }
      }
      sessionStorage.setItem(SEEN_MESSAGE_KEY, String(financeMessageCount));
    } catch (err) {
      // Same posture as checkOrders above — silent and non-critical.
    }
  }

  checkRequirements();
  checkOrders();
  checkGrn();
  checkInvoices();
  checkDisputes();
  setInterval(checkRequirements, 5000);
  setInterval(checkOrders, 5000);
  setInterval(checkGrn, 5000);
  setInterval(checkInvoices, 5000);
  setInterval(checkDisputes, 5000);
}

// startCompanyNotifications: the Finance-side mirror of startVendorNotifications
// above — same reasoning (runs globally so Finance finds out immediately
// regardless of which page they're on, not just while already on Disputes/
// Invoices; dot baselines persist via updateDot so pre-existing unseen items
// correctly still show a dot). Finance-only; a no-op for every other role.
function startCompanyNotifications() {
  const user = getUser();
  if (!user || user.role !== 'finance') return;

  const SEEN_PENDING_KEY = 'veridion_seen_pending_dispute_count';
  const SEEN_VENDOR_MESSAGE_KEY = 'veridion_seen_vendor_message_count';

  async function checkDisputes() {
    try {
      const res = await fetchWithAuth('/api/vendor-communications');
      if (!res || !res.ok) return;
      const all = await res.json();
      const pending = all.filter(d => d.status === 'pending_send');
      const unresolvedSent = all.filter(d => d.status === 'sent' && !d.resolved);
      const needsAttention = pending.length + unresolvedSent.length;

      updateDot(user, 'finance_disputes', 'dockDisputeDot', needsAttention,
        window.location.pathname.endsWith('/company/disputes.html'));

      const seenPendingRaw = sessionStorage.getItem(SEEN_PENDING_KEY);
      if (seenPendingRaw !== null) {
        const seen = Number(seenPendingRaw);
        if (pending.length > seen) {
          const newest = pending.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
          showToast(`A new dispute needs review on Invoice ${newest?.invoice_number || `#${newest?.invoice_id}`} — <a href="/company/disputes.html">view it</a>.`);
        }
      }
      sessionStorage.setItem(SEEN_PENDING_KEY, String(pending.length));

      // A new message from the VENDOR'S side of an existing conversation —
      // distinct from a brand-new dispute appearing (that's the check above).
      const vendorMessageCount = all.reduce((sum, d) => sum + (d.messages || []).filter(m => m.sender_role === 'vendor').length, 0);
      const seenMsgRaw = sessionStorage.getItem(SEEN_VENDOR_MESSAGE_KEY);
      if (seenMsgRaw !== null) {
        const seenMsgs = Number(seenMsgRaw);
        if (vendorMessageCount > seenMsgs) {
          showToast(`New message from a vendor on a dispute — <a href="/company/disputes.html">view it</a>.`);
        }
      }
      sessionStorage.setItem(SEEN_VENDOR_MESSAGE_KEY, String(vendorMessageCount));
    } catch (err) {
      // Same posture as startVendorNotifications — silent and non-critical.
    }
  }

  // New invoice reaching a point that needs Finance's action: the AI decision has
  // landed (final_decision is set) but it hasn't been paid yet — an
  // auto_approved invoice waiting on "Approve Payment", or a flagged/suspicious
  // one waiting on review + override. An invoice still mid-pipeline (no decision
  // yet) isn't actionable, so it isn't counted here.
  async function checkInvoices() {
    try {
      const res = await fetchWithAuth('/api/invoices/company');
      if (!res || !res.ok) return;
      const all = await res.json();
      const needsAction = all.filter(inv => inv.final_decision && inv.status !== 'paid');
      updateDot(user, 'finance_invoices', 'dockInvoiceReviewDot', needsAction.length,
        window.location.pathname.endsWith('/company/invoices.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  checkDisputes();
  checkInvoices();
  setInterval(checkDisputes, 5000);
  setInterval(checkInvoices, 5000);
}

// startProcurementNotifications: procurement's own dots — a new quotation waiting
// to be compared/accepted (Quotations), and a new GRN recorded against one of
// their POs (GRN Documents). Procurement-only; a no-op for every other role.
function startProcurementNotifications() {
  const user = getUser();
  if (!user || user.role !== 'procurement') return;

  async function checkQuotations() {
    try {
      const res = await fetchWithAuth('/api/quotations/company');
      if (!res || !res.ok) return;
      const submitted = await res.json(); // already submitted-only, see routes/quotations.js
      updateDot(user, 'procurement_quotations', 'dockQuotationDot', submitted.length,
        window.location.pathname.endsWith('/company/quotation-comparison.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  async function checkGrn() {
    try {
      const res = await fetchWithAuth('/api/grn/company');
      if (!res || !res.ok) return;
      const all = await res.json();
      updateDot(user, 'procurement_grn', 'dockGrnDocDot', all.length,
        window.location.pathname.endsWith('/company/grn-documents.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  checkQuotations();
  checkGrn();
  setInterval(checkQuotations, 5000);
  setInterval(checkGrn, 5000);
}

// startWarehouseNotifications: a dot on GRN Entry for any PO that still needs a
// delivery recorded against it (fulfillment_status != 'fulfilled') — this is
// warehouse's actual job queue, not just "something changed". Warehouse-only; a
// no-op for every other role.
function startWarehouseNotifications() {
  const user = getUser();
  if (!user || user.role !== 'warehouse') return;

  async function check() {
    try {
      const res = await fetchWithAuth('/api/purchase-orders/mine');
      if (!res || !res.ok) return;
      const all = await res.json();
      const pending = all.filter(po => po.fulfillment_status !== 'fulfilled');
      updateDot(user, 'warehouse_pending_pos', 'dockGrnEntryDot', pending.length,
        window.location.pathname.endsWith('/company/grn-entry.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  check();
  setInterval(check, 5000);
}

// startAdminNotifications: four independent dots, one per platform_admin page —
// Vendor Verification (a new pending vendor), Company Verification (a new pending
// company), Fraud Review Queue (a new unresolved fraud flag), Override Log (a new Finance
// override). Each clears only when
// its own page is opened, not when any of the others are — that's the whole point
// of splitting them out of the single combined Dashboard dot they replaced.
// platform_admin-only; a no-op for every other role.
function startAdminNotifications() {
  const user = getUser();
  if (!user || user.role !== 'platform_admin') return;

  async function checkVendors() {
    try {
      const res = await fetchWithAuth('/api/admin/vendors');
      if (!res || !res.ok) return;
      const vendors = await res.json();
      const pending = vendors.filter(v => v.verification_status === 'pending').length;
      updateDot(user, 'admin_pending_vendors', 'dockVendorVerifyDot', pending,
        window.location.pathname.endsWith('/admin/vendor-verification.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  async function checkCompanies() {
    try {
      const res = await fetchWithAuth('/api/admin/companies');
      if (!res || !res.ok) return;
      const companies = await res.json();
      const pending = companies.filter(c => c.approval_status === 'pending').length;
      updateDot(user, 'admin_pending_companies', 'dockCompanyVerifyDot', pending,
        window.location.pathname.endsWith('/admin/company-verification.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  async function checkFraud() {
    try {
      const res = await fetchWithAuth('/api/admin/fraud-flags');
      if (!res || !res.ok) return;
      const flags = await res.json();
      const unresolved = flags.filter(f => !f.resolved).length;
      updateDot(user, 'admin_unresolved_fraud', 'dockFraudDot', unresolved,
        window.location.pathname.endsWith('/admin/fraud-review.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  // Overrides are append-only (no "resolved" state), so the running COUNT(*) is itself the
  // monotonically increasing number updateDot compares against the last-seen count.
  async function checkOverrides() {
    try {
      const res = await fetchWithAuth('/api/admin/overrides/count');
      if (!res || !res.ok) return;
      const { count } = await res.json();
      updateDot(user, 'admin_overrides', 'dockOverrideDot', count,
        window.location.pathname.endsWith('/admin/override-log.html'));
    } catch (err) {
      // Silent and non-critical.
    }
  }

  checkVendors();
  checkCompanies();
  checkFraud();
  checkOverrides();
  setInterval(checkVendors, 5000);
  setInterval(checkCompanies, 5000);
  setInterval(checkFraud, 5000);
  setInterval(checkOverrides, 5000);
}

// Backend routes already reject an unverified vendor's API calls (see
// requireVerifiedVendor middleware) — this is just the frontend half, so a
// bookmarked/direct URL to the dashboard redirects cleanly instead of rendering a
// page full of 403 errors. Never trust this alone for security; the backend check
// is what actually matters.
async function enforceVendorVerification() {
  const user = getUser();
  if (!user || user.role !== 'vendor') return;
  if (window.location.pathname.includes('/vendor/awaiting-approval.html')) return;

  const res = await fetchWithAuth('/api/auth/me');
  if (!res) return;
  const me = await res.json();
  if (me.vendor_verification_status !== 'verified') {
    window.location.href = '/vendor/awaiting-approval.html';
  }
}

// Same pattern, same caveat, for company-scoped roles — see requireApprovedCompany on
// the backend, which is what actually enforces this regardless of what this does.
// No-ops for 'vendor' and 'platform_admin', neither of which is scoped to a single
// company's approval.
async function enforceCompanyApproval() {
  const user = getUser();
  if (!user || !['company_admin', 'procurement', 'finance', 'warehouse'].includes(user.role)) return;
  if (window.location.pathname.includes('/company/awaiting-approval.html')) return;

  const res = await fetchWithAuth('/api/auth/me');
  if (!res) return;
  const me = await res.json();
  if (me.company_approval_status !== 'approved') {
    window.location.href = '/company/awaiting-approval.html';
  }
}

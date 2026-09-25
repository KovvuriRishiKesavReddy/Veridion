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
  'GRN Entry': 'bi-box-seam'
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
      ['/admin/dashboard.html', 'Dashboard']
    ]
  };

  const currentPath = window.location.pathname;
  const links = (linksByRole[user.role] || [])
    .map(([href, label]) => {
      const icon = DOCK_ICONS[label] || 'bi-circle';
      const active = currentPath === href ? ' active' : '';
      let dot = '';
      if (label === 'Disputes') dot = '<span class="dock-dot" id="dockDisputeDot" style="display:none;"></span>';
      if (label === 'Purchase Orders') dot = '<span class="dock-dot" id="dockOrderDot" style="display:none;"></span>';
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
          <button class="dock-logout" data-title="Log out" onclick="logout()"><i class="bi bi-box-arrow-right"></i></button>
        </div>
      </div>
    </div>`;

  initDockScrollHide();
  initDockMagnification();
  initDockTooltip();
}

// initDockMagnification: the actual "macOS dock" behavior — icons scale up
// continuously based on how close the cursor is, not just a flat on/off hover
// state, and the effect ripples smoothly to neighbouring icons too. Distance is
// computed on every mousemove and translated straight into a transform, and CSS's
// own transition (see .dock-item's `transition: transform ...` rule) smooths the
// motion between updates, giving one continuous, fluid motion as the cursor
// travels along the dock rather than a series of separate hover snaps.
function initDockMagnification() {
  const items = document.getElementById('dockNav')?.querySelectorAll('.dock-item, .dock-logout');
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
  const targets = dock.querySelectorAll('.dock-item, .dock-logout');

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
});

// startVendorNotifications: runs on EVERY page (not just the page each of these
// events would naturally show up on), so a vendor finds out immediately no matter
// what page they're on — a toast only on the relevant page would mean they'd have
// to already be looking at that specific page to ever see it. Vendor-only; a no-op
// for every other role. Checks every 5 seconds (lighter than the 1-second
// live-refresh used on content pages — this is a background check, not a page's
// main data).
//
// Covers three separate events, each compared against its own last-seen baseline
// in sessionStorage:
//   1. A quotation being accepted (status='selected') — the order is confirmed.
//   2. A new dispute being raised (status='sent' — the point it actually becomes
//      visible to the vendor; a still-drafting 'pending_send' dispute isn't
//      something they'd ever see).
//   3. A new message arriving in a dispute they're ALREADY in (Finance replying to
//      an ongoing conversation) — distinct from #2, which only fires once per
//      dispute, when it first appears.
// Every one of these follows the same pattern: the first check after login only
// records the current count as a baseline and never toasts — otherwise every
// pre-existing item from before this session would incorrectly announce itself as
// "new" the moment the vendor logs in.
function startVendorNotifications() {
  const user = getUser();
  if (!user || user.role !== 'vendor') return;

  const SEEN_ORDER_KEY = 'veridion_seen_selected_quotation_count';
  const SEEN_DISPUTE_KEY = 'veridion_seen_sent_dispute_count';
  const SEEN_MESSAGE_KEY = 'veridion_seen_finance_message_count';
  // Separate from the SEEN_* keys above: those advance every 5-second poll purely
  // to avoid repeat toasts. These only advance when the vendor actually opens the
  // relevant page, so the dot stays lit until it's genuinely been looked at —
  // not just for one poll cycle.
  const DOT_SEEN_ORDER_KEY = 'veridion_dot_seen_selected_quotation_count';
  const DOT_SEEN_DISPUTE_KEY = 'veridion_dot_seen_sent_dispute_count';

  async function checkOrders() {
    try {
      const res = await fetchWithAuth('/api/quotations/mine');
      if (!res || !res.ok) return;
      const all = await res.json();
      const accepted = all.filter(q => q.status === 'selected');

      if (window.location.pathname.endsWith('/vendor/purchase-orders.html')) {
        sessionStorage.setItem(DOT_SEEN_ORDER_KEY, String(accepted.length));
      }
      const dotSeen = Number(sessionStorage.getItem(DOT_SEEN_ORDER_KEY) || 0);
      const dot = document.getElementById('dockOrderDot');
      if (dot) dot.style.display = accepted.length > dotSeen ? 'block' : 'none';

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

  async function checkDisputes() {
    try {
      const res = await fetchWithAuth('/api/vendor-communications/mine');
      if (!res || !res.ok) return;
      const all = await res.json();
      const sent = all.filter(d => d.status === 'sent');
      const unresolved = sent.filter(d => !d.resolved);

      if (window.location.pathname.endsWith('/vendor/disputes.html')) {
        sessionStorage.setItem(DOT_SEEN_DISPUTE_KEY, String(unresolved.length));
      }
      const dotSeen = Number(sessionStorage.getItem(DOT_SEEN_DISPUTE_KEY) || 0);
      const dot = document.getElementById('dockDisputeDot');
      if (dot) dot.style.display = unresolved.length > dotSeen ? 'block' : 'none';

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

  checkOrders();
  checkDisputes();
  setInterval(checkOrders, 5000);
  setInterval(checkDisputes, 5000);
}

// startCompanyNotifications: the Finance-side mirror of startVendorNotifications
// above — same reasoning (runs globally so Finance finds out immediately
// regardless of which page they're on, not just while already on Disputes;
// baseline-first-check so pre-existing items never falsely announce themselves as
// new on login). Finance-only; a no-op for every other role.
function startCompanyNotifications() {
  const user = getUser();
  if (!user || user.role !== 'finance') return;

  const SEEN_PENDING_KEY = 'veridion_seen_pending_dispute_count';
  const SEEN_VENDOR_MESSAGE_KEY = 'veridion_seen_vendor_message_count';
  // Same reasoning as DOT_SEEN_* in startVendorNotifications — only advances when
  // Finance actually opens Disputes, not on every 5-second poll.
  const DOT_SEEN_KEY = 'veridion_dot_seen_finance_dispute_count';

  async function check() {
    try {
      const res = await fetchWithAuth('/api/vendor-communications');
      if (!res || !res.ok) return;
      const all = await res.json();
      const pending = all.filter(d => d.status === 'pending_send');
      const unresolvedSent = all.filter(d => d.status === 'sent' && !d.resolved);
      const needsAttention = pending.length + unresolvedSent.length;

      if (window.location.pathname.endsWith('/company/disputes.html')) {
        sessionStorage.setItem(DOT_SEEN_KEY, String(needsAttention));
      }
      const dotSeen = Number(sessionStorage.getItem(DOT_SEEN_KEY) || 0);
      const dot = document.getElementById('dockDisputeDot');
      if (dot) dot.style.display = needsAttention > dotSeen ? 'block' : 'none';

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
  check();
  setInterval(check, 5000);
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

// Renders a role-aware Bootstrap navbar into <div id="navbar-root"></div>
function renderNavbar() {
  const root = document.getElementById('navbar-root');
  if (!root) return;
  const user = getUser();
  if (!user) {
    root.innerHTML = `
      <nav class="navbar navbar-expand-lg navbar-dark mb-4">
        <div class="container">
          <span class="navbar-brand">VERIDION</span>
        </div>
      </nav>`;
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
      ['/company/profile.html', 'Company Profile']
    ],
    procurement: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/post-requirement.html', 'Post Requirement'],
      ['/company/quotation-comparison.html', 'Quotations'],
      ['/company/purchase-orders.html', 'Purchase Orders'],
      ['/company/grn-documents.html', 'GRN Documents']
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

  const links = (linksByRole[user.role] || [])
    .map(([href, label]) => `<li class="nav-item"><a class="nav-link" href="${href}">${label}</a></li>`)
    .join('');

  root.innerHTML = `
    <nav class="navbar navbar-expand-lg navbar-dark mb-4">
      <div class="container">
        <span class="navbar-brand">VERIDION</span>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navContent">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navContent">
          <ul class="navbar-nav me-auto">${links}</ul>
          <span class="navbar-text me-3 text-light small">${user.name} · <span class="text-warning">${user.role}</span></span>
          <button class="btn btn-sm btn-outline-light" onclick="logout()">Log out</button>
        </div>
      </div>
    </nav>`;
}
document.addEventListener('DOMContentLoaded', () => {
  renderNavbar();
  enforceVendorVerification();
  enforceCompanyApproval();
  startDisputeNotifications();
});

// startDisputeNotifications: runs on EVERY page (not just disputes.html), so a vendor
// finds out a dispute has been raised against them right away no matter what page
// they're on — a toast only on disputes.html itself would mean they'd have to already
// be looking at that specific page to ever see it. Vendor-only; a no-op for every
// other role. Checks every 5 seconds (lighter than the 1-second live-refresh used on
// content pages — this is a background check, not the page's main data).
//
// "New" means the count of this vendor's SENT disputes (status='sent' — the point at
// which a dispute actually becomes visible to them; a still-drafting 'pending_send'
// dispute isn't something they'd ever see) has gone up since the last check. The
// first check after login only records the current count as a baseline and never
// toasts — otherwise every pre-existing dispute from before this session would
// incorrectly announce itself as "new" the moment the vendor logs in.
function startDisputeNotifications() {
  const user = getUser();
  if (!user || user.role !== 'vendor') return;
  const SEEN_KEY = 'veridion_seen_sent_dispute_count';

  async function check() {
    try {
      const res = await fetchWithAuth('/api/vendor-communications/mine');
      if (!res || !res.ok) return;
      const all = await res.json();
      const sent = all.filter(d => d.status === 'sent');
      const seenRaw = sessionStorage.getItem(SEEN_KEY);
      if (seenRaw !== null) {
        const seen = Number(seenRaw);
        if (sent.length > seen) {
          const newest = sent.slice().sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
          const label = newest ? (newest.invoice_number || `#${newest.invoice_id}`) : '';
          showToast(`A new dispute was raised on Invoice ${label} — <a href="/vendor/disputes.html">view it</a>.`);
        }
      }
      sessionStorage.setItem(SEEN_KEY, String(sent.length));
    } catch (err) {
      // Silent and non-critical — a missed notification check is never worth
      // surfacing an error over; the next check five seconds later will catch up.
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

// Renders a role-aware Bootstrap navbar into <div id="navbar-root"></div>
function renderNavbar() {
  const root = document.getElementById('navbar-root');
  if (!root) return;
  const user = getUser();
  if (!user) {
    root.innerHTML = `
      <nav class="navbar navbar-expand-lg navbar-dark mb-4">
        <div class="container">
          <a class="navbar-brand" href="/login.html">VERIDION</a>
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
      ['/vendor/payments.html', 'Payment Status']
    ],
    company_admin: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/team.html', 'Team'],
      ['/company/post-requirement.html', 'Post Requirement'],
      ['/company/quotation-comparison.html', 'Quotations'],
      ['/company/purchase-orders.html', 'Purchase Orders'],
      ['/company/grn-entry.html', 'GRN Entry'],
      ['/company/grn-documents.html', 'GRN Documents'],
      ['/company/invoices.html', 'Invoices']
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
        <a class="navbar-brand" href="/login.html">VERIDION</a>
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
});

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

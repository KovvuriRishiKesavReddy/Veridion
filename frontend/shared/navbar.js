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
      ['/vendor/my-invoices.html', 'My Invoices']
    ],
    company_admin: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/team.html', 'Team'],
      ['/company/post-requirement.html', 'Post Requirement'],
      ['/company/quotation-comparison.html', 'Quotations'],
      ['/company/grn-entry.html', 'GRN Entry']
    ],
    procurement: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/post-requirement.html', 'Post Requirement'],
      ['/company/quotation-comparison.html', 'Quotations']
    ],
    finance: [
      ['/company/dashboard.html', 'Dashboard']
    ],
    warehouse: [
      ['/company/dashboard.html', 'Dashboard'],
      ['/company/grn-entry.html', 'GRN Entry']
    ],
    platform_admin: [
      ['/company/dashboard.html', 'Dashboard']
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
document.addEventListener('DOMContentLoaded', renderNavbar);

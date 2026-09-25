// Shared widgets for the three dashboard pages (vendor, company, admin):
// a lightweight auto-playing tip carousel, and a role-aware FAQ accordion.
// Both are purely presentational — no API calls, so nothing here needs to
// coordinate with each page's pollEvery() loops.

const DashCarousel = (() => {
  const state = {};
  function init(id) {
    const root = document.getElementById(id);
    if (!root) return;
    const track = root.querySelector('.dash-carousel-track');
    const slides = root.querySelectorAll('.dash-carousel-slide');
    const dotsWrap = document.getElementById('dots-' + id);
    dotsWrap.innerHTML = '';
    slides.forEach((_, i) => {
      const d = document.createElement('button');
      if (i === 0) d.className = 'active';
      d.addEventListener('click', () => setIndex(id, i));
      dotsWrap.appendChild(d);
    });
    state[id] = { track, count: slides.length, dots: dotsWrap.querySelectorAll('button'), index: 0, timer: null };
    render(id);
    state[id].timer = setInterval(() => go(id, 1), 5000);
    root.addEventListener('mouseenter', () => clearInterval(state[id].timer));
    root.addEventListener('mouseleave', () => { state[id].timer = setInterval(() => go(id, 1), 5000); });
  }
  function render(id) {
    const s = state[id];
    if (!s) return;
    s.track.style.transform = `translateX(-${s.index * 100}%)`;
    s.dots.forEach((d, i) => d.classList.toggle('active', i === s.index));
  }
  function go(id, dir) {
    const s = state[id];
    if (!s) return;
    s.index = (s.index + dir + s.count) % s.count;
    render(id);
  }
  function setIndex(id, i) { if (state[id]) { state[id].index = i; render(id); } }
  return { init, go, setIndex };
})();

// Role-scoped FAQ copy. Kept here (rather than duplicated per page) so all three
// dashboards draw from one place if the product copy needs updating later.
const DASH_FAQ = {
  vendor: [
    ['How do I submit a quotation?', 'Open Browse Requirements, pick a requirement that fits what you supply, and click Submit Quotation. Enter your price, delivery time, and any notes — the buyer sees it immediately.'],
    ['When can I invoice a purchase order?', 'Only once a PO is fully delivered and confirmed by the buyer\'s warehouse. It will show up automatically under "Ready to Invoice" on this dashboard.'],
    ['Why was my invoice flagged?', 'Our AI verification pipeline checks your invoice against the PO and delivery records. A mismatch in amount, quantity, or GST details can trigger a flag — you can withdraw and resubmit a corrected invoice.'],
    ['How is the agreed delivery date set?', 'It comes from the delivery days you quote when submitting your quotation — once the buyer accepts, that becomes the agreed delivery date on the PO.'],
    ['Can I withdraw a quotation after submitting it?', 'Yes, as long as the buyer hasn\'t accepted it yet — open My Quotations and withdraw it, then resubmit with updated pricing if needed.']
  ],
  'company-admin': [
    ['How do I invite a new teammate?', 'Go to Manage Team, enter their email and role (Procurement, Finance, or Warehouse), and they\'ll receive an invite link to set up their account.'],
    ['Can I change a teammate\'s role later?', 'Yes — from Manage Team you can update a member\'s role or revoke their access at any time.'],
    ['Why can\'t I see requirements or invoices?', 'Company Admin is scoped to team management and company profile only — Procurement, Finance, and Warehouse each have their own dedicated views for that operational data.'],
    ['How do I update our company profile?', 'Open Company Profile to edit your GSTIN, address, and registered documents — changes may need re-verification by the platform.'],
    ['What happens if our company gets rejected?', 'Your team keeps their logins but can\'t post requirements, accept quotations, record deliveries, or approve payments until an admin re-approves the company profile.']
  ],
  procurement: [
    ['How do I post a new requirement?', 'Use Post Requirement, fill in the category, quantity, and deadline — it becomes visible to every verified vendor on the platform immediately.'],
    ['How are quotations ranked?', 'The Context Gate scores each quotation on price, delivery fit, and the vendor\'s past performance with your company — you can still accept any vendor, not just the top-ranked one.'],
    ['What happens after I accept a quotation?', 'A Purchase Order is generated automatically and the vendor is notified right away — the requirement closes to further quotes.'],
    ['Where do I track deliveries?', 'GRN Documents shows every goods receipt recorded by your Warehouse team against each PO.'],
    ['Can I edit a requirement after posting it?', 'Not once vendors have started quoting — close it and post a corrected version instead, so every vendor is quoting on the same information.']
  ],
  finance: [
    ['When can I approve a payment?', 'Only once an invoice is auto-approved by the AI verification pipeline — flagged invoices need review first, from the Needs Review list.'],
    ['What does "flagged" mean on an invoice?', 'The verification pipeline found a mismatch — in amount, quantity, or a fraud signal — and it needs a human decision before payment.'],
    ['How do I see what a vendor was paid historically?', 'The Invoices page lists every invoice with its status and payment date — filter or search by vendor name.'],
    ['Can I dispute an invoice with a vendor?', 'Yes — open Disputes to send the vendor a message about the mismatch; they can respond directly in the same thread.'],
    ['Where do I see how much is owed in total?', 'The Amount Payable figure on this dashboard sums every invoice currently awaiting payment — click into Payments for the full breakdown by vendor.']
  ],
  warehouse: [
    ['How do I record a delivery?', 'Go to GRN Entry, pick the purchase order that just arrived, and enter the received quantity and date — partial deliveries are supported.'],
    ['What if less arrives than expected?', 'Record what actually arrived; you can optionally note when the remaining quantity is expected next.'],
    ['Can I see pricing on this page?', 'No — GRN Entry is intentionally quantity-only. No price or payment information is shown to Warehouse.'],
    ['What happens when a PO is fully received?', 'Its fulfillment status automatically updates to "fulfilled", which is what makes it eligible for the vendor to invoice.'],
    ['Do I need to confirm every single delivery?', 'Yes — each GRN entry is what proves goods actually arrived, so Finance only pays for what Warehouse has confirmed on record.']
  ],
  admin: [
    ['How do I approve a vendor?', 'Expand their row in Vendor Verification to review their submitted documents, then click Approve or Reject.'],
    ['What happens when I reject a company?', 'Nobody on that company\'s team can post requirements, accept quotations, record deliveries, or approve payments until it\'s approved.'],
    ['What triggers a fraud flag?', 'A high-severity signal from the Context Gate — like a shell company pattern or split billing — bypasses the normal weighted decision and lands directly in the Fraud Review queue.'],
    ['Can I revoke an approval later?', 'Yes — both vendor and company approvals can be revoked at any time from their respective verification tables.'],
    ['How quickly should I clear the approval queue?', 'Aim for under 48 hours — vendors and companies can\'t do anything on the platform until they\'re approved, so delays block real business.']
  ]
};

function renderDashFaq(containerId, key) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = DASH_FAQ[key] || [];
  container.innerHTML = items.map((item, i) => `
    <div class="dash-faq-item${i === 0 ? ' open' : ''}">
      <button class="dash-faq-q" type="button">
        <span class="dfq-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="dfq-text">${item[0]}</span>
        <span class="dfq-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></span>
      </button>
      <div class="dash-faq-a"><div class="dash-faq-a-inner">${item[1]}</div></div>
    </div>`).join('');
  container.querySelectorAll('.dash-faq-item').forEach(el => {
    el.querySelector('.dash-faq-q').addEventListener('click', () => el.classList.toggle('open'));
  });
}

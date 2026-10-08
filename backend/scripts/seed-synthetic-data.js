// backend/scripts/seed-synthetic-data.js
//
// Builds a known-ground-truth dataset by calling the REAL API end-to-end — registration,
// admin approval, requirement, quotation, PO, GRN, and invoice submission (with a genuinely
// generated PDF file upload) — rather than inserting fabricated rows into
// document_extractions/matching_results/etc. This is deliberate: the whole claim being tested
// is "a real PDF invoice goes in, OCR reads it, the agents reconcile it correctly" — skipping
// the PDF/OCR step would only prove the downstream math is correct GIVEN perfect extraction,
// which is a materially weaker and less honest claim for a report.
//
// Requires the backend AND ai-service already running (npm run dev in both) plus RabbitMQ,
// since this hits the real HTTP API. Run against a TEST database — same safety convention as
// test-flow6.js: refuses to run unless the database NAME contains "test", since this creates
// real accounts and data. The platform admin login (admin@veridion.dev / password123, from
// `npm run seed`) must already exist in that database.
//
// Output:
//   synthetic-dataset-results.json  — the 15 main ground-truth cases     -> scripts/evaluate.js
//   vendor-state-results.json       — the 8 vendor-state structural cases -> scripts/evaluate-vendor-states.js
//
// Usage: npm run seed:synthetic            (everything)
//        SEED_ONLY=main npm run seed:synthetic          (just the 15 main cases)
//        SEED_ONLY=vendor-state npm run seed:synthetic  (just the vendor-state cases)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fetch = require('node-fetch'); // npm install node-fetch@2 form-data --save-dev, if not already present
const FormData = require('form-data');
const PDFDocument = require('pdfkit'); // already a dependency — used for PO generation
const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');

const BASE = process.env.EVAL_BASE_URL || 'http://localhost:4000';
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const ADMIN_EMAIL = process.env.EVAL_ADMIN_EMAIL || 'admin@veridion.dev';
const ADMIN_PASSWORD = process.env.EVAL_ADMIN_PASSWORD || 'password123';
const PASSWORD = 'Passw0rd!';
const ONLY = (process.env.SEED_ONLY || 'all').toLowerCase();
const DECISION_TIMEOUT_MS = Number(process.env.EVAL_DECISION_TIMEOUT_MS || 120000);
const DEGRADED_WARMUPS = Number(process.env.EVAL_DEGRADED_WARMUPS || 3);       // flagged warm-ups for degraded-history-1
const BOUNDARY_FLAGGED_WARMUPS = Number(process.env.EVAL_BOUNDARY_WARMUPS || 1); // flagged warm-ups for boundary-1

let dbName = '';
try { dbName = new URL(DB_URL).pathname; } catch (_) { /* malformed / empty URL — refused below */ }
if (!/test/i.test(dbName)) {
  console.error('Refusing to run: the database name in TEST_DATABASE_URL / DATABASE_URL must contain "test" — this creates real accounts/data.');
  process.exit(1);
}
const pool = new Pool({ connectionString: DB_URL });

const RUN_TAG = Date.now().toString(36); // keeps emails / bank accounts / addresses unique across re-runs
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dateStr = offsetDays => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toISOString().slice(0, 10); };

// ---------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------
async function api(method, urlPath, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function loginAs(email, password) {
  return api('POST', '/api/auth/login', null, { email, password }); // { token, user }
}

// ---------------------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------------------
// generateInvoicePdf: writes a real PDF to a temp file with deliberately chosen values, so
// Agent 1 (OCR) has to genuinely extract them — this is the one function every test case
// calls, varying just the numbers to encode a scenario.
function generateInvoicePdf({ vendorName, gstin, invoiceNumber, itemDescription, quantity, unitPrice, baseAmount, gstAmount, totalAmount }) {
  const filePath = path.join(os.tmpdir(), `synthetic-invoice-${invoiceNumber}-${Date.now()}.pdf`);
  const doc = new PDFDocument();
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  doc.fontSize(16).text('TAX INVOICE', { align: 'center' }).moveDown();
  doc.fontSize(11)
    .text(`Vendor: ${vendorName}`)
    .text(`GSTIN: ${gstin}`)
    .text(`Invoice Number: ${invoiceNumber}`)
    .moveDown()
    .text(`Item: ${itemDescription}`)
    .text(`Quantity: ${quantity}`)
    .text(`Unit Price: Rs. ${unitPrice}`)
    .moveDown()
    .text(`Subtotal: Rs. ${baseAmount}`)
    .text(`GST: Rs. ${gstAmount}`)
    .text(`Total (incl. GST): Rs. ${totalAmount}`);
  doc.end();
  // 'finish' on the WriteStream (not doc's 'end') is the reliable "fully flushed to disk" signal.
  return new Promise((resolve, reject) => { stream.on('finish', () => resolve(filePath)); stream.on('error', reject); });
}

// ---------------------------------------------------------------------------------------
// Account setup — vendors, the synthetic company and its team
// ---------------------------------------------------------------------------------------
let vendorCounter = 0;

// registerVendor: registers + logs in + has Platform Admin verify. overrides lets a case pin
// e.g. bank_account_number (shell-company case) or the GSTIN.
async function registerVendor(n, overrides = {}, adminToken) {
  const gstin = overrides.gstin || `27AAAPV${1000 + n}C1ZV`;
  const email = `synthetic.vendor${n}.${RUN_TAG}@test.dev`;
  const fields = {
    name: `Synthetic Vendor ${n}`,
    email,
    password: PASSWORD,
    company_name: `Synthetic Vendor ${n} Pvt Ltd`,
    gstin,
    pan: `AAAPV${1000 + n}C`,
    phone_number: `+9198765${String(40000 + n).padStart(5, '0')}`,
    address: overrides.address || `${n} Synthetic Industrial Estate, run ${RUN_TAG}`,
    bank_account_number: overrides.bank_account_number || `SYN${RUN_TAG}${100000 + n}`,
    bank_ifsc: 'HDFC0000001'
  };
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  form.append('business_reg_proof', Buffer.from('dummy proof'), { filename: 'proof.txt' });
  form.append('pan_proof', Buffer.from('dummy pan'), { filename: 'pan.txt' });
  const res = await fetch(`${BASE}/api/auth/register/vendor`, { method: 'POST', body: form, headers: form.getHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(`Vendor registration failed: ${JSON.stringify(body)}`);

  const login = await loginAs(email, PASSWORD); // login carries vendor_id (registration's user object doesn't)
  const vendorId = login.user.vendor_id;
  await api('POST', `/api/admin/vendors/${vendorId}/verify`, adminToken, { status: 'verified' });
  return { n, token: login.token, vendorId, email, gstin, name: fields.company_name, bank: fields.bank_account_number };
}

async function newVendor(ctx, overrides = {}) {
  vendorCounter += 1;
  return registerVendor(vendorCounter, overrides, ctx.adminToken);
}

// setupCompany: registers one synthetic company, has Platform Admin approve it, then invites
// + accepts procurement / finance / warehouse users through the real invite flow.
async function setupCompany(adminToken) {
  const companyEmail = `synthetic.company.${RUN_TAG}@test.dev`;
  const form = new FormData();
  form.append('name', 'Synthetic Company Admin');
  form.append('email', companyEmail);
  form.append('password', PASSWORD);
  form.append('company_name', `Synthetic Buyer Co ${RUN_TAG}`);
  form.append('gstin', '27AAACS1000C1ZV');
  form.append('address', 'Synthetic Corporate Park');
  form.append('industry_type', 'Construction Materials');
  form.append('registration_proof', Buffer.from('dummy registration'), { filename: 'reg.txt' });
  const res = await fetch(`${BASE}/api/auth/register/company`, { method: 'POST', body: form, headers: form.getHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(`Company registration failed: ${JSON.stringify(body)}`);
  const companyId = body.user.company_id;
  await api('POST', `/api/admin/companies/${companyId}/approve`, adminToken, { status: 'approved' });
  const adminLogin = await loginAs(companyEmail, PASSWORD);

  const team = {};
  for (const role of ['procurement', 'finance', 'warehouse']) {
    const email = `synthetic.${role}.${RUN_TAG}@test.dev`;
    const invite = await api('POST', '/api/company/invite', adminLogin.token, { invited_email: email, invited_role: role });
    await api('POST', `/api/auth/accept-invite/${invite.invitation.token}`, null, { name: `Synthetic ${role}`, password: PASSWORD });
    team[role] = { email, token: (await loginAs(email, PASSWORD)).token };
  }
  return { companyId, adminEmail: companyEmail, adminToken: adminLogin.token, team };
}

// ---------------------------------------------------------------------------------------
// The per-invoice workflow
// ---------------------------------------------------------------------------------------
const GST_RATE = { cement: 0.28, bricks: 0.05, steel: 0.18 }; // mirrors compliance.js; anything else -> 0.18
const rateFor = category => GST_RATE[category] ?? 0.18;
const round2 = x => Math.round(x * 100) / 100;

// spec(): fills in the derived numbers so each case only states what makes it DIFFERENT.
function spec(o) {
  const category = o.category || 'cement';
  const qty = o.qty ?? 100;
  const unitPrice = o.unitPrice ?? 100;
  const grns = o.grns || [qty];
  const invQty = o.invQty ?? grns.reduce((a, b) => a + b, 0);
  const invBase = o.invBase ?? round2(invQty * unitPrice);
  const invGst = o.invGst ?? round2(invBase * rateFor(category));
  return {
    id: o.id, label: o.label, category,
    title: o.title || 'Cement',
    itemDescription: o.item || 'OPC 53 Grade Cement, 50kg bags',
    qty, unitPrice, poAmount: round2(qty * unitPrice), grns,
    invoiceQuantity: invQty, invoiceBaseAmount: invBase, invoiceGstAmount: invGst,
    invoiceTotal: o.invTotal ?? round2(invBase + invGst),
    invoiceGstin: o.invGstin || null,               // null -> the vendor's own registered GSTIN
    deliveryDays: o.deliveryDays ?? 5,
    lateDays: o.lateDays ?? 0,                       // >0: GRN dated that many days AFTER the agreed delivery date
    expectedDecision: o.expect
  };
}

async function postRequirement(ctx, s) {
  return api('POST', '/api/requirements', ctx.company.team.procurement.token, {
    title: s.title, description: `Synthetic evaluation requirement (${s.id})`, category: s.category,
    quantity: s.qty, unit: 'units', deadline: dateStr(30)
  });
}

// buildTestCase: quotation -> accept (PO) -> GRN(s) -> real PDF -> invoice upload. Returns as
// soon as the invoice is accepted by the API; the async pipeline runs on its own afterwards.
async function buildTestCase(ctx, vendor, s, requirement) {
  const req = requirement || await postRequirement(ctx, s);
  // 1. Vendor submits a quotation for the posted requirement.
  const quotation = await api('POST', '/api/quotations', vendor.token, { requirement_id: req.id, price: s.poAmount, delivery_days: s.deliveryDays });
  // 2. Procurement accepts it -> PO created.
  const po = await api('POST', `/api/quotations/${quotation.id}/accept`, ctx.company.team.procurement.token);
  // 3. Warehouse records the GRN(s) this scenario needs (a single full one, split deliveries, over-delivery...).
  const receivedDate = dateStr(s.deliveryDays + s.lateDays);
  for (const q of s.grns) {
    await api('POST', '/api/grn', ctx.company.team.warehouse.token, { po_id: po.id, received_quantity: q, received_date: s.lateDays ? receivedDate : dateStr(0) });
  }
  // 4. Generate the real PDF and submit it as the invoice — multipart, exactly like a vendor's browser.
  const gstin = s.invoiceGstin || vendor.gstin;
  const invoiceNumber = `SYN-${RUN_TAG}-${s.id}`;
  const pdfPath = await generateInvoicePdf({
    vendorName: vendor.name, gstin, invoiceNumber, itemDescription: s.itemDescription,
    quantity: s.invoiceQuantity, unitPrice: s.unitPrice, baseAmount: s.invoiceBaseAmount,
    gstAmount: s.invoiceGstAmount, totalAmount: s.invoiceTotal
  });
  const form = new FormData();
  form.append('po_id', String(po.id));
  form.append('invoice_number', invoiceNumber);
  form.append('invoice_amount', String(s.invoiceBaseAmount));
  form.append('invoice_quantity', String(s.invoiceQuantity));
  form.append('gst_amount', String(s.invoiceGstAmount));
  form.append('gstin_on_invoice', gstin);
  form.append('invoice_file', fs.createReadStream(pdfPath), { filename: `${s.id}.pdf`, contentType: 'application/pdf' });
  const res = await fetch(`${BASE}/api/invoices`, { method: 'POST', headers: { Authorization: `Bearer ${vendor.token}`, ...form.getHeaders() }, body: form });
  const invoice = await res.json();
  fs.unlinkSync(pdfPath);
  if (!res.ok) throw new Error(`Invoice submission failed for ${s.id}: ${JSON.stringify(invoice)}`);
  return { id: s.id, invoice_id: invoice.id, po_id: po.id, requirement_id: req.id, vendor_id: vendor.vendorId, expected_decision: s.expectedDecision, label: s.label };
}

async function waitForDecision(invoiceId, timeoutMs = DECISION_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool.query(`SELECT * FROM decisions WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1`, [invoiceId]);
    if (r.rows[0]) return r.rows[0];
    await sleep(1000);
  }
  throw new Error(`Invoice ${invoiceId} never got a decision within ${timeoutMs}ms — is RabbitMQ/ai-service running?`);
}

// A warm-up is a full real round-trip whose result is discarded — its only purpose is to move
// the vendor's (company, vendor) risk row through the real onGrnConfirmed /
// onInvoiceDecisionFinalised update path. Waits for the decision so the NEXT step sees the update.
async function warmup(ctx, vendor, s) {
  const r = await buildTestCase(ctx, vendor, s);
  await waitForDecision(r.invoice_id);
  await sleep(1500); // on-grn-confirmed is fire-and-forget; give it a beat to land
  return r;
}

const cleanWarmup = tag => spec({ id: `warmup-clean-${tag}`, label: 'warm-up (clean)', expect: 'auto_approved' });
// A "bad" warm-up: late delivery AND a quantity mismatch. The invoice mismatch is what actually
// drags invoice_accuracy_pct down (decide.js's vendor_risk verdict is read from that metric);
// the late GRN additionally degrades on_time_delivery_pct.
const badWarmup = tag => spec({ id: `warmup-bad-${tag}`, label: 'warm-up (late + mismatch)', lateDays: 4, deliveryDays: 1, invQty: 70, invBase: 10000, expect: 'flagged' });

// ---------------------------------------------------------------------------------------
// TEST_CASES: the 15 ground-truth scenarios, expressed as concrete PDF-invoice content. Each
// expectedDecision is a claim about what the system SHOULD conclude, written down BEFORE
// running anything — which is what makes this a real evaluation rather than post-hoc
// rationalising. (Every case registers its own brand-new, zero-history vendor.)
// ---------------------------------------------------------------------------------------
const TEST_CASES = [
  // --- 8 clean (should auto_approve) ---
  spec({ id: 'clean-1', label: 'Exact match, cement', expect: 'auto_approved' }),
  spec({ id: 'clean-2', label: 'Exact match, PPC cement 200 bags', qty: 200, unitPrice: 95, item: 'PPC Cement 50kg bags', expect: 'auto_approved' }),
  spec({ id: 'clean-3', label: 'Exact match, TMT steel bars', category: 'steel', title: 'TMT Steel Bars', item: 'Fe 500D TMT Steel Bars 12mm', qty: 50, unitPrice: 400, expect: 'auto_approved' }),
  spec({ id: 'clean-4', label: 'Exact match, steel rods', category: 'steel', title: 'Steel Rods', item: 'Mild Steel Rods 10mm', qty: 80, unitPrice: 250, expect: 'auto_approved' }),
  spec({ id: 'clean-5', label: 'Exact match, clay bricks (5% GST)', category: 'bricks', title: 'Bricks', item: 'Red Clay Bricks, first class', qty: 1000, unitPrice: 8, expect: 'auto_approved' }),
  spec({ id: 'clean-6', label: 'Exact match, fly ash bricks (5% GST)', category: 'bricks', title: 'Fly Ash Bricks', item: 'Fly Ash Bricks 9 inch', qty: 500, unitPrice: 7, expect: 'auto_approved' }),
  spec({ id: 'clean-7', label: 'Exact match, paint (default 18% GST)', category: 'paint', title: 'Paint', item: 'Exterior Emulsion Paint 20L', qty: 40, unitPrice: 450, expect: 'auto_approved' }),
  spec({ id: 'clean-8', label: 'Exact match, office chairs (default 18% GST)', category: 'furniture', title: 'Office Chairs', item: 'Ergonomic Office Chairs', qty: 25, unitPrice: 1200, expect: 'auto_approved' }),

  // --- 4 legitimate variance (should still auto_approve) ---
  // NOTE: the original doc's variance-1 was "GRN 90, invoice 90 against a 100 PO". The real
  // invoice route refuses to accept an invoice while the PO is still partially_fulfilled
  // (Flow 1 rule), so that exact scenario can't be built through the real API. The realistic
  // equivalent is a delivery split across two GRNs that cumulatively fulfil the PO.
  spec({ id: 'variance-1', label: 'Delivered in two GRNs (90 + 10), invoice matches cumulative total', grns: [90, 10], expect: 'auto_approved' }),
  spec({ id: 'variance-2', label: 'Over-delivery 110 vs PO 100, billed proportionally', grns: [110], expect: 'auto_approved' }),
  spec({ id: 'variance-3', label: 'Invoice item wording differs from requirement title', category: 'steel', title: 'TMT Steel Bars', item: 'Fe 500D Thermo-Mechanically Treated TMT Steel Bars 16mm', qty: 60, unitPrice: 380, expect: 'auto_approved' }),
  spec({ id: 'variance-4', label: 'Billed 0.5% above PO rate (inside the 1% rounding tolerance)', invBase: 10050, expect: 'auto_approved' }),

  // --- 2 genuine mismatch (should flag) ---
  spec({ id: 'mismatch-1', label: 'Invoice quantity does not match GRN', invQty: 70, invBase: 10000, expect: 'flagged' }),
  spec({ id: 'mismatch-2', label: 'Invoice amount 20% above the PO price', invBase: 12000, expect: 'flagged' }),

  // --- 1 planted fraud pattern (should go suspicious) ---
  // Everything else is clean; ONLY the GSTIN on the invoice document differs from the
  // registered vendor's — deliberately WRONG, but still a validly-formatted GSTIN.
  spec({ id: 'fraud-1', label: 'Invoice GSTIN does not match registered vendor', invGstin: '27ZZZZZ9999Z1ZZ', expect: 'suspicious' })
];

async function runMainCases(ctx) {
  console.log(`\nBuilding ${TEST_CASES.length} synthetic test cases against ${BASE}...`);
  const results = [];
  for (const tc of TEST_CASES) {
    const vendor = await newVendor(ctx); // fresh vendor = data_volume 0, no history
    const result = await buildTestCase(ctx, vendor, tc);
    results.push(result);
    console.log(`  [${tc.id}] invoice_id=${result.invoice_id} expected=${tc.expectedDecision}`);
  }
  fs.writeFileSync(path.join(__dirname, 'synthetic-dataset-results.json'), JSON.stringify(results, null, 2));
  console.log('Ground truth written to synthetic-dataset-results.json — evaluate.js reads this next.');
  return results;
}

// ---------------------------------------------------------------------------------------
// VENDOR_STATE_CASES (7.2b): structural checks on how the system reacts to a vendor's
// ACCUMULATED state. They need different setup (legacy import, warm-up round-trips, a second
// vendor or second invoice) than buildTestCase's one-vendor-one-invoice shape, so each is its
// own async builder below. Results go to vendor-state-results.json and are scored by
// evaluate-vendor-states.js with case-specific checks — NOT folded into the accuracy number.
// ---------------------------------------------------------------------------------------

// The shared "reference scenario": a clean delivery split over two GRNs. Run on a zero-history
// vendor (variance-1), a legacy-imported vendor (legacy-1), an earned-history vendor
// (earned-history-1) and a degraded vendor (degraded-history-1) so the outcomes line up.
const refScenario = id => spec({ id, label: `reference scenario (${id})`, grns: [90, 10], expect: 'auto_approved' });

// Addition 1 — call the real Flow 5 legacy-import route as the company admin.
async function legacyImportVendor(ctx, vendorId, { transactionCount, onTimePct }) {
  return api('POST', `/api/company/vendors/${vendorId}/legacy-import`, ctx.company.adminToken, {
    estimated_transaction_count: transactionCount,
    estimated_on_time_pct: onTimePct,
    justification: 'Synthetic evaluation — simulating a vendor with real offline history.',
    confirmed: true
  });
}

// Addition 3 — read the ranking directly instead of accepting either quotation.
async function checkRanking(ctx, requirementId, highHistoryVendorId, freshVendorId) {
  const ranked = await api('GET', `/api/requirements/${requirementId}/quotations`, ctx.company.team.procurement.token); // ordered by ai_rank_score DESC
  const highHistoryRank = ranked.findIndex(q => q.vendor_id === highHistoryVendorId);
  const freshRank = ranked.findIndex(q => q.vendor_id === freshVendorId);
  return { passed: highHistoryRank !== -1 && freshRank !== -1 && highHistoryRank < freshRank, ranked: ranked.map(q => ({ vendor_id: q.vendor_id, ai_rank_score: q.ai_rank_score, price: q.price, delivery_days: q.delivery_days })) };
}

async function riskSnapshot(companyId, vendorId) {
  const r = await pool.query(`SELECT * FROM vendor_risk_scores WHERE company_id = $1 AND vendor_id = $2`, [companyId, vendorId]);
  return r.rows[0] || null;
}

async function runVendorStateCases(ctx, mainResults) {
  console.log('\nBuilding vendor-state cases (7.2b)...');
  const out = {};
  const note = (k, v) => console.log(`  [${k}] ${v}`);

  // Zero-history reference — normally variance-1 from the main run. If only the vendor-state
  // cases are being seeded, build a fresh reference here so the three-way comparison still works.
  let fresh = (mainResults || []).find(r => r.id === 'variance-1');
  if (!fresh) {
    const v = await newVendor(ctx);
    fresh = await buildTestCase(ctx, v, refScenario('fresh-reference'));
    note('fresh-reference', `invoice_id=${fresh.invoice_id}`);
  }
  out.fresh_reference = { invoice_id: fresh.invoice_id };

  // Addition 1 — legacy-imported vendor, same reference scenario.
  const legacyVendor = await newVendor(ctx);
  await legacyImportVendor(ctx, legacyVendor.vendorId, { transactionCount: 24, onTimePct: 95 });
  const legacy1 = await buildTestCase(ctx, legacyVendor, refScenario('legacy-1'));
  // Expected auto_approved. The point is this result AND its gate_weights read side by side with
  // the zero-history vendor's: vendor_risk carries ~0 weight for the fresh vendor, substantial
  // weight for this one — evaluate-vendor-states.js checks that difference in the saved agent_inputs.
  out.legacy_1 = { ...legacy1, expected_decision: 'auto_approved', legacy_vendor_id: legacyVendor.vendorId };
  note('legacy-1', `invoice_id=${legacy1.invoice_id}`);

  // Addition 2 — earned history: two real clean round-trips, THEN the labelled invoice.
  const earnedVendor = await newVendor(ctx);
  await warmup(ctx, earnedVendor, cleanWarmup('earned-a'));
  await warmup(ctx, earnedVendor, cleanWarmup('earned-b'));
  const earned1 = await buildTestCase(ctx, earnedVendor, refScenario('earned-history-1'));
  out.earned_history_1 = { ...earned1, expected_decision: 'auto_approved' };
  note('earned-history-1', `invoice_id=${earned1.invoice_id}`);

  // Addition 3 — ranking: high-history (legacy) vendor vs a brand-new one, identical price and delivery_days.
  const freshQuoter = await newVendor(ctx);
  const rankReq = await postRequirement(ctx, spec({ id: 'ranking-1' }));
  const pricing = { requirement_id: rankReq.id, price: 10000, delivery_days: 5 };
  await api('POST', '/api/quotations', legacyVendor.token, pricing);
  await api('POST', '/api/quotations', freshQuoter.token, pricing);
  const ranking = await checkRanking(ctx, rankReq.id, legacyVendor.vendorId, freshQuoter.vendorId);
  out.ranking_1 = { requirement_id: rankReq.id, high_history_vendor_id: legacyVendor.vendorId, fresh_vendor_id: freshQuoter.vendorId, passed: ranking.passed, ranked: ranking.ranked };
  note('ranking-1', `passed=${ranking.passed} order=${ranking.ranked.map(q => q.vendor_id).join(' > ')}`);

  // Addition 4 — degraded history: real warm-up round-trips that go badly (late + mismatched), then the reference scenario.
  const degradedVendor = await newVendor(ctx);
  for (let i = 1; i <= DEGRADED_WARMUPS; i++) await warmup(ctx, degradedVendor, badWarmup(`degraded-${i}`));
  const degraded1 = await buildTestCase(ctx, degradedVendor, refScenario('degraded-history-1'));
  out.degraded_history_1 = { ...degraded1, expected_decision: 'flagged' };
  note('degraded-history-1', `invoice_id=${degraded1.invoice_id}`);
  await waitForDecision(degraded1.invoice_id); // its own risk update must land before the next snapshot

  // Addition 3b — ranking between a GOOD-history vendor (legacy-1's) and the DEGRADED one, same
  // price and delivery_days. Added because ranking-1 (good history vs a cold-start vendor) can't
  // distinguish "history helps" from "history can only hurt": a cold-start vendor's past-performance
  // signal has zero weight, so with Price and Delivery tied at 1.0 it scores exactly 1.0 and no
  // vendor with an imperfect record can ever beat it. Good-vs-bad history is the comparison the
  // Past Performance signal can genuinely order.
  const rankReq2 = await postRequirement(ctx, spec({ id: 'ranking-2' }));
  const pricing2 = { requirement_id: rankReq2.id, price: 10000, delivery_days: 5 };
  await api('POST', '/api/quotations', legacyVendor.token, pricing2);
  await api('POST', '/api/quotations', degradedVendor.token, pricing2);
  const ranking2 = await checkRanking(ctx, rankReq2.id, legacyVendor.vendorId, degradedVendor.vendorId);
  out.ranking_2 = { requirement_id: rankReq2.id, high_history_vendor_id: legacyVendor.vendorId, fresh_vendor_id: degradedVendor.vendorId, passed: ranking2.passed, ranked: ranking2.ranked };
  note('ranking-2', `passed=${ranking2.passed} order=${ranking2.ranked.map(q => q.vendor_id).join(' > ')}`);

  // Addition 6 — reputation correction: a SECOND, completely clean invoice through the same degraded vendor.
  await sleep(1500);
  const riskBefore = await riskSnapshot(ctx.company.companyId, degradedVendor.vendorId);
  const rep1 = await buildTestCase(ctx, degradedVendor, refScenario('reputation-correction-1'));
  out.reputation_correction_1 = { ...rep1, expected_decision: 'flagged', company_id: ctx.company.companyId, risk_before: riskBefore && { invoice_decision_count: riskBefore.invoice_decision_count, invoice_decision_success_count: riskBefore.invoice_decision_success_count } };
  note('reputation-correction-1', `invoice_id=${rep1.invoice_id}`);

  // Addition 5 — shell company: two vendors sharing ONE bank account, a clean invoice through either.
  const shared = `SHARED${RUN_TAG}${vendorCounter + 1}`;
  const shellA = await newVendor(ctx, { bank_account_number: shared });
  await newVendor(ctx, { bank_account_number: shared }); // vendor B — only needs to exist in the graph
  await sleep(3000); // Neo4j vendor sync is fire-and-forget after registration
  const shell1 = await buildTestCase(ctx, shellA, spec({ id: 'shell-company-1', label: 'Clean invoice from a vendor sharing a bank account', expect: 'suspicious' }));
  out.shell_company_1 = { ...shell1, expected_decision: 'suspicious', expected_flag_type: 'shell_company_shared_bank_account' };
  note('shell-company-1', `invoice_id=${shell1.invoice_id}`);

  // Addition 7 — compounding mismatches: quantity (70 vs GRN 100) AND GST at 12% where cement's rate is 28%.
  const compoundVendor = await newVendor(ctx);
  const compound1 = await buildTestCase(ctx, compoundVendor, spec({ id: 'compound-mismatch-1', label: 'Quantity mismatch AND GST-rate mismatch together', invQty: 70, invBase: 10000, invGst: 1200, invTotal: 11200, expect: 'flagged' }));
  out.compound_mismatch_1 = { ...compound1, expected_decision: 'flagged' };
  note('compound-mismatch-1', `invoice_id=${compound1.invoice_id}`);

  // Addition 8 — threshold boundary. MECHANICAL check, not a realistic scenario: a vendor with a
  // mixed history (some bad, some good) so vendor_risk drags the weighted score toward 0.70, then a
  // clean invoice. Any quantity/amount delta would trip the matching hard-flag rule regardless of
  // score, so the score is steered via vendor history instead. Tune with EVAL_BOUNDARY_WARMUPS;
  // evaluate-vendor-states.js reports how close to 0.70 it actually landed.
  const boundaryVendor = await newVendor(ctx);
  for (let i = 1; i <= BOUNDARY_FLAGGED_WARMUPS; i++) await warmup(ctx, boundaryVendor, badWarmup(`boundary-${i}`));
  await warmup(ctx, boundaryVendor, cleanWarmup('boundary-good'));
  const boundary1 = await buildTestCase(ctx, boundaryVendor, refScenario('boundary-1'));
  out.boundary_1 = { ...boundary1, expected_decision: null };
  note('boundary-1', `invoice_id=${boundary1.invoice_id}`);

  // Let everything finish so the files we hand to evaluate-vendor-states.js are complete.
  for (const k of Object.keys(out)) if (out[k]?.invoice_id) await waitForDecision(out[k].invoice_id);

  fs.writeFileSync(path.join(__dirname, 'vendor-state-results.json'), JSON.stringify(out, null, 2));
  console.log('Vendor-state results written to vendor-state-results.json — evaluate-vendor-states.js reads this next.');
}

async function main() {
  const adminToken = (await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)).token;
  console.log('Setting up the synthetic company (register -> admin approve -> invite team)...');
  const company = await setupCompany(adminToken);
  const ctx = { adminToken, company };

  let mainResults = null;
  if (ONLY === 'all' || ONLY === 'main') mainResults = await runMainCases(ctx);
  if (ONLY === 'all' || ONLY === 'vendor-state') await runVendorStateCases(ctx, mainResults);

  console.log('\nDone. Synthetic company logins (password for all: ' + PASSWORD + '):');
  console.log(`  company_admin: ${company.adminEmail}\n  procurement:   ${company.team.procurement.email}\n  finance:       ${company.team.finance.email}   <- use this one to try Override & Pay on a flagged invoice (checks the Override Log page + dot)\n  warehouse:     ${company.team.warehouse.email}`);
  await pool.end();
}

main().catch(async err => { console.error(err); try { await pool.end(); } catch (_) {} process.exit(1); });

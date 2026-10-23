# Veridion — Flow 1–8 Verification Checklist

Covers the whole deployed project: the original seven flows, deployment (Flow 8), and everything added since (messaging, GRN corrections and quality, fraud fixes, payment-deadline warnings, dispute clean-up, UI changes).

**Where to test.** Run this against **local test mode** (safe, can be wiped) or against the **deployed app** (`https://veridion-w0yp.onrender.com`). Items marked **(local only)** need the seed data, scripts or a database you can erase — do not run them on production.

Seeded accounts (local / test database only) all use password `password123`. Run the seed with `npm run seed:test` (or `FORCE_SEED=1 npm run seed` on a throw-away dev database). On production, create your own accounts through registration and a hand-inserted Platform Admin.

---

## 0. Setup (once)

### Local
- [ ] `.env` files exist in `backend/` and `ai-service/` (`DATABASE_URL`, `JWT_SECRET`, `RABBITMQ_URL`, `GROQ_API_KEY`, `AI_SERVICE_URL`, `BACKEND_URL` — see README → Environment variables)
- [ ] PostgreSQL and RabbitMQ running; `poppler-utils` installed (`pdftoppm -v` works)
- [ ] `cd backend && npm install && npm run migrate` (applies `001`–`026`), then `npm run seed:test` for sample data
- [ ] `cd ai-service && npm install`
- [ ] Neo4j configured in `ai-service/.env` (optional — fraud detection reports "no signal" without it)
- [ ] Start backend: `cd backend && npm run dev` (or `npm run dev:test`) → `http://localhost:4000`
- [ ] Start ai-service: `cd ai-service && npm run dev` (or `npm run dev:test`) → `http://localhost:4100`
- [ ] Open **`http://localhost:4000`** — the backend serves the frontend itself (no separate frontend server)
- [ ] `curl http://localhost:4000/health` → `{"status":"ok"}`
- [ ] `curl http://localhost:4100/health` → `groq_configured` / `neo4j_configured` show what is live
- [ ] After any code change, restart both processes (they run plain `node`, no auto-reload)

### Deployed
- [ ] See **Flow 8** at the end of this checklist

---

## LOGIN / SESSION BEHAVIOR (check this before the flows — it affects how you test everything below)

1. **Basic login**
   - [ ] Log in with a valid account → lands on the correct dashboard for its role
   - [ ] Wrong password → clear error, no redirect
   - [ ] Login page shows no seeded/admin credentials and offers "Sign up as vendor" and "Sign up as company" on separate lines
2. **Remember Me**
   - [ ] Log in **without** "Remember me" → close the tab → open the app in a **new** tab → logged **out**
   - [ ] Log in **with** "Remember me" → close the tab (or restart the browser) → reopen → **still logged in**
   - [ ] Registering a new vendor/company, or accepting a team invite, keeps you signed in persistently (no checkbox)
3. **Multiple roles in multiple tabs**
   - [ ] Tab 1 = Platform Admin, Tab 2 = a vendor (neither with Remember Me) → refresh Tab 1 → still Admin
   - [ ] Repeat with Procurement / Finance / Warehouse in more tabs — every tab keeps its own identity
4. **Logout is a real logout**
   - [ ] Log in with Remember Me, click Log Out → fresh tab → logged out there too
5. **Auto-refresh on approval pages**
   - [ ] Register a vendor, log in, stay on "Awaiting Approval"; approve it as Platform Admin in another tab → the waiting tab redirects to the vendor dashboard on its own within ~1 s
   - [ ] Repeat for a newly registered company

---

## FLOW 1 — Core Lifecycle (no AI)

1. **Vendor registration**
   - [ ] Register at `/vendor/register.html` (upload a dummy GST/PAN proof)
   - [ ] The sign-up form has **no** "How should we notify you…" question
   - [ ] Password rules enforced (8+ chars, 1 uppercase, 1 special) with a live strength indicator and eye toggle
   - [ ] Log in as that vendor → `/vendor/awaiting-approval.html` (status `pending`)
2. **Company registration**
   - [ ] Register at `/company/register.html` (same password rules); log in as its company admin → `/company/awaiting-approval.html`
3. **Platform Admin approves both**
   - [ ] Approve under Vendor Verification and Company Verification; both accounts reach their real dashboards live
4. **Team invite** (Company Admin → Team)
   - [ ] Invite a `procurement` email; the invite link has a **Copy** button (green tick, stays "Copied!" ~30 s even through the page's auto-refresh)
   - [ ] Clicking "Send Invite" again for the same email **reuses** the same link (no duplicate row)
   - [ ] Accept the invite → new user can log in (accept-invite page enforces the password rules)
5. **Requirement → Quotation → PO**
   - [ ] Procurement → Post Requirement: Title, Category, Quantity, **Unit**, Deadline are required; Description optional
   - [ ] Unit is a dropdown (kgs, tonnes, litres, units, pieces, boxes, bags, meters) plus "Other (specify)", which reveals a text box that is required only while shown
   - [ ] **Requirements Posted** page lists it (search + sort); toggle Confirmed / Not Confirmed behaves as expected
   - [ ] A verified vendor sees it under Browse Requirements and submits a quotation
   - [ ] Procurement sees it in Quotations and accepts it
   - [ ] A PO is generated with a downloadable PDF; the requirement closes
6. **GRN (delivery)**
   - [ ] Warehouse → GRN Entry: a **full** delivery makes the PO `fulfilled`
   - [ ] A **partial** delivery on another PO → `partially_fulfilled`; see "GRN quality and partial-delivery rules" below
   - [ ] Warehouse's PO views never show price fields
   - [ ] Warehouse dashboard "Purchase Orders Awaiting Delivery" tiles open `grn-entry.html?po=<id>` directly
7. **Invoice upload**
   - [ ] Vendor cannot invoice a `pending` / `partially_fulfilled` PO (clear error)
   - [ ] Vendor uploads an invoice against the `fulfilled` PO — succeeds; the optional **Payment Due Date** field is present
   - [ ] A second invoice against the same PO is rejected (409)

---

## FLOW 2 — AI Verification Pipeline

1. **Pipeline runs automatically**
   - [ ] After the invoice upload, wait a few seconds (or call `POST /agents/run-pipeline {invoice_id}` on the AI service) — status moves to `verified` or `flagged`
2. **Clean invoice → auto-approved**
   - [ ] Invoice amount/quantity/GST genuinely match → Finance → Invoice Review shows `auto_approved`, a confidence badge, and plain-English reasoning
3. **Mismatched invoice → flagged**
   - [ ] Deliberately wrong amount or quantity → `flagged`, mismatched fields highlighted, reasoning names the signal that drove it
4. **Partial delivery isn't a false mismatch**
   - [ ] Invoice a (later fulfilled) partial delivery for exactly the GRN-confirmed quantity → matches cleanly
5. **GST recalculated fresh**
   - [ ] Compliance shows `gst_rate_used` / `gst_rate_reference_date`, independent of the PO's estimate; GST is not double-counted on pre-tax amounts
6. **OCR input types**
   - [ ] A born-digital PDF, a scanned PDF and a photo upload are each read and structured (offline OCR; needs `poppler-utils` for scans)
7. **Payment gate**
   - [ ] `auto_approved` invoice → "Approve Payment" works
   - [ ] `flagged` invoice → normal pay button is gone; "Override & Approve Payment Anyway" needs a typed reason and appears in the override history
8. **Known issue — Invoice Review without `?id=`**
   - [ ] Opening `company/invoice-review.html` with no `?id=` should show an error, not crash the backend (the `GET /api/invoices/:id/review` handler has no try/catch, so an invalid id currently throws an unhandled error). Fix, then re-check

---

## FLOW 3 — Fraud Detection & Vendor Risk

1. **Vendor risk score updates live**
   - [ ] Before any GRN: the Vendor Risk card says no history yet
   - [ ] After an on-time GRN: `on_time_delivery_pct` appears
   - [ ] After an invoice decision finalises: `invoice_accuracy_pct` updates
   - [ ] A late second delivery lowers `on_time_delivery_pct` without crashing it to 0 (running average)
2. **Cold start / isolation**
   - [ ] A brand-new vendor shows a neutral, low-weight signal — never a fabricated score
   - [ ] **(local only)** "Vendor Four Shell Co" (shares a bank account with "Vendor One Supplies") triggers shell-company detection only when Neo4j is configured and reachable
   - [ ] Two companies working with the same vendor have independent risk scores (`vendor_risk_scores` rows differ by `company_id`)
3. **Fraud routing**
   - [ ] A high-severity fraud flag routes the decision straight to `suspicious`, skipping the weighted gate, and appears in the Platform Admin **Fraud Review Queue** (not Finance's normal review)

---

## FRAUD FIXES (Neo4j clean-up, revoked vendors, re-decision)

- [ ] `npm run test:fraud-fixes` passes (test database only)
- [ ] **Stale edges:** change a vendor's bank account or address → the old shared-bank/address link no longer causes a flag
- [ ] **Revoked vendor:** reject/revoke a vendor that shares a bank account with another → the other vendor stops getting shell-company flags, and its affected invoices are re-checked
- [ ] **Re-decision:** as Platform Admin, resolve every fraud flag on an invoice → the decision re-runs, Finance sees the updated outcome and is notified once
- [ ] A fraud flag keeps showing the invoice number after the vendor withdraws and resubmits that invoice

---

## FLOW 4 — Quotation Ranking & Vendor Communication

1. **Agent 6 — AI-ranked quotations**
   - [ ] One requirement with **2+ quotations from different vendors** (one with history, one without)
   - [ ] Quotations page shows an **AI Score** per row and is sorted by it, not just price
   - [ ] "AI ranking reasoning" mentions price/delivery for a vendor with little history, and past performance (and delivery quality, once GRNs are rated) when there is history
   - [ ] Procurement can still accept **any** vendor
   - [ ] Exactly **1 quotation** → still a valid score, no error
   - [ ] Accept and Message buttons are the same size and aligned; Message is orange/amber (no black)
   - [ ] If no rank/score appears on the deployed app, wake the AI service (`/health`) and reload
2. **"Successful deals" counting**
   - [ ] After several wrong/flagged invoices then one correct invoice that Finance **pays**, that vendor has exactly **one** successful deal in ranking (per deal, not per invoice)
3. **Agent 7 — dispute drafting**
   - [ ] Get an invoice **flagged** (not suspicious) → Finance → Disputes → **Pending** shows an AI-drafted message with a `mismatch_type` label
   - [ ] Re-running the pipeline on the same invoice does **not** create a second dispute
   - [ ] A flag driven **only** by the vendor's risk score (Matching, Compliance, Fraud all clean) creates no usable draft: it is closed as a record and never shown to the vendor
4. **Dispute lifecycle** (Finance → Disputes tabs: **Pending · Sent · Resolved · Accepted · Withdrawn**)
   - [ ] Edit the draft → Save → reload → edit persisted
   - [ ] "Send to Vendor" → moves to **Sent**; editing a sent dispute is rejected (400)
   - [ ] Vendor (Disputes page) sees it and replies; replying **before** it is sent is rejected (400)
   - [ ] Finance and vendor can exchange messages; each message shows the sender's name and role
   - [ ] "Mark Resolved" → **Resolved**, `resolution_time_hours` filled; resolving before sending or twice is rejected
   - [ ] Vendor Risk card: `dispute_rate` and `data_volume` updated
5. **Auto-close (not scored)**
   - [ ] Pay an invoice that has an open dispute → the dispute moves to **Accepted** (no resolution time, not scored)
   - [ ] Vendor withdraws an invoice that has a sent dispute → it moves to **Withdrawn**
   - [ ] Unsent drafts disappear from both Finance and vendor lists once the invoice is withdrawn, verified or paid
6. **Isolation and access control**
   - [ ] A Finance user from a different company sees none of another company's disputes
   - [ ] Warehouse / Procurement get 403 on `/api/vendor-communications*`
   - [ ] A vendor only sees their own disputes

---

## FLOW 5 — Legacy Vendor Import & Platform-Wide Aggregate

1. **The discount and cap**
   - [ ] Vendor Directory (Company Admin) → "Import Legacy History" appears only for vendors showing "No history yet"
   - [ ] 10 transactions → live preview `data_volume = 5`; 1,000 transactions → `data_volume = 12` (capped)
   - [ ] Submitting without a justification or without the confirmation box is rejected, nothing saved
   - [ ] A valid import → 201; the vendor shows the "Self-reported" badge and a score
2. **One-time-only**
   - [ ] A second import for the same (company, vendor) → 409; the button is gone after reload
   - [ ] A **different** company importing the same vendor succeeds independently, and the scores never mix
   - [ ] A vendor with real platform activity with your company (a GRN/invoice/dispute) → 409
3. **Ranking uses the imported history**
   - [ ] Straight after import, Quotation Comparison shows a **non-zero** Past Performance weight, not "no track record yet"
4. **Real events dilute the baseline**
   - [ ] A real GRN afterwards moves `on_time_delivery_pct` and `data_volume` per the running-average formula; `data_source` stays `self_reported`
5. **Platform aggregate stays verified-only**
   - [ ] A vendor with only a self-reported import shows `total_platform_verified_events = 0`
   - [ ] After a real event the aggregate updates and `num_companies_worked_with` includes your company
   - [ ] The platform aggregate appears (italic, informational) only for a vendor with no history with your company
   - [ ] The vendor's Profile shows one coherent platform-wide figure
6. **Access control**
   - [ ] Procurement can view the Vendor Directory but gets 403 on a legacy import (Company Admin only)
   - [ ] Finance / Warehouse cannot reach `/api/company/vendors`
   - [ ] Any authenticated role can read `GET /api/vendors/:id/platform-summary`

---

## VENDOR RISK WEIGHTING

- [ ] `npm run test:vendor-risk` passes (test database only)
- [ ] A legacy-imported vendor (data volume 12) with one flagged and one good invoice shows `invoice_accuracy_pct` ≈ **50%**, not ~7%
- [ ] Migration `026` has been run on every database (local test, local dev, Supabase) so stored values were repaired

---

## FLOW 6 — Real-time & Persistent Notifications (all roles)

Use separate browsers or incognito windows per role.

1. **Connection and delivery**
   - [ ] Every role shows a bell in the dock; backend log shows `[socket] <room> connected` (`vendor_1`, `company_1_finance`, `platform_admin`, …)
   - [ ] A second tab of the same account also gets the toast
   - [ ] Close the recipient's tab **before** the event → reopen → notification waiting in the bell, unread
   - [ ] Click a notification → marked read, opens the right page; read state survives reload
   - [ ] Scrolling closes an open bell dropdown
2. **Quotation events**
   - [ ] Vendor submits → Procurement gets "<Vendor> submitted a quotation for "<item>" (<Company>): ₹…"
   - [ ] Procurement accepts → winner is told, every other quoting vendor gets "did not select your quotation", Warehouse gets "New purchase order … ready to receive"
3. **Delivery events**
   - [ ] Partial GRN → vendor gets "received X of Y … remaining … expected by …"; Procurement gets "Delivery recorded …"
   - [ ] Final GRN completing the PO → vendor gets "please submit your invoice"; clicking opens My Invoices
4. **Invoice / dispute / payment**
   - [ ] Clean invoice → Finance "verified, ready for payment" and vendor "verified and approved"; flagged → Finance "flagged, needs review" (vendor **not** told yet)
   - [ ] Finance sends a dispute → vendor notified; Finance messages → vendor notified; vendor replies → Finance notified; resolved → vendor notified
   - [ ] Finance marks paid (or override-and-pay) → vendor "marked your invoice … as paid (₹…)"
5. **Admin / account events**
   - [ ] New vendor / company registers → Platform Admin notified
   - [ ] Admin verifies or rejects a vendor → vendor notified; approves or rejects a company → Company Admin notified
   - [ ] A fraud flag → Platform Admin notified once (not repeated on reprocessing)
6. **Security / scoping**
   - [ ] Finance of Company A never sees Company B's notifications; Warehouse never sees Finance's; vendors never see each other's
   - [ ] A socket with a missing or invalid token is rejected
7. **Resilience**
   - [ ] Stop the AI service → submit an invoice → nothing breaks (no decision, so no notification); restart the backend with tabs open → bell badge resyncs
8. **Cleanup**
   - [ ] The vendor sign-up and vendor profile pages have no "Preferred Notification Channel" setting

---

## PAYMENT-DEADLINE WARNINGS

- [ ] `npm run test:payment-deadlines` passes
- [ ] Vendor submits an invoice with a Payment Due Date **more than 3 days away** → no warning on Finance's side
- [ ] Due date **within 3 days** → amber "due" badge on Finance → Payments, Invoices and Invoice Review, plus **one** "payment deadline approaching" notification
- [ ] Due date **today** → "Payment due today"
- [ ] Due date **in the past** → red overdue badge and **one** "payment overdue" notification
- [ ] Reloading or waiting does **not** repeat either notification
- [ ] Marking the invoice paid, or the vendor withdrawing it, closes (marks read) the deadline notifications and removes the badge
- [ ] An invoice with no due date never warns

---

## FLOW 7 — Admin completion & evaluation

1. **Override Log page**
   - [ ] As Finance, Override & Pay a couple of flagged invoices
   - [ ] As Platform Admin, the **Override Log** dock icon shows a red dot; opening `/admin/override-log.html` clears it
   - [ ] Overrides are grouped by month ("October 2026 — 3 overrides, 1 reviewer"); the latest month is open, others collapsed; each expands to invoice / reason / overridden by / time
   - [ ] A second admin session's dot appears within ~5 s
   - [ ] Non-admin roles get 403 from `/api/admin/overrides/monthly` and `/count`
   - [ ] There is **no Refresh button** and **no settings page** (both deliberate)
2. **Evaluation — (local only, test mode)**
   - [ ] Each test-mode process prints `[test mode] database: veridion_test`; plain `npm run seed` refuses to run on a non-test database
   - [ ] Real-database row counts are unchanged after the run
   - [ ] `npm run migrate:test`, `npm run seed:test`, then `npm run seed:synthetic` finishes; `synthetic-dataset-results.json` has 15 entries and `vendor-state-results.json` is written
   - [ ] `npm run evaluate` polls all 15 invoices to a decision; 8 clean → `auto_approved`; fraud case → `suspicious`
   - [ ] Context Gate accuracy ≥ the equal-weight baseline (reference run: 15/15 vs 13/15)
   - [ ] `npm run evaluate:vendor-states`: legacy-1, earned-history-1, degraded-history-1, reputation-correction-1, compound-mismatch-1, boundary-1, ranking-2 pass; `ranking-1` shows as DESIGN PROPERTY; `shell-company-1` is NOT TESTED unless Neo4j is on (separate instance + `TEST_USE_NEO4J=1`)

---

## Vendor–Company communication channel

- [ ] `npm run migrate` applies `023_communication_channels.sql`; `npm run test:comms` passes (test database)
- [ ] **Pre-award:** Vendor A and Vendor B quote on one requirement; Vendor B cannot read or post in Vendor A's thread (404, not an empty list)
- [ ] Procurement messages Vendor A with a counter-proposal; Vendor A updates their quotation from the dialog (only while it is still `submitted`); the comparison table shows the new numbers within a second; Procurement is notified of the update
- [ ] Accepting it: the PO's agreed price and delivery date are the negotiated ones; both sides can still read the thread but not post
- [ ] **Post-award:** Vendor and **Warehouse** can post; **Procurement** sees "Message History" read-only (403 on a direct post); Finance has no thread and gets 403
- [ ] A vendor's PO message notifies Warehouse only
- [ ] Warehouse records a partial GRN citing a thread message as the source; PO fulfilment modals and both GRN Documents pages show the date with the quoted message
- [ ] A GRN citing a message from a different PO is rejected (400)
- [ ] When the last units are confirmed (PO fulfilled) the reply box disappears for everyone, history stays, and a direct POST returns 400
- [ ] Paying an invoice on a not-yet-fulfilled PO closes the thread the same way
- [ ] The dispute flow is unaffected; the conversation dialog's **Send Message** button is green and bottom-right

---

## GRN quality and partial-delivery rules

- [ ] `npm run migrate` applies `025_grn_quality.sql`; `npm run test:grn-quality` passes (test database)
- [ ] A GRN cannot be submitted without a **quality rating** (integer 1–5); invalid values are rejected (400)
- [ ] A **partial** GRN is rejected without an expected next-delivery date (must be on/after the delivery date) **and** a confirming PO-conversation message
- [ ] Recording a GRN on an already-fulfilled PO is refused (409)
- [ ] After rated GRNs exist, ranking shows a **quality** weight for that vendor; vendors with no rated GRNs have no quality weight
- [ ] Quality is weighted by **quantity received** (a large delivery counts more than a small one)

---

## GRN corrections

- [ ] `npm run migrate` applies `024_grn_corrections.sql`; `npm run test:grn-corrections` passes (test database)
- [ ] Warehouse records a full-quantity GRN, then clicks **Request correction** (GRN Entry or GRN Documents) with a reason; the button appears only on the **newest active** GRN of an order
- [ ] Procurement / Company Admin see the request on **GRN Corrections** (red dot); the requester sees no Approve/Reject on their own request
- [ ] While a request is open, Finance's Approve Payment (and override-and-pay) on that order is refused ("payment is on hold")
- [ ] **Approve:** the GRN shows "Voided — entered in error" on company and vendor GRN pages and PO modals; the order's received total and status drop (e.g. `fulfilled` → `partially_fulfilled`); the conversation reopens; any **unpaid** invoice on it is withdrawn, and vendor and Finance are notified
- [ ] Warehouse records the correct GRN; totals/status are right; the vendor resubmits the invoice
- [ ] **Reject:** needs a reason; the GRN is untouched; the requester is notified and can raise a new request
- [ ] After an invoice on the order is **paid**, a correction request is refused
- [ ] Only one open request per GRN

---

## UI and usability

- [ ] **Sliding toggles with counts** (animated table swap, no layout jump) on: Team (Active/Removed); Vendor Verification and Company Verification (Pending first, then verified/approved, rejected); Fraud Review Queue (pending/resolved); vendor My Quotations (Submitted/Selected/Rejected), Purchase Orders (pending/fulfilled), My Invoices (paid/decision), Payment Status (paid/not paid); company Purchase Orders, Invoices, Disputes (5 tabs), Payments (Ready/Needs Review/Paid), GRN Corrections
- [ ] **Team page:** Removed view shows Reactivate and Delete; Delete requires a confirmation and works only on removed members; Pending Invitations shows only in the Active view; the 1-second refresh does not interrupt an animation
- [ ] Permanently deleting a member who has history anonymises the row instead of failing
- [ ] **Footer:** a green-gradient footer is pinned to the bottom of every page ("© year Veridion. All rights reserved."); the landing page has the richer 4-column footer
- [ ] **Landing page:** rounded glass navbar, Register dropdown (company / vendor), globe fades near the footer
- [ ] **Auth pages:** rounded card, wide registration cards, "Already have an account? Sign in here" link in green, logged-out navbar pill hides on scroll; the login card fits one screen at ~1278×628
- [ ] Tables are rounded; long emails wrap instead of overflowing; units show next to quantities everywhere (`qtyWithUnit`); ₹ is used for every amount
- [ ] **Responsive:** phone, tablet and large screens — dock navbar fits phones, no horizontal page scroll, wide tables scroll inside their own container
- [ ] Dock notification dots persist across refresh, tab close and browser restart (per user), and clear when the page is opened
- [ ] Platform Admin cannot reach company pages and vice versa (open a URL for another role → redirected or 403)

---

## FLOW 8 — Deployment (deployed app only)

1. **Services**
   - [ ] `https://veridion-w0yp.onrender.com/health` → `{"status":"ok"}`
   - [ ] `https://veridion-ai-service.onrender.com/health` → `status: ok`, `groq_configured: true`, `neo4j_configured: true`
   - [ ] The site loads from the backend URL alone (no separate frontend host); API calls use relative URLs
2. **Environment (Render dashboard)**
   - [ ] Backend has `DATABASE_URL`, `RABBITMQ_URL`, `NEO4J_*`, `S3_*`, `INTERNAL_API_SECRET`, `JWT_SECRET`, `AI_SERVICE_URL`, `DEFAULT_COUNTRY_CODE`
   - [ ] AI service has `DATABASE_URL`, `RABBITMQ_URL`, `NEO4J_*`, `S3_*`, `INTERNAL_API_SECRET`, `GROQ_API_KEY`, `BACKEND_URL`
   - [ ] `INTERNAL_API_SECRET` is **identical** on both; if the Supabase password was ever reset, `DATABASE_URL` was updated on **both**
   - [ ] The old, unused Render backend service has been deleted
3. **Database**
   - [ ] `schema_migrations` on Supabase lists every file through `026_fix_vendor_metric_weighting.sql`
   - [ ] A Platform Admin exists that you created yourself; no seeded `password123` accounts exist on production
4. **Storage**
   - [ ] Upload a registration proof and an invoice → both files open again from the app (Supabase Storage via `S3_*`, not local disk)
   - [ ] Generated PO PDFs download
5. **End-to-end on the deployed app**
   - [ ] Run the smoke test below on the live URLs: an invoice reaches `verified` / `flagged` and the right notification toast appears without a refresh
   - [ ] After the AI service has slept, loading the site wakes it (backend pings `/health` on start and every 10 minutes)
6. **Security**
   - [ ] Socket.io origin is tightened for real use (currently `*` in `server.js`)
   - [ ] The storage bucket is private; direct bucket URLs do not expose files

---

## Automated test suites (local / test database only)

Run from `backend/`; each refuses to run against a non-test database.

- [ ] `npm run test:comms`
- [ ] `npm run test:grn-corrections`
- [ ] `npm run test:grn-quality`
- [ ] `npm run test:fraud-fixes`
- [ ] `npm run test:vendor-risk`
- [ ] `npm run test:payment-deadlines`
- [ ] `npm run evaluate` and `npm run evaluate:vendor-states` (see Flow 7)

---

## Quick smoke test (fastest path through everything)

1. Open 2 tabs: Tab 1 = Procurement, Tab 2 = a vendor (neither with Remember Me). Confirm neither login affects the other.
2. Tab 1: post a requirement (all required fields, a unit from the dropdown).
3. Tab 2 and a 3rd tab (second vendor): both submit quotations. Optionally exchange a price message and update a quotation.
4. Tab 1: Quotations → confirm AI scores and reasoning appear → accept one.
5. Open Warehouse in a new tab → record a **partial** GRN (rating, next date, confirming message), then the final GRN (rating) → PO becomes `fulfilled`.
6. The accepted vendor uploads an invoice with a **wrong amount** (forces a flag) and a Payment Due Date a day or two away.
7. Wait for the pipeline (or `POST <ai-service>/agents/run-pipeline {"invoice_id": N}`).
8. Open Finance in a new tab → Invoice Review confirms `flagged`, the due-date badge shows, and Disputes → Pending shows the auto-drafted message.
9. Edit → Send → switch to the vendor tab → reply → back to Finance → Resolve. Confirm the Vendor Risk card changed.
10. Register one more throwaway vendor with Remember Me, close the tab entirely, reopen → still logged in. Approve that vendor from the admin tab and confirm its open "Awaiting Approval" tab redirects within ~1 second.
11. Check that bells and toasts fired for each step, and that Platform Admin's Override Log updates after an Override & Pay.

If all of the above hold, the platform works end to end — deployed and local.
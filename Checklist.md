# Veridion — Flow 1–4 Verification Checklist

Login for every seeded account: password `password123`. Run `npm run seed` first if you
want a clean slate (it truncates and re-seeds everything).

---

## 0. Setup (once)

- [ ] `.env` files exist in `backend/` and `ai-service/` with `DATABASE_URL` set
- [ ] Postgres running and reachable
- [ ] `cd backend && npm install && npm run migrate && npm run seed`
- [ ] `cd ai-service && npm install`
- [ ] RabbitMQ running (needed for automatic invoice processing in Flow 2–4;
      without it you can still test by hitting `/agents/run-pipeline` directly)
- [ ] Neo4j configured in `ai-service/.env` (optional — fraud detection just reports
      "no signal" without it, everything else still works)
- [ ] Start backend: `cd backend && npm run dev` → `http://localhost:4000`
- [ ] Start ai-service: `cd ai-service && npm run dev` → `http://localhost:4100`
- [ ] `curl http://localhost:4000/health` → `{"status":"ok"}`
- [ ] `curl http://localhost:4100/health` → `groq_configured` / `neo4j_configured` show what's live

---

## LOGIN / SESSION BEHAVIOR (check this before the flows — it affects how you test everything below)

1. **Basic login**
   - [ ] Log in with a seeded account → lands on the right dashboard for its role
   - [ ] Wrong password → clear error, no redirect
2. **Remember Me**
   - [ ] Log in **without** checking "Remember me" → close that tab → reopen the app in
         a **new** tab → you are logged **out** (had to log in again)
   - [ ] Log in **with** "Remember me" checked → close that tab (or fully restart the
         browser) → reopen the app in a new tab → you are **still logged in**
   - [ ] Registering a new vendor/company, or accepting a team invite, keeps you signed
         in persistently by default (no checkbox needed for these three flows)
3. **Multiple roles in multiple tabs at once**
   - [ ] Open Tab 1 → log in as `admin@veridion.dev` (no Remember Me)
   - [ ] Open Tab 2 (same browser) → log in as `vendor1@test.dev` (no Remember Me)
   - [ ] Go back to Tab 1 and do something (e.g. refresh) → you're **still Admin**, not
         logged out or switched to the vendor
   - [ ] Repeat with Company/Finance/Warehouse in additional tabs — every tab keeps its
         own identity
4. **Logout is a real logout**
   - [ ] Log in with Remember Me checked, then click Log Out → open a fresh tab → you
         are logged out there too (not still remembered)
5. **Auto-refresh on approval pages**
   - [ ] Register a new vendor, log in, land on "Awaiting Approval" — leave that tab open
   - [ ] In a **different tab/browser**, log in as Platform Admin and approve that vendor
   - [ ] Switch back to the waiting tab **without touching it** — within ~1 second it
         redirects itself to the vendor dashboard automatically
   - [ ] Repeat the same check for a new company's "Awaiting Approval" page

---

## FLOW 1 — Core Lifecycle (no AI)

1. **Vendor registration**
   - [ ] Register a new vendor at `/vendor/register.html` (upload a dummy GST/PAN proof)
   - [ ] Login as that vendor → redirected to `/vendor/awaiting-approval.html` (status `pending`)
2. **Company registration**
   - [ ] Register a new company at `/company/register.html`
   - [ ] Login as its company_admin → redirected to `/company/awaiting-approval.html`
3. **Platform Admin approves both**
   - [ ] Login as `admin@veridion.dev`
   - [ ] Approve the new vendor and the new company from the admin dashboard
   - [ ] Both accounts can now reach their real dashboards (confirm this happens live,
         per the auto-refresh check above, without a manual page refresh)
4. **Team invite**
   - [ ] As company_admin → Team page → invite a `procurement` email
   - [ ] Accept the invite link → new procurement user can log in
5. **Requirement → Quotation → PO**
   - [ ] Procurement posts a requirement (title, category, quantity, deadline)
   - [ ] A verified vendor sees it under "Browse Requirements" and submits a quotation
   - [ ] Procurement sees it on Quotation Comparison and accepts it
   - [ ] A PO is generated with a downloadable PDF; requirement closes
6. **GRN (delivery)**
   - [ ] Warehouse records a GRN for the PO — try a **full** delivery (fulfillment → `fulfilled`)
   - [ ] Try a **partial** delivery on a separate PO (received < agreed → `partially_fulfilled`,
         `discrepancy_flag=true`), confirm the optional "expected next delivery" fields appear
   - [ ] Warehouse's PO view never shows price fields
7. **Invoice upload**
   - [ ] Vendor cannot invoice a `pending`/`partially_fulfilled` PO (blocked with a clear error)
   - [ ] Vendor uploads an invoice against the `fulfilled` PO — succeeds
   - [ ] A second invoice against the same PO is rejected (409)

---

## FLOW 2 — AI Verification Pipeline

1. **Pipeline runs automatically**
   - [ ] After the Flow 1 invoice upload, wait a few seconds (or call
         `POST /agents/run-pipeline {invoice_id}` directly) — invoice status moves to
         `verified` or `flagged`
2. **Clean invoice → auto-approved**
   - [ ] Upload an invoice whose amount/quantity/GST genuinely match the PO/GRN
   - [ ] Finance → Invoice Review shows `auto_approved`, confidence badge, plain-English reasoning
3. **Mismatched invoice → flagged**
   - [ ] Upload an invoice with a deliberately wrong amount or quantity
   - [ ] Invoice Review shows `flagged`, the mismatched field(s) highlighted, reasoning names
         which signal (Matching/Compliance) drove it
4. **Partial delivery isn't a false mismatch**
   - [ ] Invoice a partially-delivered PO for exactly the GRN-confirmed quantity — matches
         cleanly against the GRN even though it's less than the original PO quantity
5. **GST recalculated fresh**
   - [ ] Compliance check shows `gst_rate_used` / `gst_rate_reference_date`, independent of
         whatever the PO originally estimated
6. **Payment gate**
   - [ ] `auto_approved` invoice → "Approve Payment" works
   - [ ] `flagged` invoice → normal pay button is gone; "Override & Approve Payment Anyway"
         requires a typed reason and is logged in the override history on that page

---

## FLOW 3 — Fraud Detection & Vendor Risk

1. **Vendor risk score updates live**
   - [ ] Before any GRN: Invoice Review's "Vendor Risk" card says no history yet
   - [ ] After a GRN is confirmed on-time: `on_time_delivery_pct` appears, `data_volume` = 1
   - [ ] After an invoice decision finalizes: `invoice_accuracy_pct` updates too
   - [ ] Miss a delivery window on a second PO with the same vendor → `on_time_delivery_pct`
         drops but doesn't crash to 0 (running average, not overwrite)
2. **Cold start / isolation**
   - [ ] A brand-new vendor with zero history shows a neutral, low-weight signal — never a
         fabricated score
   - [ ] The seeded "Vendor Four Shell Co" (shares a bank account with "Vendor One Supplies")
         only triggers shell-company detection if Neo4j is actually configured and reachable
   - [ ] Two different companies working with the same vendor have independent risk scores
         (check `vendor_risk_scores` rows differ by `company_id`)
3. **Fraud routing**
   - [ ] A high-severity fraud flag routes the decision straight to `suspicious`, skipping the
         normal weighted gate, and appears in the Platform Admin fraud queue — not a normal
         "flagged" Finance review

---

## FLOW 4 — Quotation Ranking & Vendor Communication

1. **Agent 6 — AI-ranked quotations**
   - [ ] Post one requirement, get **2+ quotations from different vendors** (mix a vendor with
         history and one without)
   - [ ] Open Quotation Comparison for that requirement — each row shows an **AI Score** and
         is sorted by it (not just price)
   - [ ] Expand "AI ranking reasoning" per row — mentions price/delivery when a vendor has
         little/no track record, mentions past performance when it has history
   - [ ] Procurement can still accept **any** vendor, not just the top-ranked one
   - [ ] Test with exactly **1 quotation** on a requirement — still shows a valid score, no error
2. **Agent 7 — dispute drafting**
   - [ ] Get an invoice **flagged** (not suspicious/fraud) via Flow 2
   - [ ] Finance → Disputes page → a new entry appears under "Pending" automatically, with an
         AI-drafted message and a `mismatch_type` label
   - [ ] Re-running the pipeline on the same invoice does **not** create a second dispute entry
3. **Dispute lifecycle**
   - [ ] Finance edits the draft text → Save → reload the page → edit persisted
   - [ ] Finance clicks "Send to Vendor" → status flips to `sent`
   - [ ] Editing a `sent` dispute is now rejected (400)
   - [ ] Login as the vendor → Disputes page shows the message → submit a response
   - [ ] Vendor responding **before** it's sent is rejected (400)
   - [ ] Finance sees the vendor's response on the same card
   - [ ] Finance clicks "Mark Resolved" → `resolved=true`, `resolution_time_hours` populated
   - [ ] Resolving before sending, or resolving twice, is rejected (400/409)
   - [ ] Check Invoice Review's Vendor Risk card — `dispute_rate` and `data_volume` updated
4. **Isolation & access control**
   - [ ] A finance user from a **different company** sees zero of another company's disputes
   - [ ] Warehouse/procurement roles get 403 on all `/api/vendor-communications*` routes
   - [ ] A vendor only ever sees their **own** disputes, never another vendor's

---

## Quick smoke test (fastest path through everything)

1. Open 2 tabs: Tab 1 = procurement (no Remember Me), Tab 2 = a vendor (no Remember Me).
   Confirm neither login affects the other.
2. Tab 1: post a requirement
3. Tab 2 + a 3rd tab (second vendor): both submit quotations
4. Tab 1: Quotation Comparison → confirm AI scores/reasoning appear → accept one
5. Login warehouse (new tab) → record full GRN
6. The accepted vendor uploads an invoice with a wrong amount (forces a flag)
7. `POST http://localhost:4100/agents/run-pipeline {"invoice_id": N}` (or wait for RabbitMQ)
8. Login finance (new tab) → Invoice Review confirms `flagged` → Disputes page shows the
   auto-drafted message
9. Edit → Send → switch to vendor tab → respond → switch to finance tab → Resolve
10. Confirm vendor_risk_scores changed (via Invoice Review's Vendor Risk card)
11. Register one more throwaway vendor with Remember Me checked, close the tab entirely,
    reopen the app fresh → confirm you're still logged in as that vendor
12. Approve that vendor from the admin tab, and confirm the vendor's still-open
    "Awaiting Approval" tab redirects itself within ~1 second, unprompted

If all of the above hold, Flow 1 through Flow 4 — and the session/remember-me/auto-refresh
behavior on top — are working end-to-end.
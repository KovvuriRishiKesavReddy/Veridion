# Veridion

**Enterprise Agentic AI Platform for Vendor & Procurement Management**

Veridion automates the full B2B procurement lifecycle — from requirement posting through vendor quotation, purchase order generation, delivery confirmation, and AI-verified invoice approval — using a coordinated pipeline of specialized AI agents built around a **Context Gate**: a confidence-weighted decision engine that fuses multiple AI signals into one explainable, auditable decision rather than a black-box verdict.

This README covers **Flow 1 through Flow 7**. Flows 4–5 (quotation ranking, vendor communication, legacy import, platform aggregate) are described in `Checklist.md`; Flow 6 (real-time and persistent vendor notifications) is described below. Admin completion and the synthetic evaluation (Flow 7) are described below; deployment (Flow 8) is still to come.

---

## What's actually built (Flow 1–3)

| Flow | What it covers |
|---|---|
| **Flow 1** | Core lifecycle with no AI: registration, requirement posting (multi-item), quotations, purchase orders, GRN (goods receipt) recording, invoice upload |
| **Flow 2** | The AI verification pipeline: OCR & structuring, semantic matching, GST compliance checking, and the Context Gate decision engine |
| **Flow 3** | Fraud detection (shell-company patterns, vendor identity consistency, split-billing) and event-triggered vendor risk scoring |

### Architecture

```
Client (HTML/CSS/Bootstrap + vanilla JS)
        │ REST / JWT
        ▼
Backend API (Node.js / Express)  ──────►  PostgreSQL
        │                                  ▲
        │ publishes to queue                │ writes results back
        ▼                                  │
   RabbitMQ  ──────►  AI Service (Node.js, Groq — Llama 3.3 / Qwen 3)
                          │
                          ├─ Agent 1: OCR & Structuring
                          ├─ Agent 2: Semantic Matching
                          ├─ Agent 3: Compliance (GST)
                          ├─ Agent 4: Fraud Detection
                          ├─ Agent 5: Vendor Risk Scoring
                          ├─ Agent 8: Decision Engine (Context Gate)
                          │
                          ▼
                        Neo4j (graph — vendor relationship / fraud pattern queries)
```

RabbitMQ exists specifically so that once OCR finishes reading an invoice, Matching, Compliance, and Fraud Detection can all run **concurrently** rather than sequentially — none of them depend on each other's output.

### The Context Gate

Every agent that feeds a decision returns three things, not just a verdict: **confidence** (how sure the agent is) and **data_volume** (how much history informed it). The gate combines them:

```
raw_weight_i    = confidence_i × log(1 + data_volume_i)
gate_weight_i   = raw_weight_i / Σ(raw_weight of all agents)
final_score     = Σ(gate_weight_i × agent_verdict_score_i)
```

This is a deliberate, explainable formula rather than a trained model — there's no labeled dataset to train a gate on for a brand-new platform, and every weighting decision needs to be explainable to a non-technical Finance reviewer without extra tooling. A high-severity fraud signal bypasses this weighting entirely and routes straight to a `suspicious` decision for Platform Admin review.

---

## Repository structure

```
veridion/
├── backend/          Node.js/Express API — auth, core lifecycle, RBAC
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   └── utils/
│   └── scripts/       migrate.js, seed.js, seed-synthetic-data.js, evaluate.js, evaluate-vendor-states.js
├── ai-service/        The 8-agent AI pipeline
│   ├── src/
│   │   ├── agents/     ocr.js, matching.js, compliance.js, fraud.js, decide.js, vendorRisk.js
│   │   └── utils/
│   └── tessdata/       bundled Tesseract language data (offline OCR, no network dependency)
├── frontend/
│   ├── vendor/          Vendor interface
│   ├── company/          Company Profile interface (Company Admin, Procurement, Finance, Warehouse)
│   ├── admin/            Platform Admin interface
│   └── shared/           shared CSS/JS, navbar, API helper
├── docs/              Setup guides
└── db/                18 migrations, applied in order (001–018)
```

### The three interfaces

| Interface | Who | Notes |
|---|---|---|
| **Vendor** | External vendors | One account boundary per vendor company |
| **Company Profile** | Company Admin, Procurement, Finance, Warehouse | One account boundary per company, four internal roles. **Company Admin is scoped to team management and the company's own profile only** — it has no access to requirements, quotations, purchase orders, GRNs, or invoices; that's Procurement/Finance/Warehouse's territory exclusively. |
| **Platform Admin** | Veridion's own admins | Company-agnostic; approves vendor and company registrations, reviews fraud flags |

---

## Prerequisites

- **Node.js** 20+
- **PostgreSQL** 16+
- **RabbitMQ**
- **poppler-utils** (provides `pdftoppm`/`pdfinfo` — used for scanned-PDF OCR; no native Node binding required)
- **Neo4j** (optional — shell-company fraud detection degrades gracefully to "no signal" without it; everything else works fine)
- A **Groq API key** (free tier at [console.groq.com](https://console.groq.com)) — the pipeline degrades to deterministic fallback reasoning without one, but the natural-language explanations are worth having

### Installing poppler-utils

```bash
# macOS
brew install poppler

# Ubuntu/Debian
sudo apt install poppler-utils

# Windows
winget install oschwartz10612.Poppler
# then ensure its \bin folder is on PATH
```

---

## Setup

### 1. Clone and install dependencies

```bash
git clone <this-repo>
cd veridion

cd backend && npm install
cd ../ai-service && npm install
```

> **If you're restoring from a zip that included `node_modules`:** delete and reinstall cleanly in both `backend` and `ai-service` (`rm -rf node_modules package-lock.json && npm install`). Prebuilt native bindings (`bcrypt`, `canvas`) are platform-specific and will crash if built on a different OS than the one you're running on.

### 2. Configure environment variables

`backend/.env`:
```
DATABASE_URL=postgres://<user>:<password>@localhost:5432/veridion
JWT_SECRET=<any random string>
PORT=4000
```

`ai-service/.env`:
```
DATABASE_URL=postgres://<user>:<password>@localhost:5432/veridion
RABBITMQ_URL=amqp://localhost
GROQ_API_KEY=<your Groq key>
PORT=4100
NEO4J_URI=<optional>
NEO4J_USER=<optional>
NEO4J_PASSWORD=<optional>
```

### 3. Create the database and run migrations

```bash
psql -U postgres -c "CREATE DATABASE veridion;"
cd backend
npm run migrate
```
This applies every migration under `db/` in order (001–018) — core schema, AI/Context Gate tables, vendor risk scoring, registration hardening, company approval, user deactivation, dispute messaging, legacy import, permanent delete, and (Flow 6) `notifications`.

### 4. Seed test data (optional but recommended)

```bash
npm run seed
```

This creates a Platform Admin, two pre-approved companies (each with all four internal roles), and four vendors in different verification states — including two vendors that deliberately share a bank account, so shell-company fraud detection has something to catch out of the box.

**All seeded passwords: `password123`**

| Role | Login |
|---|---|
| Platform Admin | `admin@veridion.dev` |
| BrightBuild — Company Admin / Procurement / Finance / Warehouse | `admin@brightbuild.test`, `proc@brightbuild.test`, `finance@brightbuild.test`, `warehouse@brightbuild.test` |
| SteelCorp — same four roles | `admin@steelcorp.test`, `proc@steelcorp.test`, `finance@steelcorp.test`, `warehouse@steelcorp.test` |
| Vendor One (verified) | `vendor1@test.dev` |
| Vendor Two (pending approval) | `vendor2@test.dev` |
| Vendor Three (rejected) | `vendor3@test.dev` |
| Vendor Four (verified — **shares a bank account with Vendor One**, for testing fraud detection) | `vendor4@test.dev` |

---

## Running it

Four processes, in four terminals:

```bash
# 1. PostgreSQL and RabbitMQ — start these first if not already running as services

# 2. Backend API
cd backend
npm run dev
# → Veridion backend listening on http://localhost:4000

# 3. AI service (OCR / Matching / Compliance / Fraud / Decision Engine)
cd ai-service
npm run dev
# → Veridion AI service listening on http://localhost:4100
# → RabbitMQ consumer listening on queue: invoice.submitted

# 4. Frontend (static files, no build step)
cd frontend
npx http-server -p 8080
```

Open **http://localhost:8080/login.html**.

---

## Walking through Flow 1 (core lifecycle)

1. **Register a company** at `/company/register.html` (or use a seeded one). New registrations start `pending` and land on an awaiting-approval page — log in as Platform Admin to approve it under Company Verification.
2. **Register a vendor** at `/vendor/register.html`, similarly approved by Platform Admin.
3. As **Procurement**, post a requirement — supports **multiple line items in a single requirement** (e.g. "100 bags cement + 5 AC units" in one post).
4. As the **vendor**, browse open requirements and submit a quotation, pricing each item individually.
5. As **Procurement**, accept the quotation. Each item in the requirement becomes its **own independent Purchase Order** — this is a deliberate design choice: it means every downstream step (GRN recording, invoicing, AI verification) treats each item as a normal single-item PO, with zero special-casing needed anywhere else in the pipeline. The generated POs stay linked back to the same requirement/quotation for traceability.
6. As **Warehouse**, record a GRN (Goods Receipt Note) against a PO — supports full, partial, and over-delivery, all handled without treating a partial delivery as a discrepancy.
7. As the **vendor**, upload an invoice against the PO/GRN.

## Walking through Flow 2 (AI verification)

8. Watch the `ai-service` terminal — uploading an invoice triggers OCR → Matching + Compliance (concurrently) → the Decision Engine, ending in `auto_approved` or `flagged`.
9. As **Finance**, open the invoice's review page — shows the confidence badge, any mismatched fields with OCR bounding-box context, and a plain-English explanation of the decision.
10. OCR handles three input types: born-digital PDFs (fast text-layer extraction), scanned PDFs (rendered to images via `pdftoppm`, then OCR'd), and plain photo uploads — all fully offline, no network dependency at inference time.

## Walking through Flow 3 (fraud & vendor risk)

11. Vendor risk scores (`on_time_delivery_pct`, `invoice_accuracy_pct`) update automatically and immediately after every GRN confirmation and invoice decision — an event-triggered running average, scoped per-company so one company's experience with a vendor never silently affects another's view of that same vendor.
12. Fraud Detection runs three checks: shell-company patterns (shared bank account/address across nominally different vendors, via Neo4j), vendor identity consistency (does the invoice document's claimed GSTIN/name/bank account match the account actually uploading it?), and split-billing detection. Any high-severity match bypasses the normal weighted decision and routes straight to `suspicious`.
13. Submit an invoice from **Vendor Four** (shares a bank account with Vendor One in the seed data) to see shell-company detection fire without any manual setup.

---

## Flow 7 — Admin completion & evaluation

Platform Admin now has a full picture of the decision-override pattern across the whole platform, not just a per-invoice log buried in each company's own Invoice Review page.

- **Override Log** (`/admin/override-log.html`, "Override Log" in the Platform Admin dock) — every time Finance overrides a flagged/suspicious invoice and approves payment anyway, the reason they gave is already recorded (`invoice_overrides`, since Flow 2). This page aggregates those by month — how many overrides, by how many distinct reviewers, with the full list of reasons (collapsible per month; invoice IDs are shown as plain text because Platform Admin has no route into a single company's Invoice Review page) — **a feedback loop for tuning the system over time**: a month with a spike in overrides is a concrete signal that the Context Gate's auto-approve threshold (currently a fixed `0.7` in `decide.js`) may be too conservative, flagging invoices Finance keeps having to manually rescue.
  - Backend: `GET /api/admin/overrides/monthly` (the page) and `GET /api/admin/overrides/count` (a cheap running total for the dock dot). Both `platform_admin` only.
  - A red dot appears on the Override Log icon whenever the override total is higher than the last count that admin saw, and clears when they open the page (same `updateDot` mechanism as the other three admin dots, polled every 5 seconds).
- **No `settings.html`, on purpose.** The only candidate content was making `AUTO_APPROVE_THRESHOLD` live-editable. That constant decides every future invoice's outcome platform-wide, and a slider in a UI is a materially weaker safeguard than a code change that goes through a commit and a redeploy. Everything else in the admin section is a queue or a log, so there is nothing else to put on such a page.
- **Synthetic evaluation harness** (`backend/scripts/seed-synthetic-data.js` + `evaluate.js`) — 15 invoices with a known-correct outcome (8 clean, 4 legitimate-variance, 2 genuine mismatch, 1 planted fraud), built end-to-end through the real API (register → admin approval → requirement → quotation → accept → GRN → real generated PDF invoice upload → async pipeline) rather than fabricated database rows, so the resulting accuracy number reflects the system as a whole, not just the downstream decision math. `evaluate.js` also re-scores the same results under flat equal-weighting instead of the Context Gate formula, as a direct ablation comparison (set `STRICT_BASELINE=1` to give the baseline no partial credit on the fraud case).
- **Vendor-state cases** (second half of `seed-synthetic-data.js`, scored by `evaluate-vendor-states.js`) — eight *structural* checks on how the system reacts to a vendor's accumulated state: legacy-imported history, earned history, ranking between vendors with different histories, a degraded vendor, shell-company fraud (shared bank account), the reputation-only-flag correction, compounding mismatches, and the 0.70 threshold boundary. These are pass/fail checks, not extra data points averaged into the accuracy percentage.

Running it — **test mode keeps it away from your real data.** The `:test` scripts (and `seed:synthetic`, `evaluate`, `evaluate:vendor-states`) all run through `backend/scripts/with-test-db.js`, which uses the database in `backend/.env.test`, refuses to start unless its name contains `test` (or if it is the same database as `backend/.env`), gives the pipeline its own RabbitMQ queue (`invoice.submitted.test`), and turns Neo4j off (set `TEST_USE_NEO4J=1` to keep it). Your `.env` files and normal `npm run dev` are never changed. `npm run seed` (which erases all tables) now refuses to run on any database whose name lacks `test`; use `FORCE_SEED=1 npm run seed` to deliberately re-seed a non-test dev database.

```
# one time
psql -U postgres -c "CREATE DATABASE veridion_test;"
# backend/.env.test  (see .env.test.example):  DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/veridion_test
cd backend && npm install

# stop your normal backend + ai-service (same ports), then in separate terminals:
cd backend    && npm run dev:test        # test-mode backend
cd ai-service && npm run dev:test        # test-mode ai-service  (RabbitMQ must be running)

# third terminal, in backend/
npm run migrate:test
npm run seed:test                 # creates admin@veridion.dev / password123 in the TEST database
npm run seed:synthetic            # SEED_ONLY=main | vendor-state to run half
npm run evaluate                  # the accuracy table / ablation result
npm run evaluate:vendor-states    # the structural checks + the three-way comparison table
```

Afterwards Ctrl+C the test-mode servers and start `npm run dev` as usual.

Needs nothing new: no extra API keys or env vars beyond Flows 1–4 (it does spend your Groq free-tier quota on ~30 invoices, so avoid re-running it repeatedly). Tunables: `EVAL_BASE_URL`, `EVAL_DECISION_TIMEOUT_MS`, `EVAL_DEGRADED_WARMUPS` (default 3), `EVAL_BOUNDARY_WARMUPS` (default 1).

Where the scenarios differ from the written spec, and why (these are constraints of the real routes/agents, not shortcuts):
- **Partial-GRN variance case.** `POST /api/invoices` refuses an invoice while a PO is still `partially_fulfilled`, so "GRN 90, invoice 90 against a PO of 100" can't be built through the real API. `variance-1` is instead a delivery split over two GRNs (90 + 10) that cumulatively fulfil the PO.
- **"Identical shortfall" for legacy / degraded vendors.** Any quantity delta sets `overall_match = false`, which hard-flags regardless of vendor trust, so history can never rescue a mismatched invoice. The reference scenario for all four vendor histories is therefore the clean two-GRN delivery; what history changes is the decision for degraded vendors (clean invoice → flagged) and the gate weight vendor risk carries.
- **Degrading a vendor.** The Context Gate reads `invoice_accuracy_pct` for the vendor-risk verdict, not on-time delivery, so late deliveries alone cannot move a decision. The "bad" warm-ups are late **and** carry a quantity mismatch.
- **Ranking.** A cold-start vendor's Past Performance signal has weight 0, so with Price and Delivery tied it scores exactly 1.0 and no vendor with an imperfect record can beat it. `ranking-1` (good history vs cold start, as specified) can therefore fail for an imperfect-but-good record; `ranking-2` (good vs degraded history) is the comparison the signal can actually order.
- **Boundary case.** Steered through vendor history (any quantity delta would hard-flag), and the evaluator reports how close to 0.70 it actually landed. It is a mechanical `>=` check, not a realistic scenario.
- **Not tested, by design:** split-billing (`fraud.js` Check 3) is dormant because Flow 1 blocks a second invoice on the same PO. Worth a sentence under "future work" in the report.

---

## Flow 6 — Real-time & persistent notifications (all roles)

Every important event produces a notification for the right people, through two free, self-hosted layers (no external account, no browser permission prompt):

1. **Persistent in-app notification** — a row in the `notifications` table, shown under the **bell icon** in the top bar (with an unread badge). It is there whenever the user next opens the app, even if their tab was closed. The dropdown closes as soon as the page is scrolled.
2. **Real-time toast via Socket.io** — if the recipient has any page open at that moment, a toast pops up instantly, no refresh. Sockets are authenticated with the login JWT; the private room a socket joins is derived only from the verified token (`vendor_<id>`, `company_<id>_<role>`, or `platform_admin`), so no one can receive another account's notifications.

Who is notified of what:

| Recipient | Events |
|---|---|
| Vendor | quotation accepted (names the company) · quotation not selected · goods received (fully received → "please submit your invoice", naming the company and order; partial with remaining quantity and expected date / over-delivery) · invoice verified and approved · dispute raised, new dispute message, dispute resolved · invoice paid · account verified / rejected |
| Procurement | new quotation received (names the vendor and the company) · delivery recorded |
| Finance | invoice flagged and needs review · invoice verified and ready for payment · vendor replied on a dispute |
| Warehouse | new purchase order ready to receive against |
| Company Admin | company approved / rejected |
| Platform Admin | new vendor or company waiting for verification · new fraud flag |

Key properties:
- **Non-blocking by design.** Every notification is fired after the business action has committed and the response has gone out (`safely(...)` in `utils/notify.js`). The DB write is the guaranteed layer; the socket emit is best-effort and can never throw.
- **Reusable.** `notifyVendor`, `notifyCompanyRole(companyId, roles, ...)` and `notifyPlatformAdmins(...)` cover every recipient type; a new event is one call at the place it happens.
- **Invoice decisions** are made in the separate ai-service process, which has no Socket.io. It calls `POST /api/internal/pipeline-complete` on the backend (idempotent per decision; optional shared secret `INTERNAL_API_SECRET`), and the backend does the notifying.
- **Endpoints (any logged-in role, scoped to that user):** `GET /api/notifications/mine`, `GET /api/notifications/unread-count`, `POST /api/notifications/:id/read`.
- **Read state for company roles is shared** by everyone holding that role in that company (all Finance users of a company share one bell).
- **Frontend:** `frontend/shared/notifications.js` is loaded automatically by `navbar.js` on every page; toast/bell styles are in `shared/dock-navbar.css`.
- Not built (deliberately): Firebase push, phone/SMS, email. The earlier OmniDimension voice-call integration was removed; its `outbound_notifications` table (migration 016) is left in place but is no longer written to.

Install after pulling this change: `cd backend && npm install` (adds `socket.io`), `npm run migrate` (applies `017` and `018`), add `BACKEND_URL=http://localhost:4000` to `ai-service/.env` (see `.env.example`), then restart the backend and ai-service.

---

## A note on scope

This is an actively evolving build — the codebase includes a substantial amount of hardening beyond the original spec, found through real testing rather than assumed upfront: offline-capable OCR (no external CDN dependency), a GST/pre-tax amount calculation shared consistently across every agent that touches it, a vendor-identity-consistency fraud check, a pipeline failure safety net (no invoice can silently vanish if something goes wrong mid-processing), and a company approval workflow mirroring vendor verification. Treat the code comments as the authoritative source for *why* something is built the way it is — several of the less obvious design choices are explained inline at the point they matter.
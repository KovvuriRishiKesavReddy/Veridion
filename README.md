# Veridion

**Enterprise Agentic AI Platform for Vendor & Procurement Management**

Veridion automates the full B2B procurement lifecycle — requirement posting, vendor quotations, purchase orders, delivery confirmation (GRN), and AI-verified invoice approval — using a pipeline of specialised AI agents built around a **Context Gate**: a confidence-weighted decision engine that fuses several AI signals into one explainable, auditable decision instead of a black-box verdict. The AI recommends; the company always decides.

**Live deployment**

| Service | URL |
|---|---|
| Web app + API (backend serves the frontend) | https://veridion-w0yp.onrender.com |
| AI service (health check) | https://veridion-ai-service.onrender.com/health |

> Both services run on Render's free tier and go to sleep after ~15 minutes without traffic. The first request after a sleep can take up to a minute. See [Free-tier behaviour](#free-tier-behaviour).

---

## Contents

1. [What's built](#whats-built)
2. [Architecture](#architecture)
3. [Roles and pages](#roles-and-pages)
4. [The agents and the Context Gate](#the-agents-and-the-context-gate)
5. [Business rules worth knowing](#business-rules-worth-knowing)
6. [Repository structure](#repository-structure)
7. [Running locally](#running-locally)
8. [Environment variables](#environment-variables)
9. [Database and migrations](#database-and-migrations)
10. [Deployment (Render + Supabase + CloudAMQP + Neo4j Aura)](#deployment)
11. [Notifications](#notifications)
12. [Testing and evaluation](#testing-and-evaluation)
13. [Troubleshooting](#troubleshooting)
14. [Known limitations](#known-limitations)

---

## What's built

The project was built in eight flows, followed by several rounds of hardening and polish found through live testing.

| Flow | What it covers |
|---|---|
| **1 — Core lifecycle** | Vendor and company registration with Platform Admin approval, team invitations, requirement posting, quotations, purchase orders (with PDF), GRN (goods receipt) recording, invoice upload |
| **2 — AI verification** | OCR and structuring (born-digital PDFs, scanned PDFs, photos — fully offline), semantic matching against PO/GRN, GST compliance check, and the Context Gate decision engine |
| **3 — Fraud and vendor risk** | Shell-company detection through a Neo4j graph (shared bank account / address), vendor-identity consistency check, split-billing check, and event-triggered vendor risk scoring |
| **4 — Ranking and communication** | AI-ranked quotation comparison; AI-drafted dispute messages with a full Finance ↔ vendor thread |
| **5 — Legacy import and aggregate** | One-time legacy history import for vendors with prior offline history, plus a platform-wide, verified-only vendor summary |
| **6 — Notifications** | Persistent in-app notifications (bell) plus real-time toasts over Socket.io, for every role |
| **7 — Admin completion and evaluation** | Platform Admin Override Log, synthetic evaluation dataset, ablation against an equal-weight baseline |
| **8 — Deployment** | Render (backend + AI service), Supabase Postgres and Storage, CloudAMQP, Neo4j Aura |

Added after the original flows:

- **Vendor ↔ company messaging** — a private pre-award thread per quotation (price and delivery can be negotiated) and a post-award thread per purchase order (logistics only).
- **GRN corrections** — support-style correction requests instead of editing an audit record.
- **GRN quality rating** — Warehouse rates every delivery 1–5; quality becomes the fourth signal in quotation ranking.
- **Fraud fixes** — stale Neo4j edge clean-up, revoked vendors stop triggering shell-company flags, and the decision is re-run after Platform Admin resolves a fraud flag.
- **Payment-deadline warnings** — optional invoice due date, amber/red badges, and one-time Finance notifications.
- **Dispute lifecycle clean-up** — disputes auto-close (without being scored) when an invoice is paid or withdrawn.
- **UI polish** — dock navigation bar, sliding toggle tabs with animated table swaps, rounded tables and buttons, green-gradient footer, redesigned landing and auth pages, and a responsive layer for phones, tablets and large screens.

---

## Architecture

```
Browser (HTML / CSS / Bootstrap 5 + vanilla JS — no build step)
      │  REST (JWT)  +  Socket.io
      ▼
Backend  (Node.js / Express)  ── serves the frontend, same origin ──►  Supabase Postgres
      │                                                                ▲
      │  publishes invoice.submitted                                   │ reads / writes
      ▼                                                                │
  RabbitMQ (CloudAMQP)  ───────►  AI Service (Node.js, Groq)  ─────────┘
                                      │      │
                                      │      └─► Neo4j Aura (graph: fraud patterns)
                                      └─► calls back POST /api/internal/pipeline-complete
                                          (so the backend can send notifications)

File storage:  Supabase Storage (S3 protocol)  — local disk when no S3_* variables are set
```

Key design points:

- **One origin.** The backend serves the whole `frontend/` folder and the API from the same port; the frontend calls the API with relative URLs (`API_BASE = ''`). There is no separate frontend host or CORS setup to maintain.
- **RabbitMQ** exists so that once OCR has read an invoice, Matching, Compliance and Fraud Detection run **concurrently** rather than in sequence.
- **The AI service has no Socket.io.** It tells the backend a decision is ready via `POST /api/internal/pipeline-complete`, and the backend sends the notifications.
- **Fire-and-forget side effects.** Queue publishing, graph sync and notifications can fail without ever failing the business action that triggered them; the database write is always the source of truth.

---

## Roles and pages

| Interface | Role | Pages (dock navigation) |
|---|---|---|
| **Vendor** | `vendor` | Dashboard · Browse Requirements · My Quotations · Purchase Orders · Deliveries (GRN) · My Invoices · Disputes · Payment Status · My Profile |
| **Company** | `company_admin` | Dashboard · Team · GRN Corrections · Vendor Directory · Company Profile |
| | `procurement` | Dashboard · Post Requirement · Requirements Posted · Quotations · Purchase Orders · GRN Documents · GRN Corrections · Vendor Directory |
| | `finance` | Dashboard · Purchase Orders · GRN Documents · Invoices · Disputes · Payments |
| | `warehouse` | Dashboard · GRN Entry · Purchase Orders · GRN Documents · GRN Corrections |
| **Platform** | `platform_admin` | Dashboard · Vendor Verification · Company Verification · Fraud Review Queue · Override Log |

- A company is one account boundary with four internal roles. **Company Admin is deliberately limited to team management and the company profile** (plus legacy-history import and GRN-correction review); it cannot see requirements, quotations, POs, GRNs or invoices.
- Registrations (vendor and company) start `pending` and wait on an "Awaiting Approval" page, which redirects automatically once Platform Admin approves.
- Many list pages use a sliding segmented toggle with counts (for example Pending / Sent / Resolved / Accepted / Withdrawn on Finance Disputes).

---

## The agents and the Context Gate

| Agent | Role |
|---|---|
| 1 — OCR & Structuring | Reads the invoice (text layer, scanned PDF via `pdftoppm` + Tesseract, or photo) and structures it with Groq |
| 2 — Semantic Matching | Compares the invoice with the PO and the **GRN-confirmed** quantity (a partial delivery is not a mismatch) |
| 3 — Compliance | Recomputes GST independently of the PO's estimate |
| 4 — Fraud Detection | Shell-company patterns (Neo4j), vendor-identity consistency (GSTIN / name / bank account), split-billing |
| 5 — Vendor Risk | Event-triggered running averages: on-time delivery, invoice accuracy, dispute rate, quality |
| 6 — Quotation Ranking | Ranks quotes by price, delivery, past performance and delivery quality |
| 7 — Vendor Communication | Drafts a factual, non-accusatory dispute message for a flagged invoice |
| 8 — Decision Engine | The Context Gate: fuses Matching, Compliance, Fraud and Vendor Risk into `auto_approved` or `flagged` |

Every signal that feeds a decision carries a **verdict**, a **confidence** and a **data volume**:

```
raw_weight_i  = confidence_i × log(1 + data_volume_i)
gate_weight_i = raw_weight_i / Σ raw_weight
final_score   = Σ gate_weight_i × verdict_score_i
```

- `final_score ≥ 0.70` → `auto_approved`; otherwise `flagged`.
- A **high-severity fraud signal bypasses the weighting** and routes straight to `suspicious`, which goes to Platform Admin rather than Finance.
- A brand-new vendor has no history, so its Past Performance signal has weight 0 by design — new vendors compete on price and delivery, never on a fabricated score.
- The same formula is reused for quotation ranking, with four signals: Price, Delivery, Past Performance and Quality.
- It is a deliberate, explainable formula rather than a trained model: a new platform has no labelled data, and every weighting has to be explainable to a non-technical Finance reviewer.

---

## Business rules worth knowing

**Money and tax**
- `invoice_amount` and `agreed_price` are **pre-tax**; GST is separate and recomputed by the Compliance agent (shared `computeBaseAmount()` helper).
- Amounts are shown in ₹ everywhere, including AI-written text.

**Requirements and quotations**
- One requirement = one item. Title, category, quantity, unit and deadline are required; description is optional. Unit is a preset dropdown with an "Other (specify)" option.
- The requirement **deadline never blocks** anything. It only gives a mild ranking nudge; a vendor quoting past the deadline is scored lower on delivery, not disqualified.
- Procurement may accept **any** quotation, not just the top-ranked one.
- "Successful deals" in ranking = distinct POs whose invoice Finance approved **and paid** (one per deal), plus any discounted legacy-import history.

**Delivery (GRN)**
- Warehouse must give a **quality rating (1–5)** on every GRN.
- A **partial** GRN needs a confirmed next-delivery date **and** the PO-conversation message that agreed it; the server rejects a message from a different PO.
- On-time delivery compares the GRN's received date to the PO's `agreed_delivery_date` only — never the requirement's original deadline.
- After award, the PO conversation is **Warehouse ↔ Vendor**: both can post. Procurement can read the full history ("Message History") but not post; Finance has no thread. The thread closes to everyone once the PO is fulfilled or any invoice on it is paid, but history stays visible.
- A GRN is never edited or deleted. A mistaken GRN goes through a **correction request**: raised by Warehouse or Procurement with a reason, reviewed by Procurement or Company Admin (never the person who raised it), and an approval **voids** the GRN (kept on record, struck from every total). Only the newest active GRN on an order can be corrected; nothing can be corrected once an invoice on the order is paid; payment is on hold while a request is open.

**Invoices and payment**
- A vendor can only invoice a **fulfilled** PO, and only one invoice per PO (a second is rejected with 409).
- An optional **Payment Due Date** can be entered. Finance sees an amber badge within 3 days of the date and a red one when overdue, and gets a single notification for each stage.
- `auto_approved` invoices can be paid directly. `flagged` invoices need **Override & Approve Payment Anyway** with a typed reason, which is logged and summarised monthly in the Platform Admin Override Log.
- Withdrawing an invoice keeps the dispute and fraud-flag history (snapshot columns), so Finance and Platform Admin never lose the trail.

**Disputes**
- A dispute draft is created automatically when an invoice is `flagged` (not `suspicious`). If the flag was driven solely by the vendor's reputation score — Matching, Compliance and Fraud all clean — the draft is closed automatically, kept as a record, and never shown to the vendor.
- Disputes close automatically — and are **not scored** — when the invoice is paid ("Accepted") or withdrawn ("Withdrawn").

**Vendor risk**
- Each running average is weighted by **its own event counter** (`grn_count`, `invoice_decision_count`), not by one shared `data_volume`.
- Scores are scoped per company: one company's experience with a vendor never leaks into another company's view. The platform-wide summary counts platform-verified events only.
- **Legacy import** (Company Admin only, one time per company/vendor pair, refused if real activity already exists): the reported transaction count is halved and capped at a data volume of 12, and the vendor is labelled "Self-reported".

**Accounts**
- Password policy (8+ characters, one uppercase, one special character) is enforced identically on the client and server for vendor registration, company registration and accept-invite.
- Removing a team member is a soft delete (`is_active`). A removed member can then be **permanently deleted**; if foreign keys block a real delete, the row is anonymised in place so audit trails stay intact.
- Repeating "Send Invite" for the same email reuses the existing pending invitation instead of orphaning the first link.

**Fraud**
- Platform Admin rejecting or removing a vendor stops that vendor from triggering shell-company flags on others, and affected invoices are re-checked.
- When Platform Admin resolves every fraud flag on an invoice, the decision is re-run and Finance sees the updated outcome.

---

## Repository structure

```
veridion/
├── backend/                 Express API, RBAC, Socket.io, static frontend host
│   ├── src/
│   │   ├── server.js
│   │   ├── routes/          auth, company, requirements, quotations, purchaseOrders, grn,
│   │   │                    grnCorrections, invoices, vendors, vendorCommunications,
│   │   │                    quotationMessages, poMessages, notifications, admin, internal
│   │   ├── middleware/      auth, roles, companyApproval, vendorVerification
│   │   └── utils/           notify, storage (S3 / local), queue, pgSsl, neo4jSync, pdf, upload,
│   │                        validation, paymentDeadlines, invoiceLifecycle, aiService
│   ├── scripts/             migrate, seed, seed-synthetic-data, evaluate, evaluate-vendor-states,
│   │                        with-test-db, test-* suites
│   └── uploads/             local file storage (development only; git-ignored)
├── ai-service/              the agent pipeline
│   ├── src/agents/          ocr, matching, compliance, fraud, vendorRisk, rankQuotations,
│   │                        vendorCommunication, decide
│   ├── tessdata/            bundled Tesseract language data (offline OCR)
│   └── Dockerfile           used by Render (installs poppler-utils)
├── frontend/                plain HTML / CSS / JS
│   ├── vendor/  company/  admin/
│   ├── shared/              api.js, navbar.js, notifications.js, seg-toggle.js, dashboard widgets, CSS
│   └── index.html  login.html  accept-invite.html
├── db/                      26 SQL migrations (001–026), applied in order
├── README.md
└── Checklist.md             manual verification checklist
```

---

## Running locally

### Prerequisites

- **Node.js** 20+
- **PostgreSQL** 16+
- **RabbitMQ** (local install or a free CloudAMQP instance)
- **poppler-utils** — provides `pdftoppm`/`pdfinfo` for scanned-PDF OCR
  - macOS `brew install poppler` · Debian/Ubuntu `sudo apt install poppler-utils` · Windows `winget install oschwartz10612.Poppler` (then add its `bin` folder to `PATH`)
- **Groq API key** (free tier at console.groq.com). Without it the pipeline falls back to deterministic reasoning text.
- **Neo4j** — optional. Without it, shell-company detection reports "no signal" and everything else works.

### 1. Install

```bash
cd backend    && npm install
cd ../ai-service && npm install
```

If you restored from a zip that included `node_modules`, delete it and reinstall — native modules such as `bcrypt` are platform-specific.

### 2. Configure

Create `backend/.env` and `ai-service/.env` (see [Environment variables](#environment-variables)). A minimal local setup:

```
# backend/.env
DATABASE_URL=postgres://postgres:<password>@localhost:5432/veridion
JWT_SECRET=<any long random string>
PORT=4000
AI_SERVICE_URL=http://localhost:4100

# ai-service/.env
DATABASE_URL=postgres://postgres:<password>@localhost:5432/veridion
RABBITMQ_URL=amqp://localhost
GROQ_API_KEY=<your key>
PORT=4100
BACKEND_URL=http://localhost:4000
# NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD are optional
```

With no `S3_*` variables, uploads go to `backend/uploads/`.

### 3. Database

```bash
psql -U postgres -c "CREATE DATABASE veridion;"
cd backend
npm run migrate        # applies db/001 … 026 in order, tracked in schema_migrations
npm run seed           # sample data (see below)
```

`seed` **erases every table** and therefore refuses to run unless the database name contains `test`. For a throw-away database use `FORCE_SEED=1 npm run seed`, or use test mode below.

Seeded logins (password for all: `password123`):

| Role | Login |
|---|---|
| Platform Admin | `admin@veridion.dev` |
| BrightBuild | `admin@brightbuild.test`, `proc@brightbuild.test`, `finance@brightbuild.test`, `warehouse@brightbuild.test` |
| SteelCorp | `admin@steelcorp.test`, `proc@steelcorp.test`, `finance@steelcorp.test`, `warehouse@steelcorp.test` |
| Vendor One (verified) | `vendor1@test.dev` |
| Vendor Two (pending) | `vendor2@test.dev` |
| Vendor Three (rejected) | `vendor3@test.dev` |
| Vendor Four (verified — shares a bank account with Vendor One, for fraud testing) | `vendor4@test.dev` |

### 4. Run

Two processes (and RabbitMQ running):

```bash
cd backend    && npm run dev      # http://localhost:4000  (API + frontend)
cd ai-service && npm run dev      # http://localhost:4100
```

Open **http://localhost:4000** — the backend serves the frontend itself. There is no separate frontend server.

These scripts run plain `node` with no auto-reload, so restart both processes after changing code.

### Test mode (recommended for development)

Test mode runs everything against a separate database and queue so it can never touch real data:

```bash
psql -U postgres -c "CREATE DATABASE veridion_test;"
# backend/.env.test:  DATABASE_URL=postgres://postgres:<password>@localhost:5432/veridion_test

cd backend    && npm run dev:test      # backend against veridion_test
cd ai-service && npm run dev:test      # ai-service against veridion_test
cd backend    && npm run migrate:test && npm run seed:test
```

`scripts/with-test-db.js` refuses to start unless the database name contains `test` or if it matches the database in `backend/.env`, uses its own RabbitMQ queue (`invoice.submitted.test`), and switches Neo4j off unless `TEST_USE_NEO4J=1`.

---

## Environment variables

### Backend

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. SSL is enabled automatically for any non-localhost host (`PGSSL=off` disables it) |
| `JWT_SECRET` | yes | Signs login tokens and authenticates Socket.io connections |
| `PORT` | no | Defaults to 4000 (Render provides its own) |
| `RABBITMQ_URL` | yes (deployed) | Queue used to hand invoices to the AI service; defaults to `amqp://localhost` |
| `AI_SERVICE_URL` | yes (deployed) | Base URL of the AI service. Also used to keep it awake on free tiers |
| `INTERNAL_API_SECRET` | recommended | If set, `/api/internal/*` requires it in the `x-internal-secret` header. Use the same value on the AI service |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | deployed | S3-compatible storage (Supabase Storage). All of endpoint/key/secret/bucket must be set to switch it on |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | alternative | Cloudflare R2, used only if the `S3_*` set is absent |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | optional | Graph sync for shell-company detection |
| `DEFAULT_COUNTRY_CODE` | no | Phone-number normalisation default |
| `LOCAL_UPLOAD_DIR` | no | Overrides the local uploads folder |

### AI service

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Same database as the backend |
| `RABBITMQ_URL` | yes | Consumes `invoice.submitted` |
| `GROQ_API_KEY` | yes | Natural-language reasoning and structuring (Llama / Qwen models on Groq) |
| `BACKEND_URL` | yes (deployed) | Where to send the `pipeline-complete` callback |
| `INTERNAL_API_SECRET` | recommended | Sent as `x-internal-secret` on that callback |
| `S3_*` / `R2_*` | deployed | Same storage as the backend — the AI service downloads invoice files |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | optional | Fraud graph queries |
| `PORT` | no | Defaults to 4100 |
| `GROQ_MAX_RETRIES` | no | Retries on Groq 429 rate-limit errors (default 6, roughly 20 s of waiting in total) |
| `INVOICE_QUEUE`, `PGSSL`, `LOCAL_UPLOAD_DIR` | no | As above |

### Test and evaluation only

`TEST_DATABASE_URL`, `TEST_USE_NEO4J`, `FORCE_SEED`, `SEED_ONLY` (`main` or `vendor-state`), `EVAL_BASE_URL`, `EVAL_DECISION_TIMEOUT_MS`, `EVAL_DEGRADED_WARMUPS`, `EVAL_BOUNDARY_WARMUPS`, `EVAL_ADMIN_EMAIL`, `EVAL_ADMIN_PASSWORD`, `STRICT_BASELINE`, `VERBOSE`.

> Never commit `.env` files. They are git-ignored, and the project zip is built without them.

---

## Database and migrations

`npm run migrate` (in `backend/`) applies every file in `db/` in filename order and records each in a `schema_migrations` table, so re-running is always safe and only new files run.

| # | Migration | Purpose |
|---|---|---|
| 001 | core_schema | Companies, users, vendors, requirements, quotations, POs, GRNs, invoices |
| 002 | ai_schema | OCR results, matching, compliance and Context Gate decision tables |
| 003 | vendor_risk | Vendor risk scores and fraud flags |
| 004 | vendor_bank_address | Vendor address; bank fields start being collected |
| 005 | registration_hardening | Company and PAN proof documents; invoice override audit trail |
| 006 | company_approval | Platform Admin approval for companies |
| 007 | user_deactivation | Soft-delete (`is_active`) for team members |
| 008 | vendor_communications | AI-drafted dispute records |
| 009 | dispute_messages | Dispute message thread |
| 010 | dispute_withdrawal_resilience | Disputes survive an invoice being withdrawn |
| 011 | dispute_message_sender_names | Sender name captured on each dispute message |
| 012 | exact_success_counters | Exact per-metric event counters |
| 013 | legacy_import_support | Legacy import audit trail and platform summary view |
| 014 | pending_invite_unique | One pending invitation per company/email |
| 015 | user_permanent_delete | `deleted_at` for permanent deletion |
| 016 | outbound_notifications | Old voice-call notifications table (no longer written to) |
| 017 | notifications | Persistent in-app notifications |
| 018 | notifications_all_roles | Notifications for company roles and Platform Admin |
| 019 | dispute_cleanup_on_close | `closed_reason` and dispute clean-up |
| 020 | dispute_auto_close | Auto-closed disputes are not resolutions |
| 021 | close_reputation_only_drafts | Close drafts driven only by vendor reputation |
| 022 | fraud_flag_invoice_snapshot | Fraud flags keep invoice details after withdrawal |
| 023 | communication_channels | Quotation and PO message threads; GRN source-message link |
| 024 | grn_corrections | GRN voiding and correction requests |
| 025 | grn_quality | Per-GRN quality rating and vendor quality roll-up |
| 026 | fix_vendor_metric_weighting | One-time repair of stored vendor metrics |

**Deployments do not run migrations.** After adding a migration, run it against the production database yourself *before* deploying the code that needs it (see below).

---

## Deployment

The deployed stack:

| Part | Service | Notes |
|---|---|---|
| Backend (API + frontend + Socket.io) | **Render** web service | Node runtime, Root Directory `backend` |
| AI service | **Render** web service | **Docker** runtime, Root Directory `ai-service` (the Dockerfile installs `poppler-utils`) |
| Database | **Supabase** Postgres | SSL handled automatically |
| File storage | **Supabase Storage** | Through its S3-compatible endpoint (`S3_*` variables) |
| Queue | **CloudAMQP** | `RABBITMQ_URL` (`amqps://…`) |
| Graph | **Neo4j Aura** | `NEO4J_URI` (`neo4j+s://…`) |
| LLM | **Groq** | `GROQ_API_KEY` |

The repository has no `render.yaml`, and the backend has no `start` script; the backend's start command is `node src/server.js` (`npm run dev` runs the same file). The backend serves `../frontend`, so keep the `backend/` and `frontend/` folders as siblings.

### First-time setup

1. **Supabase** — create a project. Copy the Postgres connection string. If Render cannot reach the direct connection (Render is IPv4), use Supabase's pooler connection string instead.
2. **Supabase Storage** — create a **private** bucket and generate S3 access keys. You need the S3 endpoint, region, access key id, secret and bucket name for the `S3_*` variables.
3. **CloudAMQP** — create an instance and copy its AMQP URL.
4. **Neo4j Aura** — create a free instance and keep its URI, username and password.
5. **Run the migrations** from your machine against Supabase: put the Supabase URL in `backend/.env` as `DATABASE_URL`, then `cd backend && npm run migrate`.
6. **Create the first Platform Admin.** `npm run seed` erases data and is blocked on a non-test database, so insert one admin directly:
   ```bash
   node -e "console.log(require('bcrypt').hashSync('<strong password>', 10))"
   ```
   ```sql
   INSERT INTO users (name, email, password_hash, role)
   VALUES ('Platform Admin', 'you@example.com', '<hash from above>', 'platform_admin');
   ```
7. **Deploy the AI service** (Docker). Set `DATABASE_URL`, `RABBITMQ_URL`, `NEO4J_*`, `S3_*`, `GROQ_API_KEY`, `INTERNAL_API_SECRET`, and `BACKEND_URL` once the backend URL exists.
8. **Deploy the backend.** Set `DATABASE_URL`, `RABBITMQ_URL`, `NEO4J_*`, `S3_*`, `INTERNAL_API_SECRET`, `JWT_SECRET`, `AI_SERVICE_URL` (the AI service's public URL) and `DEFAULT_COUNTRY_CODE`.
9. Each service needs the other's URL, so deploy both, then fill in `BACKEND_URL` / `AI_SERVICE_URL` and redeploy.
10. **Verify** — `/health` on the backend returns `{"status":"ok"}`; `/health` on the AI service shows `groq_configured` and `neo4j_configured` as `true`; log in as Platform Admin.

### Releasing a change

1. Run any **new migration** against Supabase (`npm run migrate` with the Supabase `DATABASE_URL`).
2. Push; Render redeploys both services.
3. Wake the AI service (open its `/health`) before testing quotation ranking or invoice verification.

If you reset the Supabase database password, update `DATABASE_URL` on **both** Render services.

### Free-tier behaviour

- Render free services sleep after ~15 minutes without an HTTP request. The AI service's RabbitMQ consumer does not count as traffic, so the backend pings the AI service's `/health` on start and every 10 minutes while it is awake. If the **backend** is asleep, nothing wakes the AI service until someone loads the site.
- If quotations show no rank, AI score or reasoning — or a submitted invoice just sits in verification — the AI service is asleep. Open its `/health` and try again.
- The backend also checks payment deadlines on start and every 15 minutes while awake; Finance page loads trigger a throttled check, so a sleeping server catches up when someone opens the app.
- Free Neo4j Aura instances pause when idle; shell-company detection returns "no signal" until the instance is resumed.

### Security checklist before real use

- Use a long random `JWT_SECRET` and set the **same** `INTERNAL_API_SECRET` on both services.
- Never run the seed script against production, and never keep the seeded `password123` accounts there.
- Keep the storage bucket private; files are only served through authenticated API routes.
- Socket.io currently accepts connections from any origin (`cors: { origin: '*' }` in `server.js`). Authentication is by JWT, but tighten the origin to your site URL for a real deployment.

---

## Notifications

Every important event creates a **persistent notification** (a row in `notifications`, shown under the bell with an unread badge) and, if the recipient has a page open, a **real-time toast** over Socket.io. Sockets authenticate with the login JWT, and the private room a socket joins (`vendor_<id>`, `company_<id>_<role>`, `platform_admin`) comes only from the verified token.

| Recipient | Events |
|---|---|
| Vendor | quotation accepted / not selected · goods received (full, partial with remaining quantity and date, or over-delivery) · delivery voided after an approved GRN correction · invoice verified · dispute raised, new message, resolved · invoice paid · account verified / rejected |
| Procurement | new quotation received · delivery recorded · vendor price/delivery update and messages · GRN correction requested / approved |
| Finance | invoice flagged · invoice verified and ready for payment · vendor replied on a dispute · invoice withdrawn after a GRN correction · payment due soon · payment overdue |
| Warehouse | new purchase order ready to receive · PO message from the vendor · GRN correction approved |
| Company Admin | company approved / rejected · GRN correction requested |
| Requester of a GRN correction | correction rejected (with the reviewer's reason) |
| Platform Admin | new vendor or company awaiting verification · new fraud flag |

Read state for company roles is shared by everyone holding that role in the company. Notification endpoints: `GET /api/notifications/mine`, `GET /api/notifications/unread-count`, `POST /api/notifications/:id/read`.

Not built, by design: SMS, email and mobile push. An earlier voice-call integration was removed; its table (migration 016) remains but is never written to.

---

## Testing and evaluation

All test scripts run against the **test database only** (through `with-test-db.js`). Run them from `backend/`:

| Command | Covers |
|---|---|
| `npm run test:comms` | Quotation and PO message threads, sourced delivery dates, thread closing |
| `npm run test:grn-corrections` | Correction request lifecycle, voiding, payment hold, guard rails |
| `npm run test:grn-quality` | Quality rating validation and quantity-weighted ranking signal |
| `npm run test:fraud-fixes` | Stale-edge clean-up, revoked-vendor handling, re-decision after fraud review |
| `npm run test:vendor-risk` | Per-metric weighting of the running averages |
| `npm run test:payment-deadlines` | Due-soon and overdue notifications, de-duplication, auto-close |
| `npm run seed:synthetic` | Builds the 15-invoice evaluation set through the real API |
| `npm run evaluate` | Context Gate accuracy against an equal-weight baseline |
| `npm run evaluate:vendor-states` | Eight structural checks on how vendor history changes decisions |

**Evaluation dataset.** Fifteen invoices with a known correct outcome — 8 clean, 4 legitimate variance, 2 genuine mismatch, 1 planted fraud — built end-to-end through the real API (register → approve → requirement → quotation → accept → GRN → generated PDF invoice → async pipeline).

**Reference result.** Context Gate 15/15 vs 13/15 for a plain equal-weight average. In the vendor-state checks 7 passed; `shell-company-1` shows *NOT TESTED* because test mode switches Neo4j off (use a separate Neo4j instance with `TEST_USE_NEO4J=1`), and `ranking-1` is reported as an expected design property (a vendor with no history scores exactly 1.0 when price and delivery tie). The degraded vendor's clean invoice is flagged by the Context Gate (≈ 0.62) but would score 0.75 and auto-approve under a plain average. Running it spends roughly 30 Groq calls' worth of free-tier quota, so avoid repeating it needlessly.

For a manual, click-through verification of every feature see **`Checklist.md`**.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Quotations show no rank / AI score | AI service asleep (free tier) — open its `/health`, then reload |
| Invoice stuck on "verifying" | AI service asleep, RabbitMQ unreachable, or Groq rate-limited (retries up to 6 times) |
| Uploads fail or files 404 after deploy | `S3_*` variables incomplete on one of the two services — all of endpoint, key, secret and bucket must be set on **both** |
| `relation … does not exist` / missing column | A migration wasn't run on the production database |
| Backend can't connect to Postgres from Render | Use Supabase's pooler connection string; make sure `DATABASE_URL` was updated on both services after any password reset |
| No toasts appear | Socket connection rejected — confirm the same `JWT_SECRET` is set and the user's role has a notification room |
| Shell-company check reports no signal | `NEO4J_*` not set, or the Aura instance is paused |
| `Refusing to seed` | By design — the seed script only runs on a database with `test` in its name |
| Scanned-PDF OCR fails locally | `poppler-utils` is not installed or not on `PATH` |
| Code change has no effect locally | Scripts run plain `node` — restart the backend and ai-service |

---

## Known limitations

- **Multi-item requirements are not supported.** One requirement is one item; the original idea of fanning one requirement into one PO per item was designed but is not part of this build.
- **Split-billing detection (Fraud check 3) is dormant**, because only one invoice is allowed per PO.
- **Voiding a GRN does not reverse** the on-time-delivery score event it created.
- The password policy applies to account **creation** forms only; there is no password-change flow.
- No SMS, email or push notifications (in-app only).
- `backend/src/server.js` requires `node-fetch` at runtime but `package.json` lists it under `devDependencies`. It works where dev dependencies are installed; move it to `dependencies` if a host omits them.
- Free-tier hosting means cold starts, and a free Neo4j instance that pauses when idle.
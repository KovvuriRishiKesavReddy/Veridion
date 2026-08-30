# Veridion

**Enterprise Agentic AI Platform for Vendor & Procurement Management**

Veridion automates the full B2B procurement lifecycle — from requirement posting through vendor quotation, purchase order generation, delivery confirmation, and AI-verified invoice approval — using a coordinated pipeline of specialized AI agents built around a **Context Gate**: a confidence-weighted decision engine that fuses multiple AI signals into one explainable, auditable decision rather than a black-box verdict.

This README covers **Flow 1 through Flow 3** — the core lifecycle, the AI verification pipeline, and fraud/vendor-risk detection. Flows 4 onward (quotation ranking, vendor communication, multi-company isolation, voice notifications, admin tooling, deployment) build on top of this foundation.

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
│   └── scripts/       migrate.js, seed.js
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
└── db/                8 migrations, applied in order
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
This applies all 8 migrations under `db/` in order — core schema, AI/Context Gate tables, vendor risk scoring, vendor bank/address fields, registration hardening, company approval workflow, user deactivation, and multi-item requirement support.

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

## A note on scope

This is an actively evolving build — the codebase includes a substantial amount of hardening beyond the original spec, found through real testing rather than assumed upfront: offline-capable OCR (no external CDN dependency), a GST/pre-tax amount calculation shared consistently across every agent that touches it, a vendor-identity-consistency fraud check, a pipeline failure safety net (no invoice can silently vanish if something goes wrong mid-processing), and a company approval workflow mirroring vendor verification. Treat the code comments as the authoritative source for *why* something is built the way it is — several of the less obvious design choices are explained inline at the point they matter.
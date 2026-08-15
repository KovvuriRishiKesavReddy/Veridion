# Veridion — Flow 1 (Core Lifecycle, No AI Yet)

No Docker. Just local Node.js + a local (or free-tier hosted) PostgreSQL instance.

## What's in this flow
Register a vendor, register a company, add team members, post a requirement,
submit a quotation, accept it (auto-generates a PDF PO), record a GRN (full or
partial), upload an invoice. No AI anywhere yet — that's Flow 2.

## 1. Prerequisites
- Node.js 20+
- A PostgreSQL 16 server. Easiest options without Docker:
  - Install Postgres locally (`brew install postgresql@16` on Mac, or the
    Windows installer, or `apt install postgresql` on Linux) and create a db:
    ```
    createdb veridion
    ```
  - OR use a free hosted Postgres (Render, Supabase, Neon) and just paste the
    connection string into `.env` — nothing else in this flow changes.

## 2. Setup
```bash
cd backend
cp .env.example .env
# edit .env: set DATABASE_URL and JWT_SECRET
npm install
npm run migrate      # runs db/001_core_schema.sql
npm run seed         # runs db/seed.sql — creates test logins for every role
npm run dev          # starts everything on http://localhost:4000
```

## 3. Frontend — served from the SAME server, same port
There is no separate frontend server / no `npx serve`. The backend
(`backend/src/server.js`) serves the plain HTML/CSS/Bootstrap 5/vanilla-JS
files in `/frontend` directly, alongside the API, on port 4000.

Just open:
```
http://localhost:4000/login.html
```
That's the only URL you need. Don't run a second static server on a
different port (e.g. 5500) — if you do, that second server knows nothing
about your API routes and every link will 404 there. One process, one port,
for this whole flow.

If you ever see "frontend folder not found" in the server's terminal output
on startup, your folder layout doesn't match `veridion/backend` and
`veridion/frontend` as siblings — check that first before anything else.

## 4. Seeded test logins (password for all: `password123`)
- platform admin: admin@veridion.dev
- Company A: admin@brightbuild.test (company_admin), proc@brightbuild.test,
  finance@brightbuild.test, warehouse@brightbuild.test
- Company B: admin@steelcorp.test (company_admin), proc@steelcorp.test,
  finance@steelcorp.test, warehouse@steelcorp.test
- Vendors: vendor1@test.dev (verified), vendor2@test.dev (pending),
  vendor3@test.dev (rejected)

## 5. Manual test walkthrough (do this before Flow 2)
1. Log in as proc@brightbuild.test → post a requirement.
2. Log in as vendor1@test.dev → submit a quotation on it.
3. Log in as proc@brightbuild.test → accept the quotation → PO PDF generated.
4. Log in as warehouse@brightbuild.test → record a GRN, once full delivery,
   once a partial delivery on a different PO → confirm status badges.
5. Log in as vendor1@test.dev → upload an invoice against the PO/GRN.
6. Confirm the warehouse role never sees price fields anywhere (network tab
   included — the API strips it server-side, not just hidden in HTML).

Once all of that works cleanly, we move to Flow 2 (AI: OCR, Matching,
Compliance, the Context Gate).

---

# Flow 2 — The Core AI Decision (OCR, Matching, Compliance, the Context Gate)

## What's new
Every invoice a vendor submits now automatically runs through four stages: OCR/Structuring
(Agent 1), Semantic Matching against the GRN (Agent 2), Compliance/GST validation (Agent 3),
and the Context Gate Decision Engine (Agent 8) — producing an auto-approval or a flag with
full plain-English reasoning, visible on the new Invoice Review page.

## Setup (in addition to everything from Flow 1)

### 1. Install RabbitMQ locally (no Docker)
- **Mac:** `brew install rabbitmq && brew services start rabbitmq`
- **Windows:** download the installer from rabbitmq.com (it needs Erlang installed first —
  the installer will prompt you)
- **Linux:** `sudo apt install rabbitmq-server && sudo service rabbitmq-server start`

Confirm it's running: `rabbitmqctl status` should print server info without errors.

### 2. Get a free Groq API key (optional, but recommended)
Go to console.groq.com, sign up, create an API key. **The pipeline works without one** —
every agent falls back to deterministic, honest logic (matching scores, GSTIN validation,
the Context Gate math are all pure calculation, not AI). Only the natural-language
`reasoning_text` on each decision is templated instead of LLM-written until you add a key.

### 3. Set up the ai-service
```bash
cd ai-service
cp .env.example .env
# edit .env: DATABASE_URL (same as backend's), RABBITMQ_URL=amqp://localhost,
# and GROQ_API_KEY if you have one
npm install
npm run dev      # starts on http://localhost:4100, and begins consuming the queue
```

### 4. Apply the new migration
```bash
cd backend
npm run migrate   # picks up 002_ai_schema.sql automatically — safe to re-run
```

### 5. Run everything
You now need **three things running at once**, each in its own terminal:
1. `cd backend && npm run dev` (port 4000 — API + frontend)
2. `cd ai-service && npm run dev` (port 4100 — AI agents + RabbitMQ consumer)
3. RabbitMQ and Postgres running as background services (steps above)

## How to test it
1. Walk through the Flow 1 lifecycle as usual: quote → accept → GRN → invoice.
2. The moment the invoice is submitted, the backend publishes to RabbitMQ — watch the
   `ai-service` terminal, you should see `[pipeline] invoice N: starting OCR` and so on,
   finishing with `DONE — auto_approved` or `DONE — flagged`.
3. Log in as Finance → go to **Invoices** → click any invoice number (or **Review**) →
   you'll see the full breakdown: System Decision, confidence badge, Matching results,
   Compliance results, and the raw OCR/structuring output.
4. Try a **clean** invoice (amounts matching the PO, valid GSTIN) — should auto-approve.
5. Try a **mismatched** invoice (wrong quantity, or a garbage GSTIN like `INVALIDGSTIN`) —
   should get flagged, with the mismatch specifics visible in the Matching card.

## Troubleshooting
- **Nothing happens after uploading an invoice:** check the `ai-service` terminal for
  errors, and confirm RabbitMQ is running (`rabbitmqctl status`).
- **Review page says "AI verification hasn't run yet":** the pipeline may still be
  running (OCR can take a moment) — refresh after a few seconds. If it never appears,
  check the ai-service log.
- **Groq errors in the ai-service log:** double check `GROQ_API_KEY` in `ai-service/.env`
  is correct, or leave it blank to use the fallback path.

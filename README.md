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

---

# Flow 3 — Fraud Detection and Vendor Risk (completing the Decision Engine)

## What's new
The Context Gate now factors in all four suppliers: Matching, Compliance, Fraud
Detection (Agent 4, via Neo4j), and Vendor Risk (Agent 5, an event-triggered running
average). A vendor's on-time-delivery and invoice-accuracy scores now update
automatically after every GRN and every invoice decision. A high-severity fraud
finding bypasses the normal weighted score entirely and routes straight to a new
Platform Admin **Fraud Review Queue**.

## Neo4j setup — use AuraDB free tier, not a local install
Unlike Postgres/RabbitMQ, Neo4j's local install is heavier (needs the JVM, more
moving parts). The genuinely easiest no-Docker path is the free cloud tier:
1. Go to https://neo4j.com/cloud/aura-free/, sign up, create a free instance
2. It gives you a connection URI (`neo4j+s://...`), a username (`neo4j`), and a password
3. Put those into `ai-service/.env`:
   ```
   NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=your-generated-password
   ```
4. Restart `ai-service`

**Without Neo4j configured, everything still works** — Fraud Detection just reports
"no signal" for every invoice (logged once as a warning in the ai-service terminal,
not a silent failure). Vendor Risk Scoring, Matching, Compliance, and the Context
Gate math all work identically either way, since Neo4j only feeds Agent 4.

## How to test Vendor Risk Scoring
1. Run through a delivery (post requirement → quote → accept → GRN).
2. Check the database directly to see it update:
   ```sql
   SELECT * FROM vendor_risk_scores;
   ```
   You should see `data_volume: 1`, `on_time_delivery_pct: 100` (or `0` if the GRN's
   `received_date` was after the PO's `agreed_delivery_date`) immediately after the GRN.
3. Submit and get an invoice decided — `data_volume` should tick up again, and
   `invoice_accuracy_pct` should now be populated.
4. Do a second full cycle with the same vendor — watch the running average shift
   slightly rather than resetting, exactly like the spec's own worked examples.

## How to test Fraud Detection
Without a live Neo4j, the realistic test is confirming graceful degradation:
1. Submit any invoice, check the `ai-service` terminal — you should see the `[Neo4j]
   NEO4J_URI not configured...` warning exactly once, and the pipeline should still
   complete normally (`DONE — auto_approved` or `flagged`, never crashing).

With Neo4j configured, to actually trigger a fraud flag you'd need two vendors
sharing a bank account or address in the graph — this isn't wired into the UI yet
(no form for entering bank details currently), so the realistic way to test the full
suspicious-routing path for now is inserting a fraud_flags row directly:
```sql
INSERT INTO fraud_flags (vendor_id, invoice_id, flag_type, severity, evidence, confidence_score)
VALUES (1, 1, 'shell_company_shared_bank_account', 'high', '{}', 0.95);
```
Then log in as Platform Admin → you should see it under **Fraud Review Queue**, with
a **Mark Resolved** action.

## Platform Admin: Fraud Review Queue
New section on the admin dashboard. Any invoice the Context Gate marks `suspicious`
(triggered by a high-severity fraud flag) shows up here — this is a deliberate
override, not just a heavily-weighted low score: the gate skips its normal
calculation entirely rather than letting other clean signals dilute a real fraud
finding.

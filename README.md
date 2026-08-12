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

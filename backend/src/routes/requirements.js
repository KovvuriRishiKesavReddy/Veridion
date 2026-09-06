const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { requireVerifiedVendor } = require('../middleware/vendorVerification');
const { requireApprovedCompany } = require('../middleware/companyApproval');
const { callAiService } = require('../utils/aiService');

const router = express.Router();

// POST /api/requirements (procurement)
router.post('/', requireAuth, requireRole('procurement'), requireApprovedCompany, async (req, res) => {
  const { title, description, category, quantity, unit, deadline } = req.body;
  if (!title || !quantity) return res.status(400).json({ error: 'title and quantity are required' });

  const result = await db.query(
    `INSERT INTO requirements (company_id, title, description, category, quantity, unit, deadline, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.company_id, title, description || null, category || null, quantity, unit || null, deadline || null, req.user.id]
  );
  res.status(201).json(result.rows[0]);
});

// GET /api/requirements (vendor) — browsable, filterable by category, open only.
// Excludes any requirement this vendor has already quoted on — otherwise it stays
// visible and inviting a second (duplicate/conflicting) quotation on the same job.
router.get('/', requireAuth, requireRole('vendor'), requireVerifiedVendor, async (req, res) => {
  const { category } = req.query;
  const params = [req.user.vendor_id];
  let sql = `SELECT r.*, c.name as company_name FROM requirements r
             JOIN companies c ON c.id = r.company_id
             WHERE r.status = 'open'
             AND NOT EXISTS (
               SELECT 1 FROM quotations q WHERE q.requirement_id = r.id AND q.vendor_id = $1
             )`;
  if (category) {
    params.push(category);
    sql += ` AND r.category = $${params.length}`;
  }
  sql += ' ORDER BY r.created_at DESC';
  const result = await db.query(sql, params);
  res.json(result.rows);
});

// GET /api/requirements/mine (procurement) — company's own requirements
router.get('/mine', requireAuth, requireRole('procurement', 'finance'), async (req, res) => {
  const result = await db.query(
    `SELECT * FROM requirements WHERE company_id = $1 ORDER BY created_at DESC`,
    [req.user.company_id]
  );
  res.json(result.rows);
});

// GET /api/requirements/:id/quotations (procurement) — AI-ranked via the Context Gate
// (Agent 6). By default recomputes the ranking synchronously against the ai-service —
// Procurement opening this page wants the current ranking, not a stale one. Pass
// ?rerank=false to skip that recompute and just re-read whatever's already stored
// (used by the page's 1-second live-poll, so a new quotation arriving shows up without
// calling out to Groq every second); a genuinely new, never-yet-ranked quotation still
// forces one rerank even with rerank=false, since that's a rare one-off event, not a
// per-tick cost. If ai-service is unreachable, degrades gracefully to price-ascending
// (Flow 1's original behavior) rather than breaking the page — same posture as every
// other AI-optional path in this codebase (Neo4j, Groq).
router.get('/:id/quotations', requireAuth, requireRole('procurement'), async (req, res) => {
  const reqCheck = await db.query(
    `SELECT id FROM requirements WHERE id = $1 AND company_id = $2`,
    [req.params.id, req.user.company_id]
  );
  if (!reqCheck.rows[0]) return res.status(404).json({ error: 'Requirement not found' });

  const countRes = await db.query(
    `SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE ai_rank_score IS NULL)::int as unranked
     FROM quotations WHERE requirement_id = $1`,
    [req.params.id]
  );
  const { total, unranked } = countRes.rows[0];
  const wantsRerank = req.query.rerank !== 'false';
  if (total > 0 && (wantsRerank || unranked > 0)) {
    await callAiService('/agents/rank-quotations', { requirement_id: Number(req.params.id) });
  }

  const result = await db.query(
    `SELECT q.*, v.company_name as vendor_name, v.verification_status
     FROM quotations q JOIN vendors v ON v.id = q.vendor_id
     WHERE q.requirement_id = $1
     ORDER BY q.ai_rank_score DESC NULLS LAST, q.price ASC`,
    [req.params.id]
  );
  res.json(result.rows);
});

module.exports = router;

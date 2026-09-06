// backend/src/utils/aiService.js
//
// A small HTTP client for the handful of ai-service agent routes the backend needs
// to call directly and SYNCHRONOUSLY (unlike invoice processing, which goes through
// RabbitMQ — see utils/queue.js — because nothing in Flow 1/2/3 needs to wait on its
// result). Quotation ranking is different: Procurement is looking at the comparison
// page right now and wants the current ranking, not an eventually-consistent one.
//
// AI_SERVICE_URL defaults to the same host/port ai-service listens on by default
// (see ai-service/.env.example's PORT=4100) so this works out of the box in local
// dev without any extra configuration.
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:4100';

// callAiService: never throws. Returns the parsed JSON body on success, or null on
// any failure (network error, timeout, non-2xx status) — callers are responsible for
// falling back to a sensible default (e.g. sorting by price) rather than breaking the
// page just because the AI service happens to be down. Same graceful-degradation
// posture as neo4jSync.js and the Groq fallbacks throughout ai-service.
async function callAiService(path, body, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${AI_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[aiService] ${path} returned ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[aiService] ${path} failed (ai-service unreachable or timed out): ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { callAiService };

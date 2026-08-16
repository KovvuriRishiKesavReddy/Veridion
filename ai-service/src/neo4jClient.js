require('dotenv').config();
const neo4j = require('neo4j-driver');

let driver = null;
let connectionWarned = false;

function getDriver() {
  if (driver) return driver;
  if (!process.env.NEO4J_URI) return null;
  driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD || '')
  );
  return driver;
}

// runCypher: executes a read query, returning [] (never throwing) if Neo4j isn't
// configured or unreachable. Fraud Detection (Agent 4) treats an empty result as "no
// fraud signal found" — the same shape as a genuine clean result — so the rest of the
// Context Gate pipeline keeps working normally even without Neo4j running. This is a
// deliberate degrade-gracefully design, loudly logged once so it's obvious in the
// ai-service terminal that fraud checks aren't actually running, rather than failing
// invisibly and looking like "no fraud ever found" forever.
async function runCypher(query, params = {}) {
  const d = getDriver();
  if (!d) {
    if (!connectionWarned) {
      console.warn('[Neo4j] NEO4J_URI not configured — Fraud Detection (Agent 4) will report no signal for every invoice. Set up Neo4j AuraDB (free tier) and configure ai-service/.env to enable real fraud detection.');
      connectionWarned = true;
    }
    return [];
  }

  const session = d.session();
  try {
    const result = await session.run(query, params);
    return result.records;
  } catch (err) {
    if (!connectionWarned) {
      console.warn(`[Neo4j] Query failed (${err.message}) — Fraud Detection degrading to "no signal" until Neo4j is reachable.`);
      connectionWarned = true;
    }
    return [];
  } finally {
    await session.close();
  }
}

module.exports = { runCypher };

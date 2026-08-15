// Runs every .sql file in /db in filename order, tracking which ones have already
// been applied in a schema_migrations table — so re-running this is always safe,
// and adding a new migration file (like 002_ai_schema.sql) applies just that file
// instead of re-running everything from scratch (which would fail on tables that
// already exist).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const appliedRes = await pool.query(`SELECT filename FROM schema_migrations`);
  const applied = new Set(appliedRes.rows.map(r => r.filename));

  const dbDir = path.join(__dirname, '..', '..', 'db');
  const files = fs.readdirSync(dbDir)
    .filter(f => f.endsWith('.sql') && f !== 'seed.sql')
    .sort();

  let ranAny = false;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping (already applied): ${file}`);
      continue;
    }
    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(dbDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      ranAny = true;
    } catch (err) {
      await client.query('ROLLBACK');
      // Duplicate table/column/object codes mean this migration's objects already exist —
      // i.e. it was applied before schema_migrations existed to track it (exactly the
      // situation for any database created before this tracking table was added). Record
      // it as applied and move on, rather than treating a legacy database as broken.
      const ALREADY_EXISTS_CODES = ['42P07', '42701', '42710'];
      if (ALREADY_EXISTS_CODES.includes(err.code)) {
        console.log(`  -> objects already exist (pre-dates migration tracking) — marking ${file} as applied.`);
        await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
      } else {
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    } finally {
      client.release();
    }
  }

  console.log(ranAny ? 'Migrations complete.' : 'Nothing new to migrate — already up to date.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

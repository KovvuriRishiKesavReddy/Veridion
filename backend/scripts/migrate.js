// Runs every .sql file in /db in filename order. No Docker, no migration
// framework — just plain sequential SQL, which is all a solo build needs.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dbDir = path.join(__dirname, '..', '..', 'db');
  const files = fs.readdirSync(dbDir)
    .filter(f => f.endsWith('.sql') && f !== 'seed.sql')
    .sort();

  for (const file of files) {
    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(dbDir, file), 'utf8');
    await pool.query(sql);
  }
  console.log('Migrations complete.');
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

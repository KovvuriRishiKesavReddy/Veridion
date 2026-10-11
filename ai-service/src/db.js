const { Pool, types } = require('pg');
require('dotenv').config();

// Same fix as the backend's db.js — see that file for the full explanation. Both
// services connect to the same Postgres, so both need this or dates read here
// would silently shift by a day in any timezone ahead of UTC.
types.setTypeParser(1082, (val) => val);

// Supabase requires SSL; local Postgres doesn't support it.
const useSsl = process.env.DATABASE_URL && !/@(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.DATABASE_URL) && process.env.PGSSL !== 'off';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : false });

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};

const { Pool, types } = require('pg');
require('dotenv').config();

// Same fix as the backend's db.js — see that file for the full explanation. Both
// services connect to the same Postgres, so both need this or dates read here
// would silently shift by a day in any timezone ahead of UTC.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};

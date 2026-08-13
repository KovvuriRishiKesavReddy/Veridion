const { Pool, types } = require('pg');
require('dotenv').config();

// Postgres DATE columns (OID 1082) are parsed by node-postgres into JS Date
// objects using the SERVER'S LOCAL TIMEZONE as local midnight. When that
// Date is later JSON-serialized, JSON.stringify calls .toISOString(), which
// converts to UTC — so in any timezone ahead of UTC (e.g. IST, +5:30), the
// date silently shifts back a day (local midnight -> previous day 18:30 UTC).
//
// Fix: never let pg turn DATE columns into JS Date objects at all — keep
// them as the plain 'YYYY-MM-DD' string Postgres already returns. This
// removes the entire class of off-by-one-day bugs across every date field
// (agreed_delivery_date, received_date, expected_next_delivery_date, deadline).
//
// IMPORTANT: must use `types` from `require('pg')` itself, NOT a separately
// required `pg-types` package — npm can install two separate copies (a
// top-level one and one nested inside pg's own node_modules), and setting
// the parser on the wrong instance silently does nothing.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(), // for transactions
  pool
};

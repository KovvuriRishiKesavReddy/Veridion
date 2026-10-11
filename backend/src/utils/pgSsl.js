// Supabase (and most hosted Postgres) requires SSL; local Postgres doesn't support it.
// Returns the right `ssl` option for a connection string.
function sslFor(url) {
  if (!url || /@(localhost|127\.0\.0\.1)(:|\/|$)/.test(url) || process.env.PGSSL === 'off') return false;
  return { rejectUnauthorized: false };
}
module.exports = { sslFor };

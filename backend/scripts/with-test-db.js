// backend/scripts/with-test-db.js
//
// Runs ANY command in isolated "test mode" so it cannot touch your real data:
//   node scripts/with-test-db.js <command...>        e.g.  node scripts/with-test-db.js node src/server.js
// (the npm scripts dev:test, migrate:test, seed:test, seed:synthetic, evaluate,
//  evaluate:vendor-states — in both backend/ and ai-service/ — all go through this file.)
//
// What it does, for the child process only (your .env files and other terminals are never changed):
//   1. Finds the test database URL: TEST_DATABASE_URL (env), else backend/.env.test
//      (TEST_DATABASE_URL= or DATABASE_URL= inside it).
//   2. REFUSES to continue unless the database name contains "test", or if it is the same
//      database as the one in backend/.env (your real one).
//   3. Overrides DATABASE_URL / TEST_DATABASE_URL with it, gives the pipeline its own RabbitMQ
//      queue (INVOICE_QUEUE=invoice.submitted.test) so test messages can never be consumed by a
//      normal ai-service later, and blanks NEO4J_URI so synthetic vendors never reach your real
//      graph (set TEST_USE_NEO4J=1 to keep Neo4j, e.g. for the shell-company case, ideally a
//      separate Neo4j instance).
//   4. Prints a banner naming the database so you can see which one you are on.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

const backendDir = path.join(__dirname, '..');
const args = process.argv.slice(2);
if (!args.length) { console.error('Usage: node scripts/with-test-db.js <command...>'); process.exit(1); }

const readEnv = file => { try { return dotenv.parse(fs.readFileSync(file)); } catch (_) { return {}; } };
const testFile = readEnv(path.join(backendDir, '.env.test'));
const realFile = readEnv(path.join(backendDir, '.env'));

const testUrl = process.env.TEST_DATABASE_URL || testFile.TEST_DATABASE_URL || testFile.DATABASE_URL;
const realUrl = realFile.DATABASE_URL;

function fail(msg) { console.error(`\n[test mode] REFUSING TO RUN — ${msg}\n`); process.exit(1); }
const parse = url => { try { const u = new URL(url); return { name: u.pathname.replace(/^\//, ''), host: `${u.hostname}:${u.port || '5432'}` }; } catch (_) { return null; } };

if (!testUrl) fail('no test database configured.\n  1. Create it:  psql -U postgres -c "CREATE DATABASE veridion_test;"\n  2. Put this line in backend/.env.test:\n       DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/veridion_test');
const t = parse(testUrl);
if (!t) fail('the test database URL in backend/.env.test is not a valid postgres URL.');
if (!/test/i.test(t.name)) fail(`database "${t.name}" does not contain "test" in its name. Point backend/.env.test at a database like veridion_test.`);
const r = realUrl && parse(realUrl);
if (r && r.name === t.name && r.host === t.host) fail(`backend/.env.test points at the SAME database as backend/.env ("${r.name}"). Use a separate database.`);

const env = {
  ...process.env,
  DATABASE_URL: testUrl,
  TEST_DATABASE_URL: testUrl,
  INVOICE_QUEUE: 'invoice.submitted.test',
  VERIDION_TEST_MODE: '1'
};
if (process.env.TEST_USE_NEO4J !== '1') env.NEO4J_URI = '';

console.log(`\n[test mode] database: ${t.name} @ ${t.host}   queue: ${env.INVOICE_QUEUE}   neo4j: ${env.NEO4J_URI === '' ? 'OFF (graph untouched)' : 'ON'}`);
console.log(`[test mode] your real database${r ? ` ("${r.name}")` : ''} is not used by this process.\n`);

// Re-quote any argument containing spaces/shell characters so `node -e "..."` style commands survive.
const quote = a => (/[\s()&|<>^;]/.test(a) ? JSON.stringify(a) : a);
const child = spawn(args.map(quote).join(' '), { stdio: 'inherit', shell: true, env });
child.on('exit', code => process.exit(code ?? 1));
child.on('error', err => { console.error(err); process.exit(1); });

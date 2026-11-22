// Replace the local D1 database with a fresh copy of production, so local dev has real
// data instead of an empty app. Production is only read (exported), never written.
// Run by the owner only: wrangler stays logged out so agents can't reach production,
// so this is run as `npx wrangler login`, `npm run db:pull`, `npx wrangler logout`.
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { loadDump } from './load-dump.mjs';

const DB = 'recipes-db';
const DUMP = '.wrangler/prod-dump.sql';

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

mkdirSync('.wrangler', { recursive: true });
run(`npx wrangler d1 export ${DB} --remote --output=${DUMP}`);

// Start from an empty local database so rows deleted in production disappear locally too.
rmSync('.wrangler/state/v3/d1', { recursive: true, force: true });
// Pictures are too big for `wrangler d1 execute`, so loadDump inserts them on their own.
await loadDump(DUMP);

// schema.sql only uses IF NOT EXISTS, so this adds any tables the current branch
// introduced that production doesn't have yet, and changes nothing else.
run(`npx wrangler d1 execute ${DB} --local --file=schema.sql --yes`);

console.log('Local database now matches production.');

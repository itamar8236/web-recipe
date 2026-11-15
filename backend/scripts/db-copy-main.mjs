// Replace this worktree's local D1 database with a copy of the main checkout's one, so a
// new worktree has the owner's local data without anyone reaching production. Only local
// folders are read and written: it never runs a remote wrangler command.
// Run from backend/ in a worktree: `npm run db:copy-main`. Stop the main checkout's dev
// server first, so its database isn't being written while it is copied.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const D1 = join('.wrangler', 'state', 'v3', 'd1');

function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// In a worktree the common git dir is the main checkout's .git folder.
const mainRoot = dirname(resolve(git('rev-parse --path-format=absolute --git-common-dir')));
const thisRoot = resolve(git('rev-parse --show-toplevel'));
if (mainRoot.toLowerCase() === thisRoot.toLowerCase()) {
  fail('This is the main checkout: its local database is the one worktrees copy.');
}

const source = join(mainRoot, 'backend', D1);
if (!existsSync(source)) {
  fail(`The main checkout has no local database (${source}). Ask the owner to run db:pull there.`);
}

rmSync(D1, { recursive: true, force: true });
mkdirSync(dirname(D1), { recursive: true });
cpSync(source, D1, { recursive: true });
console.log(`Copied the local database from ${source}`);

// Adds any tables this branch introduced; it only creates what is missing.
console.log('> wrangler d1 execute recipes-db --local --file=schema.sql --yes');
execSync('npx wrangler d1 execute recipes-db --local --file=schema.sql --yes', { stdio: 'inherit' });

console.log('Local database now matches the main checkout.');

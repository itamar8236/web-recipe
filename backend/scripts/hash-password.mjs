// Prints the password hash for a user, and writes the SQL file that inserts the admin user
// with it. Uses the same code the Worker uses to check logins (src/password.js), so the
// hash is accepted by login. Run it on your own machine; nothing here touches a database.
//
//   node scripts/hash-password.mjs <admin-username> <password>
//
// The SQL goes to a file because the hash contains `$`, which shells would mangle inside
// a --command string. .wrangler/ is git-ignored.
import { mkdirSync, writeFileSync } from 'node:fs';
import { hashPassword } from '../src/password.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node scripts/hash-password.mjs <admin-username> <password>');
  process.exit(1);
}

const hash = await hashPassword(password);
const sql = `INSERT INTO users (username, is_admin, password_hash) VALUES ('${username.replaceAll("'", "''")}', 1, '${hash}');\n`;
mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/create-admin.sql', sql);

console.log(`Hash:\n${hash}\n`);
console.log('Wrote .wrangler/create-admin.sql. To create the admin on production, run from backend/:');
console.log('npx wrangler d1 execute recipes-db --remote --file=.wrangler/create-admin.sql');

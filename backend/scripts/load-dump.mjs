// Loads a `wrangler d1 export` dump into the local database (or the one under `persistTo`).
// `wrangler d1 execute` refuses any statement over 100 KB, and a row of recipe_pictures or
// import_pictures holds a picture that, written out as hex, is far bigger. So those rows
// are left out of the file wrangler runs and inserted afterwards with their bytes as bound
// values, through wrangler's local D1.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';

const PICTURE_ROW = /^INSERT INTO "(recipe_pictures|import_pictures)" /;
const HEX = /X'([0-9a-fA-F]*)'/g;

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

export async function loadDump(file, persistTo) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const pictureRows = lines.filter((line) => PICTURE_ROW.test(line));
  const rest = `${file}.without-pictures.sql`;
  writeFileSync(rest, lines.filter((line) => !PICTURE_ROW.test(line)).join('\n'));
  const persistFlag = persistTo ? ` --persist-to="${persistTo}"` : '';
  run(`npx wrangler d1 execute recipes-db --local${persistFlag} --file="${rest}" --yes`);
  if (!pictureRows.length) return;

  console.log(`Inserting ${pictureRows.length} picture rows`);
  const { env, dispose } = await getPlatformProxy({ configPath: './wrangler.jsonc', persist: persistTo ? { path: `${persistTo}/v3` } : true });
  try {
    for (const line of pictureRows) {
      const values = [];
      const sql = line.trim().replace(/;$/, '').replace(HEX, (_, hex) => {
        values.push(Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)));
        return '?';
      });
      await env.DB.prepare(sql).bind(...values).run();
    }
  } finally {
    await dispose();
  }
}

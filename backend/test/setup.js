import { env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
// The real schema, so the tests also check that the code works with its constraints.
import schema from '../schema.sql?raw';

// D1 runs one statement per call, so split the file on ';' at the end of a statement.
// (A trigger body has ';' too, but always followed by END, never by CREATE or the end.)
function statements(sql) {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join(' ');
  return withoutComments
    .split(/;\s*(?=CREATE\b|$)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

beforeAll(async () => {
  for (const statement of statements(schema)) await env.DB.prepare(statement).run();
});

// Every test starts with an empty database.
beforeEach(async () => {
  await env.DB.batch(
    ['llm_requests', 'llm_usage', 'recipes', 'folders', 'sessions', 'users'].map(
      (table) => env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

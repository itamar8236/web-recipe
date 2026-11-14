// Runs real imports through the local app, one link at a time, and prints what came back.
// For checking by hand that imports still work after a site changes its pages or a model
// is swapped. It is not part of `npm test`: it calls the real sites and spends real model
// quota (the dev keys in .dev.vars), so run it only on links the owner gave.
//
// Start the app first (`npm run dev`, from backend/), then give it the links themselves,
// in quotes, and/or files of links:
//   node scripts/e2e-links.mjs "https://www.instagram.com/reel/..." "https://youtu.be/..."
//   node scripts/e2e-links.mjs links.txt [--model default|best] [--only <text>] [--show]
//                              [--base http://localhost:8787] [--out results.json]
//
// A links file has one link per line; other lines are ignored. Imports run on a test
// account made for this script, whose recipes and cards are cleared at the start, so every
// run begins clean. More than 10 links a day need the daily cap raised for the session:
//   npm run dev -- --var IMPORT_DAILY_LIMIT:200

import { readFileSync, writeFileSync } from 'node:fs';

// A test account for the local database only. It is refused anywhere but localhost below.
const TEST_USER = { username: 'e2e-links-test', password: 'local-e2e-only' };
const POLL_MS = 3000;
const GIVE_UP_MS = 25 * 60 * 1000;
const PAUSE_BETWEEN_LINKS_MS = 5000;

function readArgs(argv) {
  const args = { inputs: [], model: 'default', only: null, show: false, base: 'http://localhost:8787', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--show') args.show = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else args.inputs.push(argv[i]);
  }
  return args;
}

const args = readArgs(process.argv.slice(2));
if (!args.inputs.length || !['default', 'best'].includes(args.model)) {
  console.error('Usage: node scripts/e2e-links.mjs <link or links file>... [--model default|best] [--only <text>] [--show] [--base <url>] [--out <file>]');
  process.exit(1);
}
if (!['localhost', '127.0.0.1'].includes(new URL(args.base).hostname)) {
  console.error('This script only runs against the local app.');
  process.exit(1);
}

let cookie = '';

async function api(path, method = 'GET', body) {
  const response = await fetch(args.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function logIn() {
  const login = await api('/api/auth/login', 'POST', TEST_USER);
  if (login.status === 200) return;
  const signUp = await api('/api/auth/register', 'POST', TEST_USER);
  if (signUp.status !== 201) throw new Error(`Could not create the test account: ${signUp.status} ${signUp.data.error}`);
}

async function clearAccount() {
  const { data } = await api('/api/recipes');
  for (const recipe of data.recipes ?? []) await api(`/api/recipes/${recipe.id}`, 'DELETE');
  const cards = await api('/api/imports');
  for (const card of cards.data.imports ?? []) if (card.status !== 'running') await api(`/api/imports/${card.id}`, 'DELETE');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${Math.round(ms / 1000)}s`;

function linkForm(link) {
  const url = new URL(link);
  const path = url.pathname.replace(/[A-Za-z0-9_-]{8,}/g, '…').replace(/\d{5,}/g, '…');
  return url.hostname.replace(/^www\./, '') + path;
}

async function runOne(link) {
  const started = Date.now();
  const start = await api('/api/imports', 'POST', { url: link, ...(args.model === 'best' && { model: 'best' }) });
  if (start.status !== 202 && start.status !== 200) return { link, result: `refused: ${start.data.error}`, time: seconds(Date.now() - started) };

  const { id } = start.data.import;
  const stages = [];
  for (;;) {
    await sleep(POLL_MS);
    const { data } = await api('/api/imports');
    const card = (data.imports ?? []).find((item) => item.id === id);
    if (!card) return { link, result: 'the card went away (dismissed as a duplicate?)', time: seconds(Date.now() - started) };
    if (stages.at(-1) !== card.stage) stages.push(card.stage);
    if (card.status === 'running' && Date.now() - started < GIVE_UP_MS) continue;

    const row = { link, title: card.title, stages: stages.join(' → '), time: seconds(Date.now() - started) };
    if (card.status === 'failed') return { ...row, result: `failed: ${card.error}${card.retryable ? ' (can retry)' : ''}` };
    if (card.status !== 'done') return { ...row, result: 'still running, gave up waiting' };
    const { recipe } = (await api(`/api/recipes/${card.recipeId}`)).data;
    await api(`/api/imports/${id}`, 'DELETE');
    return { ...row, result: 'recipe', storedLink: recipe.link, model: recipe.sourceModel, recipe: { en: recipe.en, he: recipe.he } };
  }
}

function printRecipe({ en, he }) {
  for (const [lang, text] of [['en', en], ['he', he]]) {
    console.log(`\n  [${lang}] ${text.name}`);
    for (const line of text.ingredients) console.log(`    - ${line}`);
    text.steps.forEach((line, i) => console.log(`    ${i + 1}. ${line}`));
  }
}

const isLink = (text) => /^https?:\/\//.test(text);
// Each input is a link, or a file whose lines are read for links.
const links = args.inputs
  .flatMap((input) => (isLink(input) ? [input] : readFileSync(input, 'utf8').split(/\r?\n/)))
  .map((line) => line.trim())
  .filter((line) => isLink(line) && (!args.only || line.includes(args.only)));

await logIn();
await clearAccount();
console.log(`${links.length} link(s), model choice: ${args.model}\n`);

const results = [];
for (const link of links) {
  const result = await runOne(link);
  results.push(result);
  const size = result.recipe ? `, ${result.recipe.en.ingredients.length} ingredients, ${result.recipe.en.steps.length} steps` : '';
  console.log(`${linkForm(link)} | ${result.time} | ${result.result}${result.model ? ` by ${result.model}` : ''}${size} | ${result.stages ?? ''}`);
  if (result.recipe) console.log(`  ${result.recipe.en.name} / ${result.recipe.he.name}`);
  if (result.recipe && args.show) printRecipe(result.recipe);
  if (link !== links.at(-1)) await sleep(PAUSE_BETWEEN_LINKS_MS);
}

if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
const failed = results.filter((result) => result.result !== 'recipe').length;
console.log(`\n${results.length - failed} of ${results.length} gave a recipe.`);

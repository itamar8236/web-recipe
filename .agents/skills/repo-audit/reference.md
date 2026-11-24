# Repo audit: reference

The checklists for the `repo-audit` skill ([`SKILL.md`](SKILL.md)).

## Part A: docs

Every tracked `.md` file: `AGENTS.md`, `CLAUDE.md`, everything in `docs/` (index:
`docs/README.md`), `backend/README.md`, `frontend/README.md`, and every
`.agents/skills/*/*.md`. What belongs in a doc is `AGENTS.md` → Conventions → Docs: a
missing file list, field catalog or config value is never a finding.

**Accuracy** (docs that mislead are the worst kind):
- Every command in `AGENTS.md` → Commands and in skills exists in a `package.json`.
- Every file path and markdown link points to something that exists, and so does every
  doc pointer in a code comment (`grep -rn "docs/\|README" backend/src frontend`).
- What `docs/internals/02_data.md` says about tables and their rules matches
  `backend/schema.sql` and `backend/migrations/`.
- Every route in `backend/src/` is in `docs/internals/01_api.md`, and the reverse. Same
  for the request/response shapes and error codes `frontend/lib/api.js` relies on.
- Every number or name a doc still states (the best model's 5 a day per user, the
  50-user cap, the supported platforms, setting names) matches the code. Model names,
  order and daily limits live only in `backend/wrangler.jsonc`: a doc that copies them is
  a finding.
- Bindings, compatibility flags, secrets and env var names match `wrangler.jsonc` and
  `.dev.vars.example`.
- Every file, screen or component a doc names still exists.
- Each Known bugs / Known gaps line still links to a real section that still describes it.

**Freshness**:
- Code changed recently (step 1) but its doc didn't.
- Overview sections still describe the code as it is.
- TODO, "planned", "for now", "not built yet", "a later feature" text that is now done
  or dead; dated test logs and PR history ("is unchanged", "from an older page"); text
  appended after the old text it contradicts instead of replacing it.

**Coherence**:
- `CLAUDE.md` is still only `@AGENTS.md`; no rules there.
- The same fact in two files (they will drift): keep it in one, link from the other.
- Two docs giving different instructions for the same thing.
- `.claude/skills` link is intact (`AGENTS.md` → Agent setup).

**Size** (what an agent needs, nothing more):
- Too short: a new agent can't find, from the docs alone, where a feature lives, how to
  run and test it, or what it must never do. Any `backend/src` or `frontend/` area no doc
  points to.
- Too long: text an agent could read straight from the code, history of how something
  came to be, finished plans, long examples. Rough limits:
  - `AGENTS.md` (with `CLAUDE.md`, which imports it): under 200 lines. Every session loads
    all of it, and longer files are followed less well (Anthropic's guidance:
    <https://code.claude.com/docs/en/memory>). A fact that matters only to one area
    belongs in that area's docs, not there.
  - A `docs/` page: ~400 lines (split by topic past that). A package README: a few lines
    pointing to `docs/`.
  - A skill: ~80 lines (details in a `reference.md` beside it).
- **Code map**: from any feature in "The product" you reach its docs and files in one hop.

## Part B: architecture and end to end

Read `AGENTS.md` and `docs/` (in `docs/README.md`'s order), then trace each journey through
the real code: frontend → `frontend/lib/api.js` → `backend/src/index.js` → D1 / Workflow
→ LLM → back to the screen.

Journeys:
1. Sign up (50-user cap, two sign-ups at once), log in, stay logged in, log out.
2. Change own username, password or defaults: other devices stay logged in.
3. Admin logs in as a user, then that user is deleted (all their data and sessions gone).
4. Guest mode: nothing reaches D1; imports, AI tools and Browse refused by the backend,
   not just hidden in the UI.
5. Tags and recipes: add, edit, delete, favorite, public/private; a tag no recipe has is
   deleted; renaming onto another tag's name.
6. Recently deleted: delete, restore with tags and picture, the daily purge after 30 days.
7. Import from a link (YouTube, Facebook, Instagram, a web page, a page that blocks the
   Worker): parse → fetch (each hop allowed) → model list → fallback → save with no tags
   → picture step → card on screen. Also: Retry, dismissing the card early, user deleted
   mid-run, admin acting as the user, daily quota used up, video too long or unreachable.
8. Import from a photo: upload, best model first, the picture copy, Retry within and
   after 48 hours, the original deleted when the import ends.
9. Scan the link again, with and without the best model (5 a day, every try counts,
   goes on with the usual models by itself); a picture the user chose is kept.
10. AI tools: translate, calories, substitute; what they save, and both languages present
    at the end of every path that writes a recipe.
11. Browse: random order and paging, sorting, copying with and without tags and picture.
12. Share to the app (Android): logged in, logged out, guest.

Cross-cutting checks:
- **Frontend-backend contract**: field names, types, error shapes and status codes the
  UI expects vs what the Worker sends.
- **Data integrity**: fields dropped between stages, schema vs queries, migrations not
  yet applied on production while code already uses them.
- **Silent failures**: caught errors that leave the user with a spinner, empty result or
  wrong data and no message.
- **Security**: every `/api/*` route checks login (only sign-up, login, logout are
  public), every admin action checks admin, every query is scoped to the user, SQL is
  parameterized, every fetched URL is guarded, no secret reaches the frontend or logs.
- **Config**: PR previews share the production DB and Workflow; nothing a preview or test
  does should write real data.
- **Tests**: the journeys above that no test covers.

## Part C: agent workflow

Review how agents and humans actually work here (dev, tests, branches, PRs, deploys)
against `AGENTS.md`, the skills, and common practice. Report **bad practice** and
**non-standard setups**, each with `file:line`, why it matters, and a fix. A deliberate,
documented choice is Info at most, and an accepted one is not a finding (accepted so far:
no CI, a PR may be merged with no review, no login rate limit, migrations not tracked).

- **Safety rails**: `.claude/settings.json` deny rules vs "Never do these". Look for
  bypasses (force-push variants, secrets readable another way, wrangler commands that
  would work if wrangler were logged in). GitHub's `main` ruleset still active
  (`gh api repos/{owner}/{repo}/rulesets`). Rules that exist only as prose where a hook or
  deny rule could enforce them.
- **Quality gates**: lint and tests exist for both apps and pass; the journeys' coverage.
- **Dev and test loop**: commands in `AGENTS.md` and `local-dev` work on a fresh worktree
  (`npm ci`, db setup, build before backend dev); tests never touch production; local DB
  and secrets handled safely (`.worktreeinclude`, `.dev.vars`).
- **Git workflow**: commits and PR titles really Conventional (`git log`), PRs near the
  ~400-line target, one task per worktree, stale worktrees and branches, direct pushes
  to `main`.
- **Deploy and migrations**: production deploy only by merge; schema changes have a
  documented migration step with its order relative to the merge; previews write no real
  data.
- **Dependencies**: lockfiles committed, `npm ci` in automation, `npm audit`, install hooks
  and scripts that run code automatically (`SessionStart`) are safe and limited.
- **Agent setup**: skills short and non-overlapping, descriptions trigger correctly,
  `disable-model-invocation` where an action is risky or costly, allow-lists in committed
  settings narrow, personal settings git-ignored, rules in one place (`AGENTS.md`).
- **Anything else** out of the ordinary for a small Cloudflare + Next.js repo.

## Report format

```markdown
# Repo audit YYYY-MM-DD
> Commit / mode / previous audit date or "none" / npm audit result
## Summary            (count per severity, for docs, architecture and workflow)
## Owner decisions    (left empty: the owner fills it in)
## Since last audit   (resolved / still open / new)
## Critical
## Warning / High
## Info / Medium
## Workflow review    (part C: bad practices and non-standard setups, ranked)
## Proposed lines for Known bugs and accepted trade-offs
## Refuted by verification
## Next steps         (numbered, each small enough to be one PR)
```

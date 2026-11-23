# Local dev: reference

Details for the `local-dev` skill ([`SKILL.md`](SKILL.md)).

## Ports
**:8787 and :3000 are the owner's**: they test PRs there. Agents never start a server on
them, even when they look free. Several agents may run at once, so each takes the first
free port in its range:

| Server | Agents use |
|---|---|
| Worker (`wrangler dev`) | 8788-8799 |
| `next dev` | 3001-3009 |

- Check before starting: `netstat -ano | grep -E ":<port> .*LISTEN"` (Git Bash) must print
  nothing. On Windows a second server can bind a port that is already taken without any
  error, and the browser then reaches whichever one it likes, so never rely on the start
  failing.
- `wrangler dev` also opens an inspector port (9229 and up); it picks a free one by itself.
- Claude desktop app: `preview_start` runs entries from `.claude/launch.json`, which is
  git-excluded (each checkout has its own). Add an entry for your port there, e.g.
  `{"name": "backend-8790", "runtimeExecutable": "npx", "runtimeArgs": ["--prefix",
  "backend", "wrangler", "dev", "--cwd", "backend", "--port", "8790"], "port": 8790}`,
  and never start the `backend` / `frontend` entries, which use the owner's ports.
- A server on one of the owner's ports that you didn't start belongs to them or to
  another session: leave it alone and tell the owner if it is in the way.

## Local data
The local DB is yours to test with: add, edit, or delete anything. Only the owner's
`npm run db:pull` resets it. Recipes' pictures are rows of it (`recipe_pictures`), so they
come along with `db:pull` and `db:copy-main`. The Images binding (which resizes a link
import's picture) runs offline in `wrangler dev` and the tests, with nothing to set up.
Local queries: `npx wrangler d1 execute recipes-db --local --command="SELECT ..."`.
`.dev.vars` holds the owner's dev keys, which use a test quota, not production's.

## PR previews share the production database
Workers Builds runs `wrangler preview` for PR branches, and previews use the same D1
binding, i.e. **production** (accepted: `AGENTS.md` → Known bugs and accepted trade-offs).
It matters only if a PR would change production data during the build or deploy itself (a
build step, deploy script or startup code that writes to the database without anyone
using the preview). Flag that in the PR if your change does it.

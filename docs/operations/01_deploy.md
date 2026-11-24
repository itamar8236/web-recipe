# Deploy, previews and logs

Production is deployed **only by merging a PR into `main`**. Agents never deploy
(`AGENTS.md` → Never do these).

## Workers Builds

Cloudflare Workers Builds is connected to the GitHub repo (root directory `/`). Every build
runs `cd frontend && npm install && npm run build`, then:

- on `main`: `cd backend && npm install && npx wrangler deploy` (production);
- on other branches and PRs: `cd backend && npm install && npx wrangler preview`, a Worker
  Preview that doesn't replace production.

Schema changes are not deployed: the owner applies them ([Database runbook](./00_database.md)).

## PR previews

Previews don't inherit the production Worker's bindings, secrets or `observability`, so the
`previews` block in `wrangler.jsonc` repeats the bindings (D1, Images, Workflow) and `vars`;
without it every query fails.

- **Previews use the production database.** Accepted for now: nobody else gets the preview
  links, and a separate preview database may come later. It matters only if a PR would write
  production data during the build or deploy itself (`local-dev` skill → PR previews).
- **Nothing that calls a model works on a preview**: it has no `GEMINI_API_KEY` (giving it
  one would let any preview spend production's quota), and its Workflow binding uses the
  import Workflow already deployed to production (`workflow.not_found` before the first
  deploy). A photo import fails at once with `photo_upload_failed`, a link import or an AI
  tool with a model error. Test those locally or after the merge; on a preview, test only
  what needs no model.
- A preview keeps no logs (its Observability page stays empty).

## Logs

Production keeps Workers Logs for 3 days (`observability` in `wrangler.jsonc`); `npx wrangler
tail` (owner, logged in) shows them live. What is logged: [Models → Logging](../internals/05_models.md#logging).
A failed import also keeps its reason in `llm_requests.error_detail`.

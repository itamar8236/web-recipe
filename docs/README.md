# web-recipe docs

What the product does, the rules for working here and the commands are in the root
[`AGENTS.md`](../AGENTS.md). These docs keep what the code alone doesn't show: decisions
and their reasons, rules that span files, traps, the HTTP contract between the two apps,
and the known gaps the owner accepted. Follow `AGENTS.md` → Conventions → Docs before
adding anything.

## Internals (in reading order)

- [00 · Architecture](./internals/00_architecture.md): one Worker, one origin, who owns what
- [01 · HTTP API](./internals/01_api.md): every endpoint, its shapes and error codes
- [02 · Data](./internals/02_data.md): tables, ownership, Recently deleted, schema changes
- [03 · Login, admin and guests](./internals/03_auth.md)
- [04 · Import](./internals/04_import.md): links, web pages, Facebook/Instagram, photos, failures
- [05 · Models and quota](./internals/05_models.md): which model runs, limits, busy models
- [06 · AI tools](./internals/06_ai-tools.md): translate, calories, ingredient substitutes
- [07 · Pictures](./internals/07_pictures.md)
- [08 · Web UI](./internals/08_web-ui.md): data layer, screens' rules, Share, Hebrew/RTL

Every internals page but Architecture and the API ends with its **Known gaps and accepted
trade-offs**: read them before changing that area, and never "fix" one without asking the
owner.

## Runbooks

How to run and test locally is the `local-dev` skill (`.agents/skills/local-dev/`).

- [00 · Database (owner)](./operations/00_database.md): refreshing local data, migrations, production schema
- [01 · Deploy, previews and logs](./operations/01_deploy.md)

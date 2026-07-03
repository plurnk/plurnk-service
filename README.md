# plurnk-service

> Plurnk is in early-alpha public testing — see https://status.plurnk.ai for current status.

LLM agent runtime engine. Consumes [plurnk-grammar](https://github.com/plurnk/plurnk-grammar); exposes WebSocket JSON-RPC. User-facing CLI: [plurnk](https://github.com/plurnk/plurnk). Provider-agnostic, MIT — no vendor or model lock-in.

## What an agent can do

Grammar ops: `PLAN` reason · `READ`/`EDIT` files · `FIND` search · `EXEC` run shell/code · `SEND` message or conclude · `COPY`/`MOVE`/`KILL` manage · `OPEN`/`FOLD` curate its own context.

Over schemes: `file://` project files · `exec://` command output · `http(s)://` web fetch · `run://` sibling agent runs (spawn / fork / message) · `known://` scratch · `log://` own history.

## Loop model

Session = the shared world (one filesystem + membership overlay). Run = one agent's private log. Loop = one `prompt → ops → SEND[terminal]` cycle; every turn leads with `PLAN`. Runs fork and message each other — many clients, many runs, one session.

## Integration (WebSocket JSON-RPC)

Methods: `session.*` (create / attach / constrain / list…) · `loop.run` / `loop.inject` / `loop.resolve` · `op.*` (read / edit / find / exec / send…) · `log.read` · `run.fork`. Streams: `log/entry` → … → `loop/terminated`, plus `loop/proposal`, `telemetry/event`. Full live catalog: the `discover` RPC.

```
ws connect → session.create({ projectRoot }) → loop.run({ prompt })
           → read log/entry notifications until loop/terminated
```

The human CLI over this surface is [plurnk](https://github.com/plurnk/plurnk).

## Run

```
npm install -g @plurnk/plurnk-service
plurnk-service start      # daemon (`migrate` initializes the DB)
```

Config + state live in `~/.plurnk/` (created on first run): put your config in `~/.plurnk/.env` (yours, seeded once); the DB defaults to `~/.plurnk/plurnk.db`. Provider-agnostic — point `PLURNK_MODEL` at any vendor. **[`INSTALL.md`](./INSTALL.md) is the config guide** — the cascade, the prefix taxonomy, the coupling matrix, and profiles for common deployments; `.env.example` is the terse machine floor it breaks down. Also exports `{ Engine, Daemon, SchemeRegistry }` for in-process embedding.

## Contract & siblings

- [`SPEC.md`](./SPEC.md) — canonical specification. One `§<tag>` namespace; anchors `{§<tag>}` bind 1:1 to `test/intg/spec-anchors.test.ts`.
- [plurnk-providers](https://github.com/plurnk/plurnk-providers) §provider · [plurnk-schemes](https://github.com/plurnk/plurnk-schemes) §scheme-surface · [plurnk-mimetypes](https://github.com/plurnk/plurnk-mimetypes) §mimetype-surface · [plurnk-execs](https://github.com/plurnk/plurnk-execs) §bundled-set.

## Semantic search

`FIND`'s `~query` ranks semantically via an optional embedder peer, `@plurnk/plurnk-mimetypes-embeddings` (heavy native deps; not installed by default). Absent → `~query` falls back to FTS keyword ranking and `start` prints an `embedder inactive` notice. Enable vector search: `npm i @plurnk/plurnk-mimetypes-embeddings`.

## Tests

`test:lint`, `test:unit`, `test:intg`, `test:live`, `test:demo`; off-hot-path `test:installation`.

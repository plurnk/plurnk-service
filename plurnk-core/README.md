# plurnk-service

The PLURNK daemon: persistent agent state, model loops, packet assembly, and
operation dispatch. Its client surface is AG-UI over HTTP/SSE through
`@plurnk/plurnk-agui`. The user-facing CLI lives in
[plurnk](https://github.com/plurnk/plurnk).

## What an agent can do

Grammar ops: `PLAN` goals · `READ`/`EDIT` files · `FIND` search · `EXEC` run shell/code · `SEND` message or conclude · `COPY`/`MOVE`/`KILL` manage · `OPEN`/`FOLD` curate its own context.

Over schemes: `file://` project files · `exec://` command output · `http(s)://` web fetch · `worker://` scratch + sibling agent runs (commons/own-space/spawn/fork/message) · `prompt://` the task frame · `skill://` bundled reference · `log://` own history.

## Loop model

Workspace = the shared world (one filesystem + membership overlay). Run = one agent's private log. Loop = one `prompt → ops → SEND[terminal]` cycle; every turn leads with `PLAN`. Runs fork and message each other — many clients, many runs, one workspace.

## Integration

Clients use AG-UI management actions and run streams exposed by
`@plurnk/plurnk-agui`. Core supplies an in-process daemon seam; it does not open
a second client transport.

## Run

```
npm install -g @plurnk/plurnk-service
plurnk-service start      # daemon (`migrate` initializes the DB)
```

Config + state live in `~/.plurnk/` (created on first run): put your config in `~/.plurnk/.env` (yours, seeded once); the DB defaults to `~/.plurnk/plurnk.db`. Provider-agnostic — point `PLURNK_MODEL` at any vendor. **[`INSTALL.md`](./INSTALL.md) is the config guide** — the cascade, the prefix taxonomy, the coupling matrix, and profiles for common deployments; `.env.defaults` is the terse machine floor it breaks down (per-package, assembled at boot). Also exports `{ Engine, Daemon, SchemeRegistry }` for in-process embedding.

## Contract & siblings

- [`SPEC.md`](./SPEC.md) — detailed behavioral reference.
- `@plurnk/plurnk-providers` — model endpoint contract.
- `@plurnk/plurnk-schemes` — addressable resource contract.
- `@plurnk/plurnk-mimetypes` — content handling contract.
- `@plurnk/plurnk-execs` — executable capability contract.

## Semantic search

`FIND`'s `~query` ranks semantically via an optional embedder peer, `@plurnk/plurnk-mimetypes-embeddings` (heavy native deps; not installed by default). Absent → `~query` falls back to FTS keyword ranking and `start` prints an `embedder inactive` notice. Enable vector search: `npm i @plurnk/plurnk-mimetypes-embeddings`.

## The file sandbox

Plurnk sees what git sees. The model's file surface is defined by three external grantors — your explicit client adds, your git's own inclusion rules (tracked plus untracked-not-ignored, minus ignored), and the AGENTS.md policy knob — and by nothing else: a file inside the project that none of these admit does not exist for the model, and your gitignored secrets can be neither read nor overwritten. Writes are narrower still: create-only inside the project (and only where the result will be visible), proposal-gated edits on members, read-only beyond the root unless you explicitly grant otherwise. The shell (EXEC) deliberately reaches beyond this sandbox — gate it accordingly; it is your machine's perimeter, not the grammar's. Details: SPEC §scheme-address ({§fs-namespace} through {§fs-world-state}).

## Tests

Run the root monorepo commands for deterministic lint, unit, and integration
coverage. Live-model, demo, and installation tests declare their external
requirements separately.

For manual client/service drills, create the modest standalone project used by
the demos instead of digesting this monorepo:

```sh
npm run fixture:demo -w plurnk-core -- <label>
```

The command prints the temporary project path. The caller removes it when done.

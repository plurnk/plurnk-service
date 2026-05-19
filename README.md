# plurnk-service

Engine library + admin CLI + daemon for the plurnk agent runtime. Speaks the [plurnk-grammar](https://github.com/plurnk/plurnk-grammar) contract; exposes a [WebSocket JSON-RPC surface](./SPEC.md#13) for clients (the user-facing CLI/TUI lives in [`plurnk`](https://github.com/plurnk/plurnk)).

## Quick start

```sh
git clone github.com/plurnk/plurnk-service
cd plurnk-service
npm install
./bin/plurnk-service.js              # boots daemon on ws://127.0.0.1:3044
```

`.env.example` ships with sane defaults; the daemon auto-loads it. Override per-deployment in `.env` or via `--config=<path>`. Run `./bin/plurnk-service.js --help` for the flag surface.

To talk to a real model, set in `.env`:

```
PLURNK_MODEL_<alias>=<provider>/<model-id>
PLURNK_MODEL=<alias>
OPENAI_BASE_URL=<endpoint>           # for openai-family aliases
```

Then `npm run test:live` for the end-to-end smoke against your configured model.

## Architecture

- [`SPEC.md`](./SPEC.md) — engine surface, RPC contract, packet shape, op semantics. 15 numbered sections; promise anchors `{§<id>}` link to tests.
- [`MIMETYPES.md`](./MIMETYPES.md) — contract for `@plurnk/plurnk-mimetypes-*` packages.
- [`PROVIDERS.md`](./PROVIDERS.md) — contract for `@plurnk/plurnk-providers-*` packages.
- [`SCHEMES.md`](./SCHEMES.md) — contract for `@plurnk/plurnk-schemes-*` packages.
- [`AGENTS.md`](./AGENTS.md) — collaboration memory for agents working on this repo (gitignored; see SPEC for canonical state).

## Tests

```sh
npm run test:lint        # tsc --noEmit
npm run test:intg        # integration tests (mock provider, real SQLite)
npm run test:live        # live tests (real provider; requires PLURNK_MODEL)
npm run test:demo        # demo tests (natural prompts; outcome assertions)
```

Four tiers per SPEC §0.7. Cadence:

- **lint** — every commit (CI enforces).
- **intg** — every commit (CI enforces). Mock provider, real in-memory SQLite. Fast (~2s).
- **live** — before merging significant engine changes. Real provider, structural prompts, wire-level assertions. Catches protocol drift and validates rail behavior against actual model failure modes. ~30–80s per test against gemma.
- **demo** — periodic. Real provider, natural human-style prompts, outcome assertions. Validates the model + sysprompt + grammar trio. Failures indict the trio, not the engine. ~25s per test.

CI runs lint + intg. live + demo are run locally with real provider config.

## License

MIT.

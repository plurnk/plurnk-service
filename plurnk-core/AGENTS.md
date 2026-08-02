# plurnk-core

`plurnk-core` is the daemon implementation published as
`@plurnk/plurnk-service`.

Read the repository `AGENTS.md` and `ARCHITECTURE.md` first. `SPEC.md` defines
this package's public behavior.

## Responsibilities

Core owns:

- daemon startup and shutdown;
- SQLite persistence and schema initialization;
- workspaces, workers, loops, turns, and log entries;
- packet assembly and model-loop orchestration;
- operation dispatch and proposal lifecycle;
- the internal API used by `plurnk-agui`.

Core does not own provider transports, content-type behavior, external
executors, or client rendering. Add those capabilities to the appropriate
plugin or client package and keep the core integration seam small.

## Development

Run package checks from the repository root or with npm's workspace flag:

```sh
npm run test:lint -w @plurnk/plurnk-service
npm run test:unit -w @plurnk/plurnk-service
npm run test:intg -w @plurnk/plurnk-service
```

`npm start -w @plurnk/plurnk-service -- start` executes TypeScript source.
The published `plurnk-service` binary executes `dist`, so build before testing
the binary:

```sh
npm run build -w @plurnk/plurnk-service
```

Integration tests use temporary databases and project roots. Clean up temporary
resources in `finally` blocks or test hooks.

## Boundaries

- Follow the repository's **No Migrations Yet** baseline rule for every SQLite
  shape change; do not infer upgrade compatibility from SqlRite's terminology.
- Put shared wire and model-language shapes in `plurnk-contracts`, and
  persistence-only types in core.
- Keep AG-UI transport and event translation in `plurnk-agui`.
- Validate external input once at its owning boundary.
- Test lifecycle changes through a complete loop, including terminal and
  failure states.
- Test proposal changes in manual client-decision and automatic loop modes.

Prefer direct, conventional implementations. Historical issue decisions and
architectural analogies are not constraints; current schemas, tests, and public
contracts are.

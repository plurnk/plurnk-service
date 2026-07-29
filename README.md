# PLURNK

PLURNK is an experimental runtime for software-development agents. It combines
a model-facing operation language, addressable project context, persistent
execution state, and thin clients over a single daemon.

The project is under active stabilization. It is suitable for development and
dogfooding, but it does not yet promise a stable public API or production
reliability.

## Why PLURNK

PLURNK is exploring three core ideas:

- models should act through a small compositional language rather than a large
  collection of unrelated tool schemas;
- project context and execution results should have durable addresses;
- agent work should be persisted and recoverable instead of living only in a
  client process.

Everything else is implementation and may change as those ideas are tested.

## Architecture

```text
CLI / TUI / editor
        |
        | AG-UI over HTTP/SSE
        v
   plurnk-agui
        |
        v
   plurnk-core ---- SQLite
     /  |  \
providers schemes executors
          |
      mimetypes
```

The daemon owns state, model turns, operation dispatch, and recovery. Clients
submit actions and render events. Plugins adapt model providers, addressable
resources, executable capabilities, and content formats.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and request flow.

## Requirements

- Node.js 26 or newer
- npm
- Git
- a configured local or remote model endpoint for live runs

## Develop

```sh
git clone https://github.com/plurnk/plurnk-service.git
cd plurnk-service
npm ci
npm run build
npm run test:lint
npm run test:unit
```

Deterministic integration tests are separate:

```sh
npm run test:intg
```

To launch a source-built daemon and the outside `plurnk` client as one
reproducible candidate:

```sh
PLURNK_CANDIDATE_MODEL=<configured-alias> npm run candidate -- <client arguments>
```

By default the launcher expects the client checkout at `../repo/plurnk`. Set
`PLURNK_CLIENT_CHECKOUT` to use another checkout. It builds both projects,
creates an isolated database, reports their provenance, and preserves a digest
under `PLURNK_BENCHMARKS`. Repeated experiment harnesses may build both
checkouts once, then set `PLURNK_CANDIDATE_SKIP_BUILD=1` for the frozen build.

## Packages

| Area | Packages |
| --- | --- |
| Daemon and client protocol | `plurnk-core`, `plurnk-agui` |
| Shared runtime contracts | `plurnk-contracts` |
| Model language | `plurnk-grammar`, `gbnf` |
| Model endpoints | `plurnk-providers*`, `plurnk-models`, `plurnk-aliases` |
| Addressable resources | `plurnk-schemes*` |
| Executable capabilities | `plurnk-execs*` |
| Content handling | `plurnk-mimetypes*` |

This repository is an npm workspace monorepo. One lockfile and the root
commands are authoritative for bundled packages.

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md). Please report security issues
using [SECURITY.md](./SECURITY.md), not a public issue.

## License

[MIT](./LICENSE)

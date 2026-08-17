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

```mermaid
flowchart LR
    clients["CLI / TUI / Neovim / web"] <--> agui["AG-UI"]
    agui <--> core["plurnk-service<br/>engine + durable state"]
    core <--> providers["Model providers"]
    plugins["Scheme / executor / mimetype plugins"] --> core
    modules["Optional daemon modules"] --> core
    project["Project files + Git"] <--> core
    core --> sqlite[(SQLite)]
```

The daemon owns durable agent state and composes package-owned capabilities.
Clients submit actions and render events; plugins run in-process but retain
their own contracts.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the package map, process boundaries,
and request flow.

## Requirements

- Node.js 26 or newer
- npm
- Git
- a configured local or remote model endpoint for live runs

## Recommended web setup

PLURNK owns no web search runtime. Discovery is an ordinary MCP concern: attach
any search-capable MCP server (Brave Search's official
[`@brave/brave-search-mcp-server`](https://github.com/brave/brave-search-mcp-server)
is a documented demo fixture) and its tools participate exactly like every
other MCP tool — admission, read-effect classification, and packet projection
are identical. See [`@plurnk/plurnk-mcp`](./plurnk-mcp/README.md) for the
service-owned attachment contract and the [HTTP scheme](./plurnk-schemes-http/README.md)
for page materialization; the optional `@plurnk/plurnk-schemes-http-tavily`
showcase plugin supplies Tavily Extract for eligible public HTML.

## Lifecycle hooks

PLURNK can deliver selected core events to one exact local command as JSON on
stdin. Configure `PLURNK_HOOKS_COMMAND`, JSON `PLURNK_HOOKS_ARGS`, and the
explicit `PLURNK_HOOKS_EVENTS` selection; no shell command is interpreted.
See [`@plurnk/plurnk-hooks`](./plurnk-hooks/README.md) for the event inventory
and a copy-pasteable test hook.

## Develop

[PossumTech Gitea](https://repo.possumtech.com/plurnk/plurnk-service) is the
canonical maintainer-development forge. [GitHub](https://github.com/plurnk/plurnk-service)
is the public downstream source, external-contribution, security-reporting, and
historical surface.

```sh
git clone https://github.com/plurnk/plurnk-service.git
cd plurnk-service
npm ci
npm test
```

Long-running drills remain explicit as `npm run test:live` and `npm run test:demo`;
use `npm run config:list` for a value-free configuration inventory.

To launch a source-built daemon and the outside `plurnk` client as one
reproducible candidate:

```sh
PLURNK_CLIENT_CHECKOUT=/path/to/open-client \
PLURNK_CANDIDATE_MODEL=<configured-alias> npm run candidate -- <client arguments>
```

`PLURNK_CLIENT_CHECKOUT` explicitly names the outside client checkout; the
launcher never guesses one from the service's parent directory. It builds both
projects, creates an isolated database, reports their provenance, and preserves
a digest in the shared `../benchmarks` tree unless `PLURNK_BENCHMARKS` selects
another path. Repeated experiment harnesses may build both checkouts once, then
set `PLURNK_CANDIDATE_SKIP_BUILD=1` for the frozen build.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for hooks, test tiers, and maintenance.

## Packages

This repository is an npm workspace monorepo. Each workspace publishes under
its own package contract; the root owns orchestration, one lockfile, and the
cross-package gates. The complete package-to-SPEC map lives in
[ARCHITECTURE.md](./ARCHITECTURE.md#package-ownership).

[`plurnk-contracts/plurnk.md`](./plurnk-contracts/plurnk.md) is the freshly
reviewed model-facing canon. Its owning
[`SPEC.md`](./plurnk-contracts/SPEC.md) distinguishes that narrow teaching from
the tolerant parser and runtime-neutral wire contracts.

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md). Please report security issues
using [SECURITY.md](./SECURITY.md), not a public issue.

## License

[MIT](./LICENSE)

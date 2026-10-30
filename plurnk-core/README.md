# plurnk-service

The PLURNK daemon: persistent agent state, model loops, packet assembly, and
operation dispatch. Its client surface is ACP v2 over Streamable HTTP and WebSocket through
`@plurnk/plurnk-acp`. The user-facing CLI lives in
[plurnk](https://github.com/plurnk/plurnk).

See [installation and configuration](INSTALL.md), including the packaged
[manual and shell completions](INSTALL.md#manual-and-shell-completions).

## What an agent can do

The exact model-facing language and operation set are owned by
[`plurnk.md`](https://github.com/plurnk/plurnk-service/blob/main/plurnk-contracts/plurnk.md). In brief, an agent can:

- inspect and modify admitted project files and durable session entries;
- search lexical, structural, and graph indexes;
- run registered executors and observe their runtime-named streams;
- delegate to sessions, communicate, and collect their results; and
- curate its addressable log with scoped or whole-item `KILL` operations.

## Lifecycle model

Workspace = shared resources, configuration, and an optional project folder. Session = one actor and its history within a workspace. Loop = one queued-to-terminal unit of work within a session. Turns continue until messages are answered, results observed, and held work settled; WAIT yields while work remains. NOTE retains working memory independently of lifecycle. Sessions fork and message each other — many clients, many sessions, one workspace.

## Integration

Clients use ACP v2 session methods, notifications, and `_plurnk/action` management actions exposed by
`@plurnk/plurnk-acp`. Core supplies an in-process daemon seam; it does not open
a second client transport.

`models.list` locally lists catalog routes, configuration readiness, and each
route's accepted `capabilities.efforts`. The `thought_level` session config option (`readSessionEffort`)
reports the choices shared by a session's selected model and spawn override.

## Start

```sh
npm install -g @plurnk/plurnk-service
plurnk-service migrate    # apply pending database upgrades, preserving existing data
plurnk-service start      # daemon
plurnk-service stop       # stop the running daemon and wait for it to exit
```

Configuration follows XDG at `$XDG_CONFIG_HOME/plurnk` (normally
`~/.config/plurnk`); durable data defaults to `$XDG_DATA_HOME/plurnk` (normally
`~/.local/share/plurnk`). First start seeds the user-owned `.env` and
`AGENTS.md` once. Select an exact route with
`PLURNK_MODEL=<provider>/<model-id>`, or declare a reusable/tuned
`PLURNK_MODEL_<alias>=<provider>/<model-id>` and select its alias. Run
`plurnk-service config defaults` for
the complete installed option catalog and `plurnk-service config check` to
validate without contacting a provider. **[`INSTALL.md`](./INSTALL.md) is the
configuration guide.**

Protect durable history with a [consistent database backup](./INSTALL.md#backup-and-restore).
The `share` command exports diagnostic reports, not a restorable database.

Clients use ACP; extension authors use the owning framework packages.
Programmatic forensic use imports [`@plurnk/plurnk-digest`](../plurnk-digest/README.md)
with the canonical reader from `@plurnk/plurnk-service/evidence`.
The digest requires a new or empty output directory, separate from its input
database. Existing output and overlapping input/output paths are refused.

## Contract & siblings

- [`SPEC.md`](./SPEC.md) — detailed behavioral reference.
- `@plurnk/plurnk-providers` — model endpoint contract.
- `@plurnk/plurnk-schemes` — addressable resource contract.
- `@plurnk/plurnk-mimetypes` — content handling contract.
- `@plurnk/plurnk-execs` — executable capability contract.
- `@plurnk/plurnk-hooks` — selected lifecycle events delivered to exact commands.
- `@plurnk/plurnk-otel` — the OpenTelemetry trace and metric providers `OTEL_*` selects.

## Observability

The daemon can emit OpenTelemetry traces and low-cardinality metrics through the standard `OTEL_*` environment, registered by the `@plurnk/plurnk-otel` module of the default installation ({§observability-boundary}, {§otel-module}): `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` select `otlp` or `console` per signal, `OTEL_SERVICE_NAME` names the service, and `OTEL_SDK_DISABLED` opts out. Unconfigured, the daemon never loads the SDK. The boundary observes lifecycle (workspace, loop, turn, provider, parse, dispatch, proposal, stream, digest) without ever recording prompts, reasoning, file bodies, URLs, secrets, or extension payloads.

## Full-text search

`FIND`'s `~query` uses native SQLite FTS5: words, quoted phrases, prefixes, Boolean expressions, and proximity queries, ranked by BM25. It searches the same readable content as READ, returns source coordinates, and uses ordinary integer result paging. No inference endpoint, model artifact, or extra search package is required.

## What the model can see

Plurnk sees what Git tracks or a `members` definition includes. The AGENTS.md policy path is injected separately as privileged policy, not as a file entry. A path admitted by neither source does not exist to the model and cannot be overwritten. Accepted creation is exclusive and never orphaned: it is Git-added or receives an inspectable exact pick. Creation defaults to `project_root`, can be disabled or expanded to the canonical namespace by operator policy, and only an explicit pick overrides Git ignore. Member edits remain proposal-gated; an outside-root member is read-only unless a pick grants it. This is a membership list, not a perimeter: an execution deliberately reaches past it, so its proposal policy — not the file surface — is where consent is asked. Details: SPEC {§scheme-address} ({§fs-namespace} through {§test-artifact-retention}).

## Tests

Run the root monorepo commands for deterministic lint, unit, and integration
coverage. `npm run test:live` runs the real-model smoke; the full `live` and
`demo` specimen corpora live in `plurnk-bench/tiers/`.

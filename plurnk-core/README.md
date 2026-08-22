# plurnk-service

The PLURNK daemon: persistent agent state, model loops, packet assembly, and
operation dispatch. Its client surface is AG-UI over HTTP/SSE through
`@plurnk/plurnk-agui`. The user-facing CLI lives in
[plurnk](https://github.com/plurnk/plurnk).

## What an agent can do

The exact model-facing language and operation set are owned by
[`plurnk.md`](https://github.com/plurnk/plurnk-service/blob/main/plurnk-contracts/plurnk.md). In brief, an agent can:

- inspect and modify admitted project files and durable worker entries;
- search lexical, structural, graph, and embedding-derived indexes;
- run registered executors and observe their runtime-named streams;
- delegate to workers, communicate, and collect their results; and
- curate its addressable log with tagged `FOLD`, `OPEN`, and `KILL` operations.

## Lifecycle model

Workspace = the shared world (one filesystem + membership overlay). Worker = one actor and its private history over that world. Loop = one queued-to-terminal unit of work within a worker; each loop contains turns, and every model turn leads with `PLAN`. Workers fork and message each other — many clients, many workers, one workspace.

## Integration

Clients use AG-UI management actions and AG-UI Run streams exposed by
`@plurnk/plurnk-agui`. Core supplies an in-process daemon seam; it does not open
a second client transport.

## Start

```sh
npm install -g @plurnk/plurnk-service
plurnk-service migrate    # apply the disposable version-1 schema baseline
plurnk-service start      # daemon
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
configuration guide.** A legacy mixed `~/.plurnk` is moved only by the explicit
`plurnk-service paths migrate` command.

The 1.x package retains its frozen root library barrel for SemVer compatibility;
it is not the client boundary and gains no new APIs. Programmatic forensic use
imports `@plurnk/plurnk-service/digest`.

## Contract & siblings

- [`SPEC.md`](./SPEC.md) — detailed behavioral reference.
- `@plurnk/plurnk-providers` — model endpoint contract.
- `@plurnk/plurnk-schemes` — addressable resource contract.
- `@plurnk/plurnk-mimetypes` — content handling contract.
- `@plurnk/plurnk-execs` — executable capability contract.
- `@plurnk/plurnk-hooks` — selected lifecycle events delivered to exact commands.

## Observability

The daemon can emit OpenTelemetry traces and low-cardinality metrics through the standard `OTEL_*` environment ({§observability-boundary}): `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` select `otlp` or `console` per signal, `OTEL_SERVICE_NAME` names the service, and `OTEL_SDK_DISABLED` opts out. Unconfigured, the daemon never loads the SDK. The boundary observes lifecycle (workspace, loop, turn, provider, parse, dispatch, proposal, stream, digest) without ever recording prompts, reasoning, file bodies, URLs, secrets, or plugin payloads.

## Semantic search

The default service installation includes `@plurnk/plurnk-mimetypes-embeddings`, so `FIND`'s `~query` uses embedding cosine ranking without a separate package install. `PLURNK_SERVICE_EMBED_DISABLE=1` explicitly selects FTS keyword ranking; a missing required artifact is a broken installation and refuses startup. A remote OpenAI-compatible embedder can replace the included local path; see [`INSTALL.md`](./INSTALL.md).

## The file sandbox

Plurnk sees what Git or an ordinary `pick` admits. The AGENTS.md policy path is injected separately as privileged policy, not as a file entry. A path admitted by neither source does not exist to the model and cannot be overwritten. Accepted creation is exclusive and never orphaned: it is Git-added or receives an inspectable exact pick. Creation defaults to `project_root`, can be disabled or expanded to the canonical namespace by operator policy, and only an explicit pick overrides Git ignore. Member edits remain proposal-gated; an outside-root member is read-only unless a pick grants it. `EXEC` deliberately reaches beyond this file sandbox, so its proposal policy is the machine perimeter. Details: SPEC {§scheme-address} ({§fs-namespace} through {§fs-world-state}).

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

# @plurnk/plurnk-service

The PLURNK daemon: persistent SQLite state, model loops, packet assembly, and operation dispatch.

- **Interactive CLI, Term & installer:** [`@plurnk/plurnk`](https://github.com/plurnk/plurnk) (`plurnk`; browser UI at `http://127.0.0.1:1066/`).
- **Configuration, systemd, nginx & backups:** [`INSTALL.md`](INSTALL.md) (including [man page & completions](INSTALL.md#manual-and-shell-completions)).
- **Session operating card & wire tool:** [`plurnk.md`](https://github.com/plurnk/plurnk-service/blob/main/plurnk-contracts/plurnk.md) · [`@plurnk/plurnk-contracts`](https://github.com/plurnk/plurnk-service/blob/main/plurnk-contracts/README.md).
- **Behavioral contract:** [`SPEC.md`](./SPEC.md).

## CLI

```sh
npm install -g --ignore-scripts @plurnk/plurnk-service
plurnk-service migrate          # apply pending SQLite migrations in place
plurnk-service start            # run the :1066 daemon
plurnk-service reload           # validate & hot-reload ~/.config/plurnk/.env
plurnk-service stop             # stop the running daemon and wait for exit
plurnk-service update           # refresh XDG Models.dev catalog cache
plurnk-service config defaults  # print complete installed .env.defaults catalog
plurnk-service config check     # validate settings & route credentials offline
plurnk-service share [db] [dir] # export consistent forensic digest ({§share})
```

## Listener (`:1066`)

| Mount | Module | Role |
| --- | --- | --- |
| `/acp` | `@plurnk/plurnk-acp` | ACP v2 JSON-RPC 2.0 (`providers/list`, `session/new`, `session/options`, `configOptions`: `model`, `thought_level`, `child`, `persona`, `mode`) + `/entry` & `/messages`. |
| `/mcp[/<workspace>[/<session>]]` | `@plurnk/plurnk-mcp` | Inbound MCP v2 Streamable HTTP server + outbound workspace MCP host. |
| `/` | `@plurnk/plurnk-web` | Pure `/acp` + `/notifications` browser client mounted by default via `optionalDependencies` (`--omit=optional` omits). |
| `/.well-known/oauth-protected-resource` | `@plurnk/plurnk-auth` | Optional OIDC / OAuth 2.1 resource metadata & `jose` JWT verification (`PLURNK_AUTH_ISSUER`). |
| `/notifications` | `@plurnk/plurnk-service` | `DaemonNotification` SSE stream. |
| `/health`, `/healthz` | `@plurnk/plurnk-service` | Unauthenticated readiness probes (`200` `{"status":"pass"}` / `503`). |

## Lifecycle ({§lifecycle-terms})

| Entity | Scope |
| --- | --- |
| `Workspace` | Shared Functionality (`mcp`, `skills`, `personas`, `schedule`, `members`, `env`), capability policy, and optional `project_root`. |
| `Session` | Durable actor and log inside a workspace (`work`, `fork`, `send`). `note` distills conclusions, findings, and plans across loops. |
| `Loop` | Queued-to-terminal unit of work; turns continue until messages are answered, results observed, and held work settled (`wait` yields while work remains). |
| `Turn` | One packet dispatch → model response → `mcp` tool lowering → sequential operation execution → SQLite commit (`kill` curates visible log weight). |

## File membership & search

| Boundary | Behavior |
| --- | --- |
| Tracked & declared members | Working set is `(git tracked ∪ members include ∪ created) − exclude` ({§membership}). `AGENTS.md` injects separately as policy. |
| Auto-enrollment (`PLURNK_MEMBERS_AUTO_ADD=1`) | Reading or content-matching an untracked, unignored, unexcluded project file enrolls it with a `member_added` notice (`0` refuses, {§membership-auto-add}). |
| Creation (`PLURNK_SERVICE_FILE_CREATE_SCOPE`) | Defaults to `project_root`; accepted creation is exclusive and Git-added or explicitly picked ({§fs-write-surface}). |
| Edits & subprocesses | `edit` is proposal-gated and revision-checked ({§file-snapshot-revision}); outside-root members are read-only unless picked. Subprocess executors (`sh`, `js`, `python3`) gate on `effect: "host"` proposals rather than file membership. |
| Full-text search | `find` `~query` runs native SQLite FTS5 with BM25 ranking over indexed readable content (no external search service). |

## Observability & forensics

- **OpenTelemetry (`@plurnk/plurnk-otel`):** `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` (`otlp`, `console`, `none`) and `OTEL_SERVICE_NAME` export lifecycle spans and metrics without recording prompts, file bodies, URLs, or secrets ({§observability-boundary}, {§otel-module}). Zero SDK load when unconfigured.
- **Forensic digests ([`@plurnk/plurnk-digest`](https://github.com/plurnk/plurnk-service/blob/main/plurnk-digest/README.md)):** Consumes `@plurnk/plurnk-service/evidence` into a new/empty output directory; for restorable backups, use [`VACUUM INTO`](./INSTALL.md#backup-and-restore).

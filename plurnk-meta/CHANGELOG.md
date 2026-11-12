# @plurnk/plurnk-meta

## 2.2.1

### Patch Changes

- Compose OS system CA certificates (`tls.getCACertificates("system")`), Node bundled roots, and `NODE_EXTRA_CA_CERTS` in `syncAmbientHttp`, restrict extension package discovery to `@plurnk/*`, remove `recap.md` (`recapPath`), canonicalize Heredoc Code Mode (`<<<EOF`) across reference material, and lower the packet token floor to `~2,948` (#1412 #1419 #1420 #1421 #1422 #1423 #1424 #1425 #1426 #1427 #1428 #1429 #1430 #1431 #1432 #1433 #1434 #1435 #1436 #1437 #1438 #1439 #1441 #1444 #1451 #1455).

  ### Operator Migration Guide (5.x to 6.0.0)

  - **Upgrade client and daemon together:** Upgrade `@plurnk/plurnk` and `@plurnk/plurnk-service` to `6.0.0`.
  - **SQLite Schema Migrations (`015`–`018`, `{§db-migrations}`):** Chapters `015_session_message_keys.sql` (`session_messages` composite foreign keys and cascade deletes), `016_drop_unused_columns.sql` (retiring unused `streams.metadata`, `streams.lifetime`, `sessions.CompactionSummary`, `sessions.CompactionThroughLoop`, and `turns.parse_advisory` columns), `017_pending_derivation_indexes.sql` (partial indexes for incremental `SearchIndex.maintain`), and `018_content_dedup_payloads.sql` (interning `turn_sources` and `log_entries` payloads into `contents`) run automatically in place on any database at or above the `5.0.0` support floor (`user_version >= 11`).
  - **Removed Configuration Knobs (`{§configuration-panel}`):** `PLURNK_SERVICE_PROMPT_PREVIEW` and `PLURNK_SERVICE_LOG_BUDGET_SUMMARY` are retired; remove them from `.env` files if present.
  - **Model-Facing Heredoc Syntax (`{§code-grammar}`):** Canonical Code Mode emits `await`-free `<service>.<tool>({ ... })` calls with `<<<EOF` heredoc delimiters for multiline values, and `note`, `send`, `work`, `fork`, `done`, `fail`, and `kill` carry their body in `text`.

## 2.2.0

### Minor Changes

- Replace the fenced heading grammar with exclusive unwrapped Code Mode
  (`await plurnk.<op>(args);` and `await <server>.<tool>(args);`), unify the 15
  core VM operations, REPL executors (`sh`, `js`, `python3`), 6 Functionality
  families (`env`, `mcp`, `members`, `personas`, `schedule`, `skills`), and
  `question` under the `plurnk` MCP runtime (`mcp:///plurnk.md`,
  `mcp:///plurnk/*.json`), lowercase operation tokens across contracts, parser,
  engine, SQLite (`014_lowercase_ops.sql`), ACPv2, and digest, consolidate Plurnk
  Harness reference chapters under `skill://plurnk/*.md` and `mcp:///*.md` Turn-0
  orientation with a single closing `todo` (`~3,097` wire token floor), and
  delegate OpenAI-compatible `compat` and stream normalization to
  `@mariozechner/pi-ai` with an in-flight runaway stream output allowance guard
  (#1403 #1404 #1405 #1406 #1407 #1408 #1409 #1410 #1411 #1413 #1414 #1415 #1416 #1417 #1418).

## 2.1.6

### Patch Changes

- 4c9309c: Introduce `DONE`, `FAIL`, and `TODO` operations, retire `SEND [200]` /
  `SEND [499]` and reasoning scraping, deliver `AGENTS(.local).md` in the
  `system-policy` packet section, project sandbox tarballs, teach native `EDIT`
  skill authoring, unify `PluginSources` module candidates, record the OAuth
  credential-authority DGR, delegate provider sampling and tool-call suppression
  directly to `@mariozechner/pi-ai`, and align ACP v2 session projection, wildcard
  Host origins, loop epoch timestamps, cancelled inbox replay, `workspace.archive`,
  `workspace.list` `includeArchived`, `session/archive`, `session/unarchive`,
  `session/delete`, `session/status`, `session/set_title`, `tool_call/cancel`,
  `terminal/cancel`, `auth/status`, `auth/status_update`, `auth/logout`,
  `PlanFile`, `SubagentUpdate`, entry URLs on live reasoning and inbox items,
  active alias effort projection on fresh sessions, structured reasoning and
  operation metadata, scoped `session/list` overview projection with live
  `_plurnk/overview` notifications, immediate SSE open flush, and
  `workspace/renamed` updates
  (#1305 #1380 #1384 #1385 #1386 #1387 #1388 #1389 #1390 #1391 #1392 #1393 #1394 #1395 #1396 #1398 #1399).

## 2.1.5

### Patch Changes

- - Add the `personas` Functionality family (`persona://<name>/PERSONA.md`, `plurnk:///personas/personas.md`, `plurnk_personas`, and `workspace.personas.*` ACP actions) with `EDIT` and `KILL` support on `persona://` and `--persona` in `orientation` (`#1371`).
  - Export the closed `LOG_ENTRY_KINDS` union and `isLogEntryKind` guard from `@plurnk/plurnk-contracts`, simplify `logEntry.sql` and `TurnSources.sql` to direct column projections, and omit the redundant `NOTE` packet row object when the note emission is already materialized in the packet (`#1372`, `#1373`, `#1374`, `#1376`, `#1377`).
  - Reconcile ACP stream, `WAIT`, descendant replay, history-ceiling, and passive `session/resume` contracts and specifications (`#1375`, `#1378`, `#1379`).
  - Verify route-dependent provider credentials (`plurnk-service config verify`), scope the packaged systemd unit to `--user`, and erase retired GBNF and grammar-rail support (`#1363`, `#1364`, `#1365`, `#1366`, `#1367`, `#1369`, `#1370`).

## 2.1.4

### Patch Changes

- Add `plurnk-service config show [--json]` with per-knob source attribution, secret redaction, and live daemon lock status, serve unauthenticated `/health` and `/healthz` readiness probes, mount `skill://plurnk/plurnk.service` and `skill://plurnk/plurnk.nginx.conf` for model self-orientation, and tolerate redundant matching `"name"` properties while isolating invalid entries in standalone `mcp.json` (`#1362`).

## 2.1.3

### Patch Changes

- 39a8617: Delegate model catalog discovery and provider streaming directly to
  `@earendil-works/pi-ai` (`#1286`, `#1305`), restrict `service.update` to model
  catalog refresh (`#1285`), allow trusted third-party
  `@plurnk/plurnk-mimetypes-*` packages to override built-in floor handlers
  (`#1306`), keep ACP streams alive with `heartbeatMs` and restore
  disconnect/gate-transfer integration coverage (`#1307`, `#1308`), unify
  `ApplicationPort` and domain modules (`#1287`–`#1304`, `#1312`), enforce
  heading-only `§tag` declarations and dual witnesses in `plurnk-spec-check`
  (`#1283`, `#1309`, `#1311`), and complete ACP v2, MCP v2 Open Work, SEP-2640
  Skills over MCP, and multi-tier customization parity (`#654`, `#1332`–`#1351`).
  
  ### Operator Migration Guide (4.x to 5.0.0)
  
  - **SQLite Schema Baseline ({§db-migrations}):** 34 incremental chapters
    (`user_version = 34` in `v4.3.3`) are folded into an 11-chapter baseline
    (`001`–`011`, `user_version = 11`) with a support-floor guard. Point
    `PLURNK_SERVICE_DB_PATH` at a new file or move the pre-5.0 database and its
    `-wal` and `-shm` sidecars aside once every daemon holding it has stopped.
  - **Session & Workspace Addressing ({§session-scheme}):** `worker://<name>` is
    renamed to `session://<name>`, `workspace:///` holds shared workspace scratch
    entries, and `plurnk:///` and `mcp:///` serve generated daemon, tool, and MCP
    server reference documents. Update references from `worker://` to `session://`
    and `_plurnk/...` to `plurnk:///...` or `mcp:///...`.
  - **Client & External Protocols ({§acp-daemon-client}):** A2A (`plurnk-a2a`) and
    AG-UI (`plurnk-agui`) are retired in favor of ACP v2 (`/acp` via
    `@plurnk/plurnk-acp`) and OAuth 2.1 (`@plurnk/plurnk-auth`). Upgrade
    `@plurnk/plurnk` to `5.0.0`.
  - **Built-in Executors ({§executor-role}) & Family Tools ({§functionality-model-projection}):**
    `@plurnk/plurnk-execs-jq` and `@plurnk/plurnk-execs-sqlite` are retired, the
    `node` runtime tag is renamed to `js` (`js:///`, `PLURNK_EXECS_JS*`), and the
    multiplexed `plurnk` tool is split into per-family runtimes (`plurnk_env`,
    `plurnk_mcp`, `plurnk_skills`, `plurnk_schedule`, `plurnk_members`, and
    `plurnk_question (ask)`) with flat `add`/`replace` payloads and underscore-bearing
    `RUNTIME_TAG` / `SERVER_NAME` support.
  - **Operation Metadata Matchers:** `[pattern]`, `[env]`, `[cwd]`, and `[args]`
    metadata fields on operations are removed (`#1255`, `#1258`, `#1259`,
    `#1260`). Use the header `pattern` slot, `plurnk_env`, and in-body command
    arguments.
  - **Catalog Refresh (`service.update`):** Narrowed to refreshing the Models.dev
    and `@opencode-ai/models` catalog (`#1285`). Upgrade `@plurnk/*` packages via
    your package manager.
  - **Customization & Environment Cascade:** Adds `$XDG_CONFIG_HOME/agents` and
    `~/.agents` global roots, `AGENTS.md` + `AGENTS.local.md` across
    global/root/subtrees, `session://<session>/AGENTS.md` role seeding,
    `persona://` (`--persona` / `/persona` / `PLURNK_PERSONAS*`), and
    `$XDG_CONFIG_HOME/plurnk/.env.local`.

## 2.1.2

### Patch Changes

- 93c0d87: `instanceof ConfigurationError` recognizes a configuration error from any copy of
  the package by its name and key ({§configuration-error-identity}), so a module
  loaded from its own plugin root reports its configuration errors as its
  diagnostic instead of aborting daemon boot.

## 2.1.1

### Patch Changes

- d8a45b0: Resolve bulk EDIT and resource KILL selectors before mutation, preserving
  per-resource approvals, scopes, anchors and receipts. Require a single resolved
  resource for each COPY/MOVE glob operand before changing either side. Keep
  selected channels through fan-out and count concrete operations against
  configured command limits.
- 05e38b8: Resolve encoded file URLs through native filesystem interpretation without
  double-decoding stored names. Reads, mutations, client attachments, catalogs,
  packets and digest addresses share the same identity. Render ambiguous filenames
  as reusable file URLs while keeping ordinary paths project-relative.
  Keep MOVE source approval bound to the source operand after its destination lands.
- 0b7f8b1: Add shared named definition replacement, retaining enabledness and preserving
  the previous publication on refusal. Use it for repeated environment EDITs
  and explicit child environment overrides, and reject fresh skill preparation
  failures when their definitions change. Carry attempt-local admission data
  through preparation without changing live state; schedule replacements and
  retries affect timers and held delivery failures only after publication.
- 66fcb98: Preserve literal backslashes and escaped glob characters consistently in resource
  selection, file-URL selectors, membership scans, inspection and SQL membership
  checks. Use the standard glob engine instead of Node's fixed separator handling.

## 2.1.0

### Minor Changes

- 9f8e27b: Add `Knob.family(prefix)`, and recap lines: each
  `PLURNK_SERVICE_RECAP_LINE_<alias>` renders as one directive callout ahead of
  the recap source, and an empty value turns a shipped line off. None ships.

## 2.0.2

### Patch Changes

- 85bcf56: Serve AG-UI only at `/agui`, removing the root endpoint. Clients must use the
  advertised URL or append `/agui` to the daemon origin. The HTTP root is available
  to an independent module; when unclaimed it returns 404 after startup. Rootless
  daemons retain the same startup-admission and mount-ownership checks.
- 8d9fb11: Retired names, settings and shapes are erased; nothing recognizes them to refuse
  or translate them. A setting the package does not read is inert, and an
  undeclared value fails through the package's ordinary check.

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

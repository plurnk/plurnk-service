# @plurnk/plurnk-schedule

## 4.1.0

### Minor Changes

- eb0293a: Advertise per-family Functionality scopes (`policy.familyScopes`), retire
  `service.schedule.*` and `service.members.*` as workspace-only families, add
  `models.providers` and `config/changed` discrete notifications for live
  provider onboarding, and isolate MCP `${NAME}` expansion from daemon provider
  credentials and `PLURNK_*` secrets (#1588).
- 3d53337: Add the in-service `service` tier across the configuration and Functionality
  cascades (#1581):
  
  - Establish one two-stage monotonic cascade (`host → service → workspace →
    session → turn`), keeping bind-time, host-confinement, and family-managed
    keys strictly host-only while narrowing ceilings monotonically and emitting
    loud `configuration_service_shadow` notices + `ConfigEntry.shadows` when
    service overrides shadow explicit host values.
  - Add the dedicated client-only `config` plane (`service.config.{list,set,unset}`,
    `workspace.config.{list,set,unset}`) gated by the fail-safe
    `PLURNK_SERVICE_CLIENT_CONFIG` allowlist (advertised on
    `ApplicationDaemonPolicy.config`), isolating secrets exclusively in encrypted
    `$XDG_STATE_HOME/plurnk/config-secrets.enc` (`0600` AES-256-GCM + HKDF)
    outside SQLite and `share`, plus `plurnk-service config {set,unset}` with
    stdin secret support and `SIGHUP` live reload.
  - Retire `workspace.create({ settings })` and `_meta.plurnk.settings` in favor
    of canonical `{ config?, client? }` backed by `workspace_config` (migration
    `031` migrates existing `workspaces.settings` knobs in place and renames
    persisted `"service"` Functionality origins to `"host"`).
  - Rename the read-only external Functionality origin from `"service"` to
    `"host"` (`409 alias-host-owned`), and uniformly project client-only
    `service.<family>.*` actions (`mcp`, `skills`, `personas`, `env`) plus
    daemon-wide `service.mcp.oauth.{begin,complete}` with shared encrypted grants
    and client confinement on `service`-origin definitions.

### Patch Changes

- 9d04649: Bound transient in-memory caches and reclaim memory on workspace cooling and
  retention sweeps: evict `MembershipMaterialization` settled-stat caches and run
  `PRAGMA shrink_memory` in `WorkspaceResidency` and `Retention`, LRU-bound
  cold-workspace persona reads and `llms.txt` origin attempts, evict archived or
  empty workspaces from `Scheduler` RAM, clean up `#configurationNotices` on MCP
  teardown, switch `_search-exclusion` to a single-entry cache, and add a
  repeatable `npm run bench:memory` footprint benchmark (#1579).
- Updated dependencies [eb0293a]
- Updated dependencies [12055f7]
- Updated dependencies [9319f97]
- Updated dependencies [1f24586]
- Updated dependencies [3d53337]
  - @plurnk/plurnk-contracts@11.0.0

## 4.0.2

### Patch Changes

- Wait for started/queued stream conclusion before reading scheduled step output
  (#1570).
- Updated dependencies [f4c6ae9]
- Updated dependencies [8032dbd]
  - @plurnk/plurnk-meta@4.1.0

## 4.0.1

### Patch Changes

- 994085a: Erase retired `rule: null` and raw string `run` schedule forms from
  `@plurnk/plurnk-contracts`, share canonical `ScheduledToolCall`,
  `ScheduledStepReceipt`, `ScheduleStatus`, `tokenizeSlashArgs`,
  `formatScheduleInspect`, `formatScheduleStepReceipts`, and `SCHEDULE_ADD_FLAGS`
  across contracts, schedule, and ACP, and align `/schedule` ACP slash dispatch
  with quote-preserving tokenization, `show`/`inspect`, and per-step receipts
  (#1558).
- 48c9599: Freeze v9.0 wire, `.env`, and SQLite contracts: unify approval policies onto
  `review | accept | reject` and add `_MS`/`_SEC` suffixes to duration knobs;
  move execution stream outputs onto `exec:///<runtime>/<id>`; serve computed
  `plurnk:///status.json` and `plurnk:///recent.json`, camelCase notification
  fields, `loop/started` and `loop/parked`, `session.rollback`, and `op.exec`;
  and squash SQLite migrations `001..025` into `025_baseline.sql` with in-place
  `026_exec_streams.sql` upgrade from `8.0.0` (#1533, #1538).
- d5c9190: Normalize all wire and ApplicationPort projections to camelCase (`LogEntryWire`,
  `ApplicationStream`, `ApplicationSessionProjection`, `listWorkspaces`, and
  `session.loops` `{ opening, continued, lifecycle, source }`), drop redundant
  dual wire keys on `session/list`, `workspace.create`, and `workspace.attach`,
  and rename the child-model config option, port methods, notification field, and
  SQLite v29 schema column to `child` / `childModel` / `child_model_route_id`
  (#1559).
- 95c20d4: Move `MCP_WIRE_TOOL` to `@plurnk/plurnk-contracts`; clean up provider error
  classes, Google/Bedrock fetch and non-image media projection, and `<think>`
  preservation; bound concluded stream maps and split `Module.test.ts` in
  `plurnk-acp`; cache compiled `/mcp` tool schemas; unify `ProposalLifecycle`
  diffs on `diff`; remove 0-byte `POLICY.md` and dead table stripping; rebalance
  `SPEC.md` contracts and `plurnk-spec-check`; and split offline `deps:check`
  from `deps:drift` (#1534).
- Updated dependencies [b7af995]
- Updated dependencies [0ec73cf]
- Updated dependencies [26a53d2]
- Updated dependencies [c944ab3]
- Updated dependencies [fedefcf]
- Updated dependencies [380eec0]
- Updated dependencies [84800f9]
- Updated dependencies [13a6974]
- Updated dependencies [994085a]
- Updated dependencies [48c9599]
- Updated dependencies [13b5960]
- Updated dependencies [d006146]
- Updated dependencies [d5c9190]
- Updated dependencies [95c20d4]
- Updated dependencies [d136818]
  - @plurnk/plurnk-contracts@10.0.0
  - @plurnk/plurnk-modules@5.0.0
  - @plurnk/plurnk-meta@4.0.0

## 4.0.0

### Major Changes

- Erase retired `AgentPlugin` and `CapabilityPolicy` surfaces across contracts,
  meta, daemon, ACP, MCP, and skills (`#1517`, `#1522`); mount scoped
  `/notifications[/<workspace>[/<session>]]` discrete event streams with
  `Last-Event-ID` replay and outbound ACP/MCP push notifications (`#1518`,
  `#1523`); introduce scoped `env://` coordinates, cascaded environment resolution,
  and the `PLURNK_ENV` execution sink (`#1519`); expand `schedule` with scripted
  actions, one-shot/`null` rules, catch-up policies, and `open`/`done`/`fail`
  settlement without workspace residency contention (`#1520`); and add durable
  session `persona` state, `work`/`fork` persona/model/effort options, and scoped
  `/learn` coordinates (`#1521`).

### Patch Changes

- Retire `200` `log:///` `kill` curations, `204`/`304` mutation no-ops, and
  stateless `>= 400` refusals from `active_log_entries` after their one-turn
  `## Notices` projection (`#1525`); treat `413` context-fit budget receipts as
  recoverable soft failures on `StrikeRail` (`404, 409, 413, 416, 425, 501`),
  narrow already-scoped `413` `read`/`find` recovery hints to `kill first.`, and
  widen model-tier near-miss recovery for fallback `id`/`session`/`stream` targets,
  literal `old`/`new` replacements, `done`/`fail` `note` bodies, `#<channel>`
  `range` values, and XML/tag invoke-boundary leaks (`#1527`); omit client-chosen
  `id_slot` pins and normalize root-path `llama-server` URLs (`#1524`); and update
  `@agentclientprotocol/sdk` (`2.8.0`), `rrule-temporal`, `music-metadata`
  (`12.7.0`), and the bundled `@opencode-ai/models` (`0.0.140`) catalog (`#1516`,
  `#1526`, `#1528`).
- Updated dependencies
- Updated dependencies
  - @plurnk/plurnk-contracts@9.0.0
  - @plurnk/plurnk-meta@3.0.0

## 3.0.10

### Patch Changes

- d0e6618: Adopt the universal structured `mcp` wire tool
  (`{ server, tool, arguments, aside? }`) across all model emissions, lower
  assistant prose into leading `note` operations, coerce unambiguous model-tier
  parameter, query, and nested-call near-misses with canonical `ops://` replay and
  working-form `mcp` recovery hints, preserve provider `thoughtSignature` and
  thinking blocks across replayed turns, coalesce trailing user parts into Google
  Gemini `functionResponse` turns, attach enclosing `find` locators and open-stream
  causal `aside`/`openedAt` projections, tolerate explicit enumerated multi-target
  message replies without silent erasure, and consolidate `skill://plurnk/`
  orientation chapters (`#1479`–`#1515`).
- Updated dependencies [2be0585]
- Updated dependencies [d0e6618]
  - @plurnk/plurnk-contracts@8.0.0
  - @plurnk/plurnk-meta@2.3.0

## 3.0.9

### Patch Changes

- 315c977: Bump `rrule-temporal` to `^2.2.9`.

## 3.0.8

### Patch Changes

- Canonicalize Heredoc Code Mode (`<<<EOF`) across parser, serializer, teaching, and contracts, unify operation payloads on `{ text }` while retiring stream `metadata` and `lifetime` fields, remove `PLURNK_SERVICE_PROMPT_PREVIEW` and `PLURNK_SERVICE_LOG_BUDGET_SUMMARY`, add OAuth 2.1 `requested_subject` token exchange and principal-scoped ACP v2 live streams, emit ACP v2 `_plurnk_telemetry`, windowed session resume, multi-select `question` options, and paginated `log.list` / `log.read` (`openOnly`, `sender`, `recipient`, `offset`), extract EXIF headers in `@plurnk/plurnk-mimetypes-image`, and lower the packet token floor to `~2,948` (#1412 #1419 #1420 #1421 #1422 #1423 #1424 #1425 #1426 #1427 #1428 #1429 #1430 #1431 #1432 #1433 #1434 #1435 #1436 #1437 #1438 #1439).
  
  ### Operator Migration Guide (5.x to 6.0.0)
  
  - **Upgrade client and daemon together:** Upgrade `@plurnk/plurnk` and `@plurnk/plurnk-service` to `6.0.0`.
  - **SQLite Schema Migrations (`015`–`018`, `{§db-migrations}`):** Chapters `015_session_message_keys.sql` (`session_messages` composite foreign keys and cascade deletes), `016_drop_unused_columns.sql` (retiring unused `streams.metadata`, `streams.lifetime`, `sessions.CompactionSummary`, `sessions.CompactionThroughLoop`, and `turns.parse_advisory` columns), `017_pending_derivation_indexes.sql` (partial indexes for incremental `SearchIndex.maintain`), and `018_content_dedup_payloads.sql` (interning `turn_sources` and `log_entries` payloads into `contents`) run automatically in place on any database at or above the `5.0.0` support floor (`user_version >= 11`).
  - **Removed Configuration Knobs (`{§configuration-panel}`):** `PLURNK_SERVICE_PROMPT_PREVIEW` and `PLURNK_SERVICE_LOG_BUDGET_SUMMARY` are retired; remove them from `.env` files if present.
  - **Model-Facing Heredoc Syntax (`{§code-grammar}`):** Canonical Code Mode emits `await`-free `<service>.<tool>({ ... })` calls with `<<<EOF` heredoc delimiters for multiline values, and `note`, `send`, `work`, `fork`, `done`, `fail`, and `kill` carry their body in `text`.

## 3.0.7

### Patch Changes

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
- Updated dependencies
  - @plurnk/plurnk-meta@2.2.0

## 3.0.6

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
- Updated dependencies [39a8617]
  - @plurnk/plurnk-contracts@7.0.0

## 3.0.5

### Patch Changes

- Updated dependencies [cfa2be9]
- Updated dependencies [ff99f76]
- Updated dependencies [a8200fb]
- Updated dependencies [65da58e]
- Updated dependencies [d2dcf47]
- Updated dependencies [d679cc5]
- Updated dependencies [25aadcf]
- Updated dependencies [cc3e9cb]
- Updated dependencies [f7e3b0e]
- Updated dependencies [558c0db]
- Updated dependencies [0cee49c]
- Updated dependencies [878d630]
- Updated dependencies [c3922c2]
- Updated dependencies [dd52a9b]
- Updated dependencies [50fbe81]
- Updated dependencies [4e4cb32]
- Updated dependencies [06d4a8d]
- Updated dependencies [39f234e]
- Updated dependencies [de4fc63]
- Updated dependencies [de9ce8f]
- Updated dependencies [f3cd7de]
- Updated dependencies [4a048a8]
- Updated dependencies [2e5b2c1]
  - @plurnk/plurnk-contracts@6.0.0

## 3.0.4

### Patch Changes

- f320b9b: `FunctionalityPrepared` gains a required synchronous `publish()` returning an
  undo. Candidate state goes live there, inside the coordinator's registry
  commit, with no I/O; `commit()` is post-publication settlement; `abort()`
  discards an unpublished candidate. The coordinator composes the adapter's undo
  with its own view rollback. MCP consumes a pending OAuth candidate at publish,
  so a callback replayed after publication is `404 oauth-not-pending` with no
  window (#1155).
- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 3.0.3

- Honor host cancellation during preparation and join cleanup before shutdown
  disposal. Real preparation and cleanup failures remain visible.
- Uses contracts/modules 4.0.

## 3.0.2

### Patch Changes

- 157cf8f: A members definition is its glob. `members (add)` takes `{"files": ["<glob>",
  "!<glob>"]}` and admits each glob as one definition, all or none, with a receipt
  listing them; `enable`, `disable` and `remove` take `{"file": "<glob>"}`; the
  family serves no `replace`. The operator's `PLURNK_MEMBERS_<alias>=<glob>` key
  is the definition's provenance, shown by `list`. Migration 27 re-keys workspace
  definitions by their glob and drops alias-keyed overrides of service
  definitions. The coordinator gains one seam, `addressing`: a family may name
  definitions by their content, `admit` may return one admission per definition,
  `FunctionalityPreparation.admissions` carries them, and
  `FunctionalityMutationResult` lists `definitions` for such an add. Every file
  miss recovery names the `members (add)` body the family accepts.

## 3.0.1

### Patch Changes

- 0b7f8b1: Add shared named definition replacement, retaining enabledness and preserving
  the previous publication on refusal. Use it for repeated environment EDITs
  and explicit child environment overrides, and reject fresh skill preparation
  failures when their definitions change. Carry attempt-local admission data
  through preparation without changing live state; schedule replacements and
  retries affect timers and held delivery failures only after publication.
- 7163937: Document existing failure codes omitted from the owning specifications. Runtime
  behavior and failure identities are unchanged.

## 3.0.0

### Major Changes

- 69f3ffe: A family's `discover` advertises only the inputs it serves. An adapter declares
  `discovery.inputs` (and `emptyListsAll`), implements `discover` exactly when it
  does, and the coordinator builds the discover input schema from that
  declaration: any other input is refused 400 `arguments-invalid` by the shared
  schema check, naming the field. A family without discovery has no `discover`
  verb; MCP serves one only while `PLURNK_MCP_REGISTRY_URL` names a registry, and
  contains an invalid registry setting. Members discovery takes `query` alone and
  refuses a query naming no path or pattern as `query-invalid`; an empty env
  discovery is the whole catalog and needs no body. The refusals
  `query-unsupported`, `configuration-unsupported`, `source-unsupported`,
  `registry-not-configured`, `query-required` and schedule's `source-required`
  are gone.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.

### Patch Changes

- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
- 85bcf56: Explain exhausted schedules as “no future occurrences” in their existing
  description, including when an absolute start has expired before add. Scheduling,
  delivery and WAIT behavior are unchanged.
- 503ea87: A `PLURNK_*` key the operator's configuration file sets and no installed package
  declares is named at startup and by `config check`; nothing is refused.
  Each package panel declares the key families it reads by computed name, such as
  `# PLURNK_MCP_<alias>=<definition>`.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-modules@3.0.0
  - @plurnk/plurnk-schemes@3.0.0

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-modules@2.0.0
  - @plurnk/plurnk-schemes@2.0.0

# @plurnk/plurnk-acp

## 4.1.0

### Minor Changes

- da974aa: Add `PLURNK_AUTH_DELEGATES` and `canDelegateActor` bearer claim support so
  authenticated bridges can attribute non-default exterior `_meta.plurnk.actor`
  speakers while keeping ordinary users pinned to their JWT `sub` (#1566).
- 11b9e32: Add operator-enforced project-root and membership confinement
  (`PLURNK_SERVICE_PROJECT_ROOT_BASE`, `ApplicationDaemonPolicy`, and ACP
  `initialize` `_meta.plurnk.policy`) (#1563).

### Patch Changes

- Updated dependencies [da974aa]
- Updated dependencies [f4c6ae9]
- Updated dependencies [8032dbd]
- Updated dependencies [11b9e32]
- Updated dependencies [4563cf3]
  - @plurnk/plurnk-contracts@10.1.0

## 4.0.0

### Major Changes

- fedefcf: Default the `:1066` loopback listener to zero-password access with browser
  same-origin CSRF and loopback DNS-rebinding defenses (`admitBrowserOrigin`),
  retire the in-daemon OAuth 2.1 server, password hashing, and host
  `secret`/`credentials` files, and repurpose `@plurnk/plurnk-auth` into an
  optional `jose`-backed external OIDC / OAuth 2.1 resource server
  (`PLURNK_AUTH_ISSUER`, `PLURNK_AUTH_CLIENT_ID`, `PLURNK_AUTH_AUDIENCE`,
  `PLURNK_AUTH_CALLBACK`, `PLURNK_AUTH_SCOPES`, `PLURNK_AUTH_USERS`) serving
  RFC 9728 `/.well-known/oauth-protected-resource` (#1547).
- 380eec0: Retire `.env`-mutating `service.env.*` and `models.local` actions, scope
  `ProposalPolicy` (`mode`) to the session and single-loop `?` prompt override
  (`027_session_proposal_policy.sql`), enforce `ModelCatalogQuery` `limit <= 100`,
  and share interactive slash-command completion across clients (#1545).
- 13a6974: Unify exterior actor attribution across `SEND`, `/acp`, and `/mcp`, erase
  `plurnk-acp`'s per-subject `isNamedPrincipalPeer` wire filtering so every
  admitted ACP peer receives the full unfiltered ACP v2 stream and `openMessages`
  visibility, and rename `_meta.plurnk.voice` / `voices` to `actor` / `actors`
  (#1548).
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

### Minor Changes

- b7af995: Unify collection browsing, search, and pagination across Functionality families
  (`{§client-collection-browsing}`, `#1560`):
  
  - `@plurnk/plurnk-contracts`: Add `FunctionalityListQuery` (`query`, `state`,
    `origin`, `offset`, `limit`), bounded `offset`/`total`/`nextOffset` on
    `FunctionalityListResult`, `cursor`/`limit` on `FunctionalityDiscoverQuery`,
    `total`/`nextCursor` on `FunctionalityDiscoverResult`, structured `detail` on
    `FunctionalityCandidate`, and shared list/discover command parsing,
    pagination footers, and interactive completion flags.
  - `@plurnk/plurnk-modules`: Add `FunctionalityDiscovery.required` and allow
    `FunctionalityAdapter.discover` to return a `FunctionalityDiscoverPage`.
  - `@plurnk/plurnk-service`: Filter and paginate `list` across workspace and
    session families, paginate local discovery arrays via `offset:<N>` cursors,
    and emit structured preview `detail` from `members.discover`.
  - `@plurnk/plurnk-mcp`: Support empty-query MCP Registry browsing
    (`emptyListsAll: true`) and upstream `nextCursor` pagination.
  - `@plurnk/plurnk-skills`: Add optional `query` filtering alongside required
    `source` discovery.
  - `@plurnk/plurnk-acp`: Type filtered/paginated `list` and `discover` actions
    and update `@agentclientprotocol/sdk` to `^2.12.0`.
- 26a53d2: Scheduler-owned inference lanesmanship, fresh pre-packet admission, timeout
  exclusion while queued, and KV-aware session burst/handoff scheduling (`#1549`):
  
  - `@plurnk/plurnk-providers`: Promoted `InferenceAdmission` to a lane scheduler
    returning `InferenceLaneLease` (`release()`, `handoff()`, `suspend()`),
    exposed `Provider.acquireLane` and `Provider.laneGate`, added alias-scopable
    `PLURNK_PROVIDERS_LANE_BURST_MS` (default `300000` ms; `-1` run-to-completion,
    `0` strict FIFO) and `PLURNK_PROVIDERS_LANE_HANDOFF_MS` (default `15000` ms),
    excluded lane-queue wait from `PLURNK_PROVIDERS_OPERATION_TIMEOUT_MS`,
    coordinated local `/v1/chat/completions/input_tokens` and `/tokenize`
    preflights with endpoint admission, and added per-model `429` cooldown pacing.
  - `@plurnk/plurnk-service`: Acquired endpoint inference lanes in `LoopDriver`
    before `LoopLifecycle` active execution timing, `WorkspaceGate`, workspace
    derivation, and packet assembly so queued subagents assemble fresh packets,
    never burn `PLURNK_SERVICE_LOOP_TIMEOUT_MS` while queued, and yield inter-turn
    handoff reservations immediately on terminal outcomes, `202` parks, HITL
    proposals/interactions, `BARE`, exec holds, or recovery backoff.
  - `@plurnk/plurnk-contracts` & `@plurnk/plurnk-acp`: Routed `engine:turn`
    `turn_queued` notices onto `runtime/telemetry` and ACP `_plurnk_telemetry`
    with live queue position, depth, active count, and lane limit.
- 994085a: Erase retired `rule: null` and raw string `run` schedule forms from
  `@plurnk/plurnk-contracts`, share canonical `ScheduledToolCall`,
  `ScheduledStepReceipt`, `ScheduleStatus`, `tokenizeSlashArgs`,
  `formatScheduleInspect`, `formatScheduleStepReceipts`, and `SCHEDULE_ADD_FLAGS`
  across contracts, schedule, and ACP, and align `/schedule` ACP slash dispatch
  with quote-preserving tokenization, `show`/`inspect`, and per-step receipts
  (#1558).
- 13b5960: Harden OAuth `requested_subject`, bounded RFC 7591 registration, and session
  logout; fix `/mcp` resource errors, binary blobs, `ProposalPolicy` checks,
  `2025-06-18` client interop, and CORS; fix `/acp` reverse-proxy origins,
  `/entry` binary streaming, and `/notifications` `resync` cursors; and thread
  `ExecStatement.env` structurally (#1532).
- d006146: Align exterior actor admission and slash-command boundaries (`#1553`, `#1555`,
  `#1557`), expose `log.read` loop-window parameters, mark `/script`
  terminal-only, enforce `PLURNK_PROVIDERS_RAWBODY` as `0 | 1`, rename
  `PLURNK_META_ACCEPTANCE_TIMEOUT_MS`, and erase post-`#1550` `.items`/`.enabled`
  compatibility shims (`#1559`).

### Patch Changes

- 0ec73cf: Exclude unanswered Open Messages from `## Log Curation.largest` and name
  retired `message://` coordinates in `log_curated`; return `204` with a 1-turn
  observation when `kill` targets an already-terminated `exec:///` stream; and
  retire `kill` `note` distillation, coercing model-tier `note` to `aside`
  (#1535).
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
  - @plurnk/plurnk-parser@6.0.0

## 3.0.0

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
  - @plurnk/plurnk-parser@5.1.0

## 2.0.0

### Major Changes

- Adopt ACP v2 `2.7.0` `SessionReference` (`{ type: "session", sessionId }` preceded by `subagent_update`) on session-targeting `tool_call_update`s, advertise `session.prompt.audio` and admit `audio` prompt content blocks, and report live package `info.version` on `initialize`.
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

### Patch Changes

- 2be0585: Scope `## Log Curation` (`tokens`, `budget`, `percent`) and client
  `curationWeight` / `curationBudget` gauges to curatable log room by
  subtracting the non-curatable packet floor (`#1476`), route stateless `>= 400`
  refusals, `204`/`304` mutation no-ops, and `budget_exceeded` /
  `continued_without_note` advisories through transient one-turn `## Notices`
  (`loop_notices` and `notice_log_cursor`), surface provider
  generation/response-contract strikes and `max-commands-exceeded` rail rows
  cleanly to ACP clients (`#1478`), and update the bundled model catalog
  (`#1477`).
- Updated dependencies [2be0585]
- Updated dependencies [d0e6618]
  - @plurnk/plurnk-contracts@8.0.0
  - @plurnk/plurnk-parser@5.0.0

## 1.6.0

### Minor Changes

- 36830a8: Adopt `@agentclientprotocol/sdk` `2.7.0` `replay_complete` session replay
  boundaries, inline `skill` prompt content blocks and `available_commands_update`
  skill entries, and `session/fork` option metadata.

### Patch Changes

- 6fa0d9a: Bump `music-metadata` to `^12.5.0` and `ws` to `^8.23.0`.
- 9cc7191: Settle ended loop mailboxes atomically in SQLite with nullable `response_id`
  `'DOWN'` `499` completions across all sender schemes, re-queue unreceived
  follow-ups onto recovery loops, enforce open-loop and terminal-completion
  baseline guards, and expose `ApplicationPort.readOpenMessages` as the single
  open-message authority (#1467).
- 0a1a1cd: Name embedded `resource` and `image` prompt attachments by their URI's last
  decoded path segment rather than the whole URI, so a `file:///diagram.png` image
  publishes as `session://<session>/attachments/<hash>/diagram.png` and stays
  readable by that path (#1460).
- Updated dependencies [9cc7191]
- Updated dependencies [36830a8]
- Updated dependencies [2bb831e]
- Updated dependencies [594047d]
  - @plurnk/plurnk-contracts@7.5.0
  - @plurnk/plurnk-parser@4.6.0

## 1.5.0

### Minor Changes

- Canonicalize Heredoc Code Mode (`<<<EOF`) across parser, serializer, teaching, and contracts, unify operation payloads on `{ text }` while retiring `plurnk.todo` (`plan_update`) and stream `metadata` and `lifetime` fields, remove `PLURNK_SERVICE_PROMPT_PREVIEW` and `PLURNK_SERVICE_LOG_BUDGET_SUMMARY`, adopt `@agentclientprotocol/sdk` `2.6.0` `session/options` (`initialConfigOptions`) and modularize session command, option, and overview bindings, add `/personas` family slash commands, OAuth 2.1 `requested_subject` token exchange, principal-scoped ACP v2 live streams, `_plurnk_telemetry`, windowed session resume with reset reasoning/plan state across same-connection reattachments, multi-select `question` options, and paginated `log.list` / `log.read` (`openOnly`, `sender`, `recipient`, `offset`), and lower the packet token floor to `~2,948` (#1412 #1419 #1420 #1421 #1422 #1423 #1424 #1425 #1426 #1427 #1428 #1429 #1430 #1431 #1432 #1433 #1434 #1435 #1436 #1437 #1438 #1439 #1440 #1447 #1448 #1449 #1451 #1457).

  ### Operator Migration Guide (5.x to 6.0.0)

  - **Upgrade client and daemon together:** Upgrade `@plurnk/plurnk` and `@plurnk/plurnk-service` to `6.0.0`.
  - **SQLite Schema Migrations (`015`–`018`, `{§db-migrations}`):** Chapters `015_session_message_keys.sql` (`session_messages` composite foreign keys and cascade deletes), `016_drop_unused_columns.sql` (retiring unused `streams.metadata`, `streams.lifetime`, `sessions.CompactionSummary`, `sessions.CompactionThroughLoop`, and `turns.parse_advisory` columns), `017_pending_derivation_indexes.sql` (partial indexes for incremental `SearchIndex.maintain`), and `018_content_dedup_payloads.sql` (interning `turn_sources` and `log_entries` payloads into `contents`) run automatically in place on any database at or above the `5.0.0` support floor (`user_version >= 11`).
  - **Removed Configuration Knobs (`{§configuration-panel}`):** `PLURNK_SERVICE_PROMPT_PREVIEW` and `PLURNK_SERVICE_LOG_BUDGET_SUMMARY` are retired; remove them from `.env` files if present.
  - **Model-Facing Heredoc Syntax (`{§code-grammar}`):** Canonical Code Mode emits `await`-free `<service>.<tool>({ ... })` calls with `<<<EOF` heredoc delimiters for multiline values, and `note`, `send`, `work`, `fork`, `done`, `fail`, and `kill` carry their body in `text`.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-contracts@7.4.0
  - @plurnk/plurnk-parser@4.5.0

## 1.4.0

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

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-contracts@7.3.0
  - @plurnk/plurnk-parser@4.4.0

## 1.3.1

### Patch Changes

- 8798220: Handle `/mcp oauth <alias> [callback-url]` in `parseFamilyCommand` and
  `executeSlashCommand` via `workspace.mcp.oauth.begin` and
  `workspace.mcp.oauth.complete` (#1402).

## 1.3.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [4c9309c]
  - @plurnk/plurnk-contracts@7.2.0
  - @plurnk/plurnk-parser@4.3.0

## 1.2.0

### Minor Changes

- - Add the `personas` Functionality family (`persona://<name>/PERSONA.md`, `plurnk:///personas/personas.md`, `plurnk_personas`, and `workspace.personas.*` ACP actions) with `EDIT` and `KILL` support on `persona://` and `--persona` in `orientation` (`#1371`).
  - Export the closed `LOG_ENTRY_KINDS` union and `isLogEntryKind` guard from `@plurnk/plurnk-contracts`, simplify `logEntry.sql` and `TurnSources.sql` to direct column projections, and omit the redundant `NOTE` packet row object when the note emission is already materialized in the packet (`#1372`, `#1373`, `#1374`, `#1376`, `#1377`).
  - Reconcile ACP stream, `WAIT`, descendant replay, history-ceiling, and passive `session/resume` contracts and specifications (`#1375`, `#1378`, `#1379`).
  - Verify route-dependent provider credentials (`plurnk-service config verify`), scope the packaged systemd unit to `--user`, and erase retired GBNF and grammar-rail support (`#1363`, `#1364`, `#1365`, `#1366`, `#1367`, `#1369`, `#1370`).

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-contracts@7.1.0

## 1.1.2

### Patch Changes

- Unify ACP proposal and execution `toolCallId` on canonical `L/T/S` coordinates (`#1358`), enforce watched protocol dependency ledger and ACP v2 surface checks (`#1359`), and preserve `configId: "model"` with ready catalog selectors and workspace configuration notices on zero-alias installs (`#1360`).

## 1.1.1

### Patch Changes

- Emit ACP `WAIT` and `WORK`/`FORK` completion events, order streamed `output_rx` chunks after `tool_call`, scope `notice/event` to its owning session, project session-wide aggregate spend and parked loop state (`#1356`), replace compound `PLURNK_PROVIDERS_COST` with scalar `PLURNK_PROVIDERS_COST_<CATEGORY>` knobs, wire cost estimation into `compatibleProvider`, restore OpenAI-compatible streaming usage and normalize `llama-server` `timings` and `reasoning_content` chunk counts, and clarify curation phrasing on `plurnk.md` (`#1357`).

## 1.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [39a8617]
  - @plurnk/plurnk-contracts@7.0.0

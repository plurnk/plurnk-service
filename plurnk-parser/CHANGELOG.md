# @plurnk/plurnk-parser

## 6.0.0

### Major Changes

- 0ec73cf: Exclude unanswered Open Messages from `## Log Curation.largest` and name
  retired `message://` coordinates in `log_curated`; return `204` with a 1-turn
  observation when `kill` targets an already-terminated `exec:///` stream; and
  retire `kill` `note` distillation, coercing model-tier `note` to `aside`
  (#1535).
- c944ab3: Place required `aside` ahead of `arguments` in the universal `mcp` wire tool (`#1561`):
  
  - `@plurnk/plurnk-contracts`: Reorder `MCP_WIRE_TOOL.parameters.properties` to
    `server`, `tool`, `aside`, `arguments`, require `aside` in
    `MCP_WIRE_TOOL.parameters.required`, and tighten `aside.description` to
    `"Terse intent note."`.
  - `@plurnk/plurnk-parser`: Always emit `{ server, tool, aside, arguments }` from
    `toMcpCall` (constructing `aside: ""` when absent), preserve model-tier RENO
    toleration for omitted or empty `aside`, and recover DSML/XML invoke-boundary
    leaks inside `outer.aside`.
  - `@plurnk/plurnk-service`: Replay structured `OperationHistory` assistant
    `toolCalls` in `{ server, tool, aside, arguments }` schema order, emitting
    `aside: ""` when none was provided.
  - `@plurnk/plurnk-meta`: Align `DIVERGENCES.md` with the updated `mcp` wire
    contract.

### Minor Changes

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

### Patch Changes

- fedefcf: Default the `:1066` loopback listener to zero-password access with browser
  same-origin CSRF and loopback DNS-rebinding defenses (`admitBrowserOrigin`),
  retire the in-daemon OAuth 2.1 server, password hashing, and host
  `secret`/`credentials` files, and repurpose `@plurnk/plurnk-auth` into an
  optional `jose`-backed external OIDC / OAuth 2.1 resource server
  (`PLURNK_AUTH_ISSUER`, `PLURNK_AUTH_CLIENT_ID`, `PLURNK_AUTH_AUDIENCE`,
  `PLURNK_AUTH_CALLBACK`, `PLURNK_AUTH_SCOPES`, `PLURNK_AUTH_USERS`) serving
  RFC 9728 `/.well-known/oauth-protected-resource` (#1547).
- 84800f9: Add `--import <pkg-or-path>` and `--witness <prefix-or-tag>` to
  `@plurnk/plurnk-spec-check` for cross-package specification citation and witness
  enforcement, and move parser-internal lowering and RENO tolerance specifications
  from `@plurnk/plurnk-contracts/SPEC.md` into `@plurnk/plurnk-parser/SPEC.md`
  (#1559).
- 13b5960: Harden OAuth `requested_subject`, bounded RFC 7591 registration, and session
  logout; fix `/mcp` resource errors, binary blobs, `ProposalPolicy` checks,
  `2025-06-18` client interop, and CORS; fix `/acp` reverse-proxy origins,
  `/entry` binary streaming, and `/notifications` `resync` cursors; and thread
  `ExecStatement.env` structurally (#1532).
- 95c20d4: Move `MCP_WIRE_TOOL` to `@plurnk/plurnk-contracts`; clean up provider error
  classes, Google/Bedrock fetch and non-image media projection, and `<think>`
  preservation; bound concluded stream maps and split `Module.test.ts` in
  `plurnk-acp`; cache compiled `/mcp` tool schemas; unify `ProposalLifecycle`
  diffs on `diff`; remove 0-byte `POLICY.md` and dead table stripping; rebalance
  `SPEC.md` contracts and `plurnk-spec-check`; and split offline `deps:check`
  from `deps:drift` (#1534).
- d136818: Recover deterministic model-tier wire argument, URI, matcher, and Python slice
  near-misses while refusing ambiguous mixed positive-negative ranges (#1530).
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

## 5.1.0

### Minor Changes

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

## 5.0.0

### Major Changes

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

## 4.6.0

### Minor Changes

- 594047d: Drop `"unfenced"` from the session card and emission directives, pair inline
  heredocs before matching outer Markdown fences, unwrap fenced JSON/XML/Pythonic
  and language-tagged Code Mode tool calls under RENO while preserving prose
  fences, recover unprefixed core/runtime verbs and `bash`/`shell`/`python`/`py`
  aliases, and promote `description`/`explanation`/`comment` options to `aside` in
  model-turn parsing (#1472).

### Patch Changes

- 2bb831e: Preserve ECMAScript `\|` literal-pipe semantics in regex matchers, coerce
  single-line `/` code literals on `plurnk.edit` under RENO, reject unanchored
  empty-matching regex patterns on `plurnk.edit` with `422 pattern-empty-match`,
  make `Slicer.lineMarkerEditBatch` and `editReceipt` linear-time with `[first,
  last]` boundary compaction across synchronous and proposed edits, strip
  internal `attrs` from serialized `rx` payloads, and guard entry/file/log payload
  sizes against SQLite's 100 MiB content ceiling (#1474).
- Updated dependencies [9cc7191]
- Updated dependencies [36830a8]
- Updated dependencies [2bb831e]
- Updated dependencies [594047d]
  - @plurnk/plurnk-contracts@7.5.0

## 4.5.0

### Minor Changes

- Canonicalize `await`-free Heredoc Code Mode (`<service>.<tool>({ ... })` with `<<<EOF`) across parser, serializer, teaching, and contracts, unify operation payloads on `{ text }` while retiring `plurnk.todo`, recover heredoc (`<<EOF`), JSON-body XML `<parameter={...}>`, multiline `<parameter=...>`, bare JSON, keyword-argument, and 3-segment `plurnk.<server>.<tool>` MCP near-misses cleanly under RENO, expand hostile-input and transducer matrix suites, and lower the packet token floor to `~2,948` (#1412 #1419 #1420 #1421 #1422 #1423 #1424 #1425 #1426 #1427 #1428 #1429 #1430 #1431 #1432 #1433 #1434 #1435 #1436 #1437 #1438 #1439 #1446 #1451 #1456 #1458 #1459 #1462).

  ### Operator Migration Guide (5.x to 6.0.0)

  - **Upgrade client and daemon together:** Upgrade `@plurnk/plurnk` and `@plurnk/plurnk-service` to `6.0.0`.
  - **SQLite Schema Migrations (`015`–`018`, `{§db-migrations}`):** Chapters `015_session_message_keys.sql` (`session_messages` composite foreign keys and cascade deletes), `016_drop_unused_columns.sql` (retiring unused `streams.metadata`, `streams.lifetime`, `sessions.CompactionSummary`, `sessions.CompactionThroughLoop`, and `turns.parse_advisory` columns), `017_pending_derivation_indexes.sql` (partial indexes for incremental `SearchIndex.maintain`), and `018_content_dedup_payloads.sql` (interning `turn_sources` and `log_entries` payloads into `contents`) run automatically in place on any database at or above the `5.0.0` support floor (`user_version >= 11`).
  - **Removed Configuration Knobs (`{§configuration-panel}`):** `PLURNK_SERVICE_PROMPT_PREVIEW` and `PLURNK_SERVICE_LOG_BUDGET_SUMMARY` are retired; remove them from `.env` files if present.
  - **Model-Facing Heredoc Syntax (`{§code-grammar}`):** Canonical Code Mode emits `await`-free `<service>.<tool>({ ... })` calls with `<<<EOF` heredoc delimiters for multiline values, and `note`, `send`, `work`, `fork`, `done`, `fail`, and `kill` carry their body in `text`.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-contracts@7.4.0

## 4.4.0

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

## 4.3.0

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

## 4.2.3

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

## 4.2.2

### Patch Changes

- c30873c: Pull external runtime and protocol dependencies across the platform
  constellation to their latest stable releases, including
  `@modelcontextprotocol/client` and `@modelcontextprotocol/core` `2.4.0`,
  `json-p3` `^3.0.1`, `ai` `7.0.152` and its `@ai-sdk/*` providers,
  `eventsource-parser` `^4.1.2`, `linkedom` `^0.18.14`, `marked` `^18.1.1`,
  `music-metadata` `^12.2.3`, and `zod` `^4.6.7` (#1227).

## 4.2.1

### Patch Changes

- fccdbf5: A long line above a closing fence pairs in one pass. The orphan-closer check
  rescanned the line from each character, so a 300 KB line took seconds and a
  megabyte line minutes, with the daemon's event loop blocked (#1205).
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

## 4.2.0

### Minor Changes

- dc0808c: Fence pairing: a heading the author enclosed in a wider or labeled fence is the
  example it was written as, at no cost to a complete reading; only a declared
  code block discarded as text still counts with a hidden operation. A message
  whose own fence is narrower than the fences wrapping its examples now holds them
  instead of running them ({§pairing-objective}, {§balanced-fences}; #1147).

### Patch Changes

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 4.1.0

### Minor Changes

- 84c0d49: Replay each turn's complete admitted content operations together, in program
  order, as one assistant message immediately before that turn's receipts,
  retaining result bodies and resolved targets without duplicating authored
  requests. Curation removes replay with its owning receipt; immutable source and
  historical packets remain intact.
  
  Preserve READ/FIND body text as an ordinary NOTE before retrieval. Patterns belong
  on the header; below-header pattern and aside recovery are removed. Replace the
  NOTE legend with ordinary addressable NOTE receipts.

### Patch Changes

- Updated dependencies [84c0d49]
- Updated dependencies [1c19a58]
  - @plurnk/plurnk-contracts@4.1.0

## 4.0.0

- **Breaking:** remove LOOK and the client-only parser tier. Use
  `parseStatements` instead of `parseClient`; `ParseResult` and `ParseItem`
  are no longer generic. Client statements share the ordinary operation contract.
- Parse failures retain the attempted verb and exact statement for faithful
  protocol diagnostics, without changing the model's packet body or weight.
- Explicitly shaped executor invocations parse before their runtime is available;
  ordered dispatch resolves the current registry and permissions. Unknown slotless
  fences and quoted examples remain inert.
- Executor heading JSON is always input; metadata uses its bracketed slot.
  Remove the MIME-dependent `jsonBodyExecutors` parser option.
- Uses contracts 4.0.

## 3.0.3

### Patch Changes

- Third-party dependencies pulled forward to their latest stable versions: the
  AI SDK providers and `ai`, the MCP SDK, the OpenTelemetry packages, `express`,
  `music-metadata`, `smol-toml`, `web-tree-sitter`, `xpath`, `zod`, and the
  Models.dev catalog snapshot. `json-p3` stays at 2.3.1 while its newer archive
  requires a TypeScript compiler in production installs.
- Updated dependencies [960777f]
- Updated dependencies [f383d7d]
- Updated dependencies [0b7f8b1]
- Updated dependencies [42058d0]
- Updated dependencies [c8b3bb9]
  - @plurnk/plurnk-contracts@3.2.0

## 3.0.2

### Patch Changes

- 81f49f6: Report refused range syntax without inventing a replacement query. Resolve
  operator grammar filenames relative to the daemon's working directory.
- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
  - @plurnk/plurnk-contracts@3.1.0

## 3.0.1

### Major Changes

- c053b24: Diagnostics say what happened, never why. An operation that takes no body names
  the lines it did not use instead of suggesting a pattern; a refused heading,
  scope or matcher carries the construct's working form instead of a rewrite of
  the input; advisories no longer name forms the parser did not apply.
- 85bcf56: Make parameterless KILL start the literal final-answer region. Everything after
  its heading belongs to the answer; an early closing fence can no longer discard
  the remainder or expose executable operations. Place operations before KILL.
  Targeted KILL and completion checks retain their existing behavior.

### Patch Changes

- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [69f3ffe]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-contracts@2.0.0

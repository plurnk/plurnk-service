# @plurnk/plurnk-providers

## 6.1.1

### Patch Changes

- Enable conversation-history prompt caching (`PLURNK_PROVIDERS_CACHE_WRITE_POLICY=conversation`) across Anthropic, OpenRouter Anthropic, and Bedrock Claude, scope provider package discovery to `@plurnk/*`, remove `PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS`, canonicalize Heredoc Code Mode (`<<<EOF`) and `{ text }` operation payloads, and lower the packet token floor to `~3,035` (#1412 #1419 #1420 #1421 #1422 #1423 #1424 #1425 #1426 #1427 #1428 #1429 #1430 #1431 #1432 #1433 #1434 #1435 #1436 #1437 #1438 #1439 #1441 #1444 #1450 #1451).

  ### Operator Migration Guide (5.x to 6.0.0)

  - **Upgrade client and daemon together:** Upgrade `@plurnk/plurnk` and `@plurnk/plurnk-service` to `6.0.0`.
  - **SQLite Schema Migrations (`015`–`018`, `{§db-migrations}`):** Chapters `015_session_message_keys.sql` (`session_messages` composite foreign keys and cascade deletes), `016_drop_unused_columns.sql` (retiring unused `streams.metadata`, `streams.lifetime`, `sessions.CompactionSummary`, `sessions.CompactionThroughLoop`, and `turns.parse_advisory` columns), `017_pending_derivation_indexes.sql` (partial indexes for incremental `SearchIndex.maintain`), and `018_content_dedup_payloads.sql` (interning `turn_sources` and `log_entries` payloads into `contents`) run automatically in place on any database at or above the `5.0.0` support floor (`user_version >= 11`).
  - **Removed Configuration Knobs (`{§configuration-panel}`):** `PLURNK_SERVICE_PROMPT_PREVIEW`, `PLURNK_SERVICE_LOG_BUDGET_SUMMARY`, and `PLURNK_PROVIDERS_PROVIDER_CLOUDFLARE_WORKERS_AI_REASONING_EFFORTS` are retired; remove them from `.env` files if present.
  - **Model-Facing Heredoc Syntax (`{§code-grammar}`):** Multiline string values in Code Mode use `<<<EOF` heredoc delimiters, and `note`, `send`, `work`, `fork`, `done`, `fail`, and `kill` carry their body in `text`.
- Updated dependencies
  - @plurnk/plurnk-contracts@7.4.0

## 6.1.0

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
  - @plurnk/plurnk-meta@2.2.0

## 6.0.3

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
- Updated dependencies [4c9309c]
  - @plurnk/plurnk-contracts@7.2.0

## 6.0.2

### Patch Changes

- - Add the `personas` Functionality family (`persona://<name>/PERSONA.md`, `plurnk:///personas/personas.md`, `plurnk_personas`, and `workspace.personas.*` ACP actions) with `EDIT` and `KILL` support on `persona://` and `--persona` in `orientation` (`#1371`).
  - Export the closed `LOG_ENTRY_KINDS` union and `isLogEntryKind` guard from `@plurnk/plurnk-contracts`, simplify `logEntry.sql` and `TurnSources.sql` to direct column projections, and omit the redundant `NOTE` packet row object when the note emission is already materialized in the packet (`#1372`, `#1373`, `#1374`, `#1376`, `#1377`).
  - Reconcile ACP stream, `WAIT`, descendant replay, history-ceiling, and passive `session/resume` contracts and specifications (`#1375`, `#1378`, `#1379`).
  - Verify route-dependent provider credentials (`plurnk-service config verify`), scope the packaged systemd unit to `--user`, and erase retired GBNF and grammar-rail support (`#1363`, `#1364`, `#1365`, `#1366`, `#1367`, `#1369`, `#1370`).
- Updated dependencies
  - @plurnk/plurnk-contracts@7.1.0

## 6.0.1

### Patch Changes

- Emit ACP `WAIT` and `WORK`/`FORK` completion events, order streamed `output_rx` chunks after `tool_call`, scope `notice/event` to its owning session, project session-wide aggregate spend and parked loop state (`#1356`), replace compound `PLURNK_PROVIDERS_COST` with scalar `PLURNK_PROVIDERS_COST_<CATEGORY>` knobs, wire cost estimation into `compatibleProvider`, restore OpenAI-compatible streaming usage and normalize `llama-server` `timings` and `reasoning_content` chunk counts, and clarify curation phrasing on `plurnk.md` (`#1357`).

## 6.0.0

### Major Changes

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
  - @plurnk/plurnk-models@4.0.0

## 5.0.2

### Patch Changes

- Replace per-`(principal, threadId)` worker ownership with a single workspace-scoped operator owner (`agui://operator`), derive owner interactivity from the live union of attached AG-UI client Runs in the workspace, deliver proposal and `question` interrupts across every attached client Run with idempotent resolution convergence, and refresh the Models.dev snapshot to `@opencode-ai/models@0.0.114` (#1231).

## 5.0.1

### Patch Changes

- c30873c: Pull external runtime and protocol dependencies across the platform
  constellation to their latest stable releases, including
  `@modelcontextprotocol/client` and `@modelcontextprotocol/core` `2.4.0`,
  `json-p3` `^3.0.1`, `ai` `7.0.152` and its `@ai-sdk/*` providers,
  `eventsource-parser` `^4.1.2`, `linkedom` `^0.18.14`, `marked` `^18.1.1`,
  `music-metadata` `^12.2.3`, and `zod` `^4.6.7` (#1227).
- 2b882f9: Translate the calibrated curation budget additively by measured overhead
  without extrapolating unmeasured content, remove daemon-side row shedding at
  the context wall, resolve `PLURNK_PROVIDERS_OUTPUT_FLOOR` percentages against
  the effective output ceiling, and refuse model changes whose calibrated budget
  cannot hold the worker's current context with `413 context-exceeds-model-budget`
  ({§tokenomics-calibrated-readout}, {§context-wall}, {§provider-output-floor},
  {§session-model-selection}) (#1225).

## 5.0.0

### Major Changes

- 72cfbc3: A detected llama-server route admits `off` and `adaptive`. A fixed effort needs
  `PLURNK_PROVIDERS_REASONING_EFFORTS` (alias form `_<alias>`) naming the levels
  its chat template distinguishes; an undeclared fixed `PLURNK_PROVIDERS_EFFORT`
  is refused at construction. A compatible route without a template refuses a
  fixed effort without naming a declaration (#1200).

### Patch Changes

- 19df83f: Specifications: every extension handler states its contract in a shipped
  `SPEC.md`; READMEs reduced to usage; new tags for the aliases cascade, the
  result-shape guards, the card read per wake and the llama-server effort posture.
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

## 4.0.0

### Major Changes

- 5450069: The finish reason is the AI SDK's unified classification; the raw vendor value
  rides beside it. A finish the SDK classifies as `error` fails the attempt as
  `generation_failed` (502, not re-issued; Core settles it on the provider
  response contract). The dropped-output rule, its `output_dropped` kind and
  `PLURNK_PROVIDERS_DROPPED_OUTPUT_TOKENS` are gone: billed output tokens are
  accounting, never evidence of missing text, so a completed answer is admitted
  with absent, summarized or verbatim reasoning (#1156, #1157).

### Patch Changes

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 3.0.3

- Align worker terminology and the contracts 4.0 dependency without changing
  provider routing or tuning.

## 3.0.2

### Patch Changes

- f044435: A request cancelled through a shared abort signal keeps its own failure
  evidence: the SDK now rejects every request on that signal with the same reason
  object, so the transport wraps it per request before keying evidence on it.
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

## 3.0.1

### Patch Changes

- a77e136: Read one fresh environment snapshot per alias projection instead of repeatedly
  enumerating host variables for every knob, preserving precedence and live edits.
- 7de7f76: Link packet and physical-request evidence through readable Markdown. Preserve
  failure and missing-evidence distinctions; support opt-in capture of final
  SDK-dispatched request bodies while omitting headers and URL details.
- 1d585b4: Render each notice in the model packet as one alert callout in the card's own
  form: the level picks the callout, an optional `directive` (`YOU MUST`,
  `YOU SHOULD`, ...) leads, then the factual message and the kind. Notices about
  the model's own output carry a directive; environment notices carry none.
- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
- Updated dependencies [9f8e27b]
  - @plurnk/plurnk-contracts@3.1.0
  - @plurnk/plurnk-meta@2.1.0

## 3.0.0

### Major Changes

- 8d9fb11: `RequestFields.rejectRetired` is removed. The providers package reads only its
  declared keys; it names no other key to refuse it.
- 06960fc: The provider notice `grammar_unenforced` is now `output_unaccounted`, and its
  message states the two counts: the output tokens billed and the tokens visible
  across content and reasoning.

### Patch Changes

- 85bcf56: Pin the AI SDK runtime and provider adapters to the verified dependency
  versions, preserving the tested SDK selection in fresh consumer installs.
- 503ea87: A `PLURNK_*` key the operator's configuration file sets and no installed package
  declares is named at startup and by `config check`; nothing is refused.
  Each package panel declares the key families it reads by computed name, such as
  `# PLURNK_MCP_<alias>=<definition>`.
- 85bcf56: Bind worker approvals to durable owners, inherited by child workers. Client
  attachments declare their supported interaction tools; reconnecting owners can
  resume pending approvals. Explicit control attachment may claim runtime-owned
  work but does not silently transfer another client's ownership.
  
  Replace per-loop proposal and attendance policy with server approval settings
  and owner capabilities. A2A contexts now descend from `PLURNK_A2A_PARENT_WORKER`
  (default `_plurnk`); `PLURNK_A2A_PROPOSALS` is retired. Schedule definitions no
  longer accept loop policy. Existing databases upgrade in place.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-models@3.0.0

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
  - @plurnk/plurnk-aliases@2.0.0
  - @plurnk/plurnk-models@2.0.0

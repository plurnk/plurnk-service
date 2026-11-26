# @plurnk/plurnk-skills

## 3.2.0

### Minor Changes

- 8032dbd: Enforce unified physical `realpath` containment for local project-scoped skill
  and persona sources (`path-containment.ts` in `@plurnk/plurnk-meta`), and
  advertise registered Functionality `families` in `daemonPolicy()` (#1567, #1569).
- 4563cf3: Add operator confinement controls (`PLURNK_SKILLS_WORKSPACE_SOURCES`,
  `PLURNK_SKILLS_PUBLIC_ONLY`) and project-root symlink containment for Agent
  Skills, publishing skills policy via `daemonPolicy()` and ACP (#1565).

### Patch Changes

- Updated dependencies [f4c6ae9]
- Updated dependencies [8032dbd]
  - @plurnk/plurnk-meta@4.1.0

## 3.1.0

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

### Patch Changes

- d006146: Align exterior actor admission and slash-command boundaries (`#1553`, `#1555`,
  `#1557`), expose `log.read` loop-window parameters, mark `/script`
  terminal-only, enforce `PLURNK_PROVIDERS_RAWBODY` as `0 | 1`, rename
  `PLURNK_META_ACCEPTANCE_TIMEOUT_MS`, and erase post-`#1550` `.items`/`.enabled`
  compatibility shims (`#1559`).
- Updated dependencies [b7af995]
- Updated dependencies [0ec73cf]
- Updated dependencies [26a53d2]
- Updated dependencies [c944ab3]
- Updated dependencies [fedefcf]
- Updated dependencies [380eec0]
- Updated dependencies
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
  - @plurnk/plurnk-agent-skills@2.1.0

## 3.0.10

### Patch Changes

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
- Updated dependencies
- Updated dependencies
  - @plurnk/plurnk-contracts@9.0.0
  - @plurnk/plurnk-meta@3.0.0

## 3.0.9

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

## 3.0.5

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

## 3.0.4

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

## 3.0.3

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

## 3.0.2

- Report aliases in flight and honor host cancellation during preparation.
  Cleanup completes before shutdown disposal; real failures remain visible.
- Preserve native ECMAScript resource management for Node 26.
- Uses contracts/modules 4.0.

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

### Patch Changes

- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
- 8d9fb11: Retired names, settings and shapes are erased; nothing recognizes them to refuse
  or translate them. A setting the package does not read is inert, and an
  undeclared value fails through the package's ordinary check.
- 8d9fb11: Model-facing documents describe a proposal as reviewed by the worker's owner
  unless `PLURNK_SERVICE_PROPOSALS` accepts or rejects it.
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

- Move Skills ownership to `@plurnk/plurnk-skills` and reporting to
  `@plurnk/plurnk-digest`. The service no longer exports `Skill`, `/digest`, or
  `/share`. Reporting consumers import the named `Digest` and `Share` exports from
  `@plurnk/plurnk-digest` and supply `openEvidence: EvidenceReader.open`, with
  `EvidenceReader` imported from `@plurnk/plurnk-service/evidence`.

  Rename `PLURNK_SERVICE_SKILLS_FETCH_TIMEOUT_MS` to
  `PLURNK_SKILLS_FETCH_TIMEOUT_MS`, and `PLURNK_SERVICE_REQUIEM_MAX_TOKENS` and
  `PLURNK_SERVICE_REQUIEM_RETRY_MAX_TOKENS` to `PLURNK_DIGEST_REQUIEM_MAX_TOKENS`
  and `PLURNK_DIGEST_REQUIEM_RETRY_MAX_TOKENS`. Retired names are rejected rather
  than maintained as aliases. The CLI's `share` command remains unchanged, and
  existing databases are upgraded in place.
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
  - @plurnk/plurnk-agent-skills@2.0.0
  - @plurnk/plurnk-agent-plugins@2.0.0
  - @plurnk/plurnk-schemes@2.0.0

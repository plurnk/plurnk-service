# @plurnk/plurnk-mimetypes

## 3.1.0

### Minor Changes

- 91be321: Decouple `@plurnk/plurnk-mimetypes/runtime` from eager structural query
  toolkits (`json-p3`, `@xmldom/xmldom`, `xpath`), lazy-load `@plurnk/plurnk-digest`
  and `EvidenceReader` in daemon/CLI share paths, lazy-load `OidcVerifier` (`jose`)
  in `@plurnk/plurnk-auth`, and defer `@modelcontextprotocol/client` / `server` /
  `core` inside `@plurnk/plurnk-mcp` until MCP connections or `/mcp` requests
  actually run (#1578).
- 6417e49: Reduce cold-boot, CLI-command, and workspace-activation memory footprint
  (#1582):
  
  - Set `NODE_OPTIONS=--max-semi-space-size=4` and `MALLOC_ARENA_MAX=2` in
    `plurnk-core/plurnk.service` and document V8 semi-space/old-space/arena
    tuning in `plurnk-core/INSTALL.md`.
  - Export `BaseHandler`, `HandlerContent`, and `projectJsonToXml` from
    `@plurnk/plurnk-mimetypes/runtime` and migrate built-in leaf mimetype
    handlers off the eager barrel onto `/runtime`, deferring structural query
    imports until invoked.
  - Lazy-load `yaml` on first frontmatter parse in `@plurnk/plurnk-agent-skills`
    and `@plurnk/plurnk-mimetypes-text-markdown`.
  - Dynamically import `Daemon`, `HttpListener`, `ServiceModules`, and
    `ProviderInstantiate` in `plurnk-core/src/service.ts` so CLI control commands
    avoid booting the full daemon and ACP graph.

### Patch Changes

- Updated dependencies [eb0293a]
- Updated dependencies [12055f7]
- Updated dependencies [9319f97]
- Updated dependencies [1f24586]
- Updated dependencies [3d53337]
  - @plurnk/plurnk-contracts@11.0.0

## 3.0.11

### Patch Changes

- fedefcf: Default the `:1066` loopback listener to zero-password access with browser
  same-origin CSRF and loopback DNS-rebinding defenses (`admitBrowserOrigin`),
  retire the in-daemon OAuth 2.1 server, password hashing, and host
  `secret`/`credentials` files, and repurpose `@plurnk/plurnk-auth` into an
  optional `jose`-backed external OIDC / OAuth 2.1 resource server
  (`PLURNK_AUTH_ISSUER`, `PLURNK_AUTH_CLIENT_ID`, `PLURNK_AUTH_AUDIENCE`,
  `PLURNK_AUTH_CALLBACK`, `PLURNK_AUTH_SCOPES`, `PLURNK_AUTH_USERS`) serving
  RFC 9728 `/.well-known/oauth-protected-resource` (#1547).
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
  - @plurnk/plurnk-meta@4.0.0

## 3.0.10

### Patch Changes

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
- Updated dependencies
  - @plurnk/plurnk-contracts@7.4.0

## 3.0.7

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

## 3.0.6

### Patch Changes

- c30873c: Pull external runtime and protocol dependencies across the platform
  constellation to their latest stable releases, including
  `@modelcontextprotocol/client` and `@modelcontextprotocol/core` `2.4.0`,
  `json-p3` `^3.0.1`, `ai` `7.0.152` and its `@ai-sdk/*` providers,
  `eventsource-parser` `^4.1.2`, `linkedom` `^0.18.14`, `marked` `^18.1.1`,
  `music-metadata` `^12.2.3`, and `zod` `^4.6.7` (#1227).

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

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 3.0.3

- Update compatible dependency ranges: `@plurnk/plurnk-contracts@4.0.0`.

## 3.0.2

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

## 3.0.1

### Patch Changes

- d6fe979: Keep reference queries as packaged Tree-sitter query assets, loaded through
  the existing lazy language mappings without changing extraction semantics.
- 705eff4: Preserve JSONPath evaluation failures instead of reporting valid expressions as
  malformed.
- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
- Updated dependencies [9f8e27b]
  - @plurnk/plurnk-contracts@3.1.0
  - @plurnk/plurnk-meta@2.1.0

## 3.0.0

### Major Changes

- 8d9fb11: `HandlerInfo.attribution` is removed; discovery's `packageAttributions` carries
  every package's tags. The `./conformance` exports `QueryLineCase`,
  `QueryConformanceHandler` and `assertQueryLineConformance` are removed.

### Patch Changes

- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
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

- Retire family-wide dependency freshness scanning; packages declare independent compatibility.
- Preserve ANTLR missing-token recovery nodes without fabricating exact source coordinates.

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

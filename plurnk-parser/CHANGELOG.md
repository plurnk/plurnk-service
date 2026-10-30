# @plurnk/plurnk-parser

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

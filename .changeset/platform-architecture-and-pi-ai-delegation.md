---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-providers": major
"@plurnk/plurnk-models": major
"@plurnk/plurnk-spec-check": minor
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-service": major
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-mimetypes": patch
"@plurnk/plurnk-mimetypes-application-ipynb": patch
"@plurnk/plurnk-mimetypes-application-json": patch
"@plurnk/plurnk-mimetypes-application-jsonl": patch
"@plurnk/plurnk-mimetypes-application-pdf": patch
"@plurnk/plurnk-mimetypes-application-xml": patch
"@plurnk/plurnk-mimetypes-audio": patch
"@plurnk/plurnk-mimetypes-image": patch
"@plurnk/plurnk-mimetypes-text-csv": patch
"@plurnk/plurnk-mimetypes-text-diff": patch
"@plurnk/plurnk-mimetypes-text-dotenv": patch
"@plurnk/plurnk-mimetypes-text-html": patch
"@plurnk/plurnk-mimetypes-text-ini": patch
"@plurnk/plurnk-mimetypes-text-markdown": patch
"@plurnk/plurnk-mimetypes-text-plain": patch
"@plurnk/plurnk-schemes": patch
"@plurnk/plurnk-schemes-http": patch
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-execs-common": patch
"@plurnk/plurnk-parser": patch
"@plurnk/plurnk-digest": patch
"@plurnk/plurnk-meta": patch
"@plurnk/plurnk-aliases": patch
"@plurnk/plurnk-agent-plugins": patch
"@plurnk/plurnk-agent-skills": patch
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-modules": patch
"@plurnk/plurnk-hooks": patch
"@plurnk/plurnk-otel": patch
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-auth": patch
---

Delegate model catalog discovery and provider streaming directly to
`@mariozechner/pi-ai` (`#1286`, `#1305`), restrict `service.update` to model
catalog refresh (`#1285`), allow trusted third-party
`@plurnk/plurnk-mimetypes-*` packages to override built-in floor handlers
(`#1306`), keep ACP SSE streams alive with `heartbeatMs` and restore
disconnect/gate-transfer integration coverage (`#1307`, `#1308`), unify
`ApplicationPort` and domain modules (`#1287`–`#1304`, `#1312`), enforce
heading-only `§tag` declarations and dual witnesses in `plurnk-spec-check`
(`#1283`, `#1309`, `#1311`), and complete ACP v2, MCP v2 Open Work, SEP-2640
Skills over MCP, and multi-tier customization parity (`#654`, `#1332`–`#1351`).

### Operator Migration Guide (4.x to 5.0.0)

- **SQLite Schema Baseline (`{§db-migrations}`):** 34 incremental chapters
  (`user_version = 34` in `v4.3.3`) are folded into an 11-chapter baseline
  (`001`–`011`, `user_version = 11`) with a support-floor guard. Point
  `PLURNK_SERVICE_DB_PATH` at a new file or move the pre-5.0 database and its
  `-wal` and `-shm` sidecars aside once every daemon holding it has stopped.
- **Session & Workspace Addressing (`{§session-scheme}`):** `worker://<name>` is
  renamed to `session://<name>`, `workspace:///` holds shared workspace scratch
  entries, and `plurnk:///` and `mcp:///` serve generated daemon, tool, and MCP
  server reference documents. Update references from `worker://` to `session://`
  and `_plurnk/...` to `plurnk:///...` or `mcp:///...`.
- **Client & External Protocols (`{§acp-endpoint}`):** A2A (`plurnk-a2a`) and
  AG-UI (`plurnk-agui`) are retired in favor of ACP v2 (`/acp` via
  `@plurnk/plurnk-acp`) and OAuth 2.1 (`@plurnk/plurnk-auth`). Upgrade
  `@plurnk/plurnk` to `5.0.0`.
- **Built-in Executors (`{§executor-role}`) & Family Tools (`{§functionality-model-projection}`):**
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

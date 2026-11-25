# mcp

An enabled MCP server is callable under its `server` name and exposes its catalog at `mcp:///<server>.md` (tool index), `mcp:///<server>/<tool>.json` (per-tool schema), and `mcp:///<server>.json` (`{"tools":[...]}`). Inspect a single tool definition from `mcp:///<server>.json` via `read` with JSONPath (for example `{"path": "mcp:///files.json", "pattern": "$.tools[?(@.name==\"list_directory\")]"}`).

## discover, then add

| `mcp` (on `plurnk`) arguments | Effect |
| --- | --- |
| `{}` (or `{"query"?, "state"?, "origin"?, "offset"?, "limit"?}`) | List servers (active, disabled, or `unavailable` with exact Problem and connection diagnostic), optionally filtered and paginated. |
| `{"alias": "files"}` | Inspect one server definition (read-only; `404` when absent). |
| `{"discover": true}` / `{"discover": "<query>", "cursor"?, "limit"?}` | Browse or search the configured MCP Registry and return addable candidate definitions without persisting. |
| `{"alias": "files", "type": "stdio", "command": "npx", "args"?: [...], "env"?: {...}, "cwd"?: "..."}` | Save, enable, and connect a local stdio server (complete replacement; omitted fields do not inherit). |
| `{"alias": "remote", "type": "streamable-http", "url": "https://example.com/mcp", "headers"?: {...}, "authorization"?: {...}}` | Save, enable, and connect a remote HTTP server (returns `202` with `state: "authorization-required"` when OAuth sign-in is required; the daemon never opens a browser — the operator completes sign-in via `/mcp oauth <alias>` or Settings before tools activate). |
| `{"alias": "files", "enabled": false}` | Disconnect and withdraw tools (`false`) or reconnect (`true`) without deleting the definition. |
| `{"alias": "files", "remove": true}` | Remove a workspace override and restore any inherited definition. |

## Sources, environment, and inbound work

- **Precedence**: workspace override > `PLURNK_MCP_<alias>` > `.agents/mcp.json` > `$XDG_CONFIG_HOME/plurnk/mcp.json` > `$XDG_CONFIG_HOME/agents/mcp.json` > `~/.agents/mcp.json`.
- **Environment & `${NAME}` expansion**: stdio servers automatically inherit non-`PLURNK_*`/non-provider host variables plus workspace `env` entries (omit optional runtime variables from `env`; `disable` then `enable` restarts with updated workspace `env`). `mcp.json` and workspace `mcp` definitions expand `${NAME}` (including `PLURNK_WORKSPACE`, `PLURNK_SESSION`, `PLURNK_PROJECT_ROOT`, `PLURNK_STATE_DIR`, or set provider keys like `"env": {"GEMINI_API_KEY": "${GEMINI_API_KEY}"}`) in `args`, `env`, `cwd`, `headers`, and `authorization` and fail launch when `${NAME}` is unset.
- **Inbound work & subscriptions**: `PLURNK_MCP_<alias>_WORKSPACE` / `plurnkWorkspace` and `PLURNK_MCP_<alias>_SESSION` / `plurnkSession` route inbound `sampling/createMessage` requests to `<server>:///messages/<id>` (answered with `done` or `fail`). Reading `<server>:///resources/<uri>` opens a subscription stream that wakes the session on `notifications/resources/updated`.

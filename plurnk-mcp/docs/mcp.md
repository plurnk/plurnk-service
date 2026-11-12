# mcp

An enabled MCP server is a runtime under its own name (`<server>.<tool>({ ... })`) and exposes its catalog at `mcp:///<server>.md` (tool index), `mcp:///<server>/<tool>.json` (per-tool schema), and `mcp:///<server>.json` (`{"tools":[...]}`).

files.list_directory({ path: "/absolute/project/path" })

plurnk.read({ path: "mcp:///files.json", pattern: "$.tools[?(@.name==\"list_directory\")]" })

## discover, then add

| Call | Effect |
| --- | --- |
| `plurnk.mcp({})` | List servers (active, disabled, or `unavailable` with exact Problem and connection diagnostic). |
| `plurnk.mcp({ discover: "<query>" })` | Search the configured MCP Registry by name and return addable candidate definitions without persisting. |
| `plurnk.mcp({ name, type: "stdio", command, args?, env?, cwd? })` | Save, enable, and connect a local stdio server (complete replacement; omitted fields do not inherit). |
| `plurnk.mcp({ name, type: "streamable-http", url, headers?, authorization? })` | Save, enable, and connect a remote HTTP server (holds for OAuth sign-in when required). |
| `plurnk.mcp({ name, enabled: false })` | Disconnect and withdraw tools (`false`) or reconnect (`true`) without deleting the definition. |
| `plurnk.mcp({ name, remove: true })` | Remove a workspace override and restore any inherited definition. |

plurnk.mcp({ name: "files", type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/project/path"] })

`plurnk.mcp({ name: "remote", type: "streamable-http", url: "https://example.com/mcp" })`

## Sources, environment, and inbound work

- **Precedence**: workspace override > `PLURNK_MCP_<alias>` > `.agents/mcp.json` > `$XDG_CONFIG_HOME/plurnk/mcp.json` > `$XDG_CONFIG_HOME/agents/mcp.json` > `~/.agents/mcp.json` (plus enabled Agent Plugin `mcp.json` files, which receive `PLUGIN_ROOT` and `PLUGIN_DATA`).
- **Environment & `${NAME}` expansion**: stdio servers automatically inherit non-`PLURNK_*`/non-provider host variables plus workspace `plurnk.env` entries (omit optional runtime variables from `env`; `disable` then `enable` restarts with updated workspace `env`). Native `mcp.json` / `plurnk.mcp` definitions expand `${NAME}` (including `PLURNK_WORKSPACE`, `PLURNK_SESSION`, `PLURNK_PROJECT_ROOT`, `PLURNK_STATE_DIR`, or set provider keys like `"env": {"GEMINI_API_KEY": "${GEMINI_API_KEY}"}`) in `args`, `env`, `cwd`, `headers`, and `authorization` and fail launch when `${NAME}` is unset; plugin `mcp.json` expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`.

`plurnk.env({ name: "SERVICE_TOKEN", value: "<credential>" })`

- **Inbound work & subscriptions**: `PLURNK_MCP_<alias>_WORKSPACE` / `plurnkWorkspace` and `PLURNK_MCP_<alias>_SESSION` / `plurnkSession` route inbound `sampling/createMessage` requests to `<server>:///messages/<id>` (answered with `plurnk.done` or `plurnk.fail`). Reading `<server>:///resources/<uri>` opens a subscription stream that wakes the session on `notifications/resources/updated`.

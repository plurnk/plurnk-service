# @plurnk/plurnk-mcp

[Model Context Protocol](https://modelcontextprotocol.io/) outbound host and inbound `/mcp` server module for [`@plurnk/plurnk-service`](https://github.com/plurnk/plurnk-service). Wire authority: revision `2026-07-28` with negotiate-and-degrade peer support ({§mcp-authority}). Contract: [`SPEC.md`](./SPEC.md). Knobs: [`.env.defaults`](./.env.defaults).

## Configure outbound servers ({§mcp-configuration})

Precedence (whole-entry replacement): workspace overrides > `PLURNK_MCP_<alias>` env > `.agents/mcp.json` > `$XDG_CONFIG_HOME/plurnk/mcp.json` > `~/.agents/mcp.json` > Agent Plugins (`plugin.json` `mcp.json`).

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/abs/path"] },
    "forge": { "type": "streamable-http", "url": "https://forge.example/mcp", "headers": { "Authorization": "Bearer ${FORGE_TOKEN}" } }
  }
}
```

```dotenv
PLURNK_MCP_brave={"type":"stdio","command":"npx","args":["-y","@brave/brave-search-mcp-server@2.1.0"]}
PLURNK_MCP_brave_TOOLS=["brave_web_search","brave_news_search"]
PLURNK_MCP_forge_ENABLED=0
```

| Transport / Knob | Behavior |
|---|---|
| `stdio` | Spawns `command` + `args` without a shell in a workspace-owned state directory (unless absolute `cwd` is set); strips `PLURNK_*` and provider API keys, layers workspace `env` + server `env` ({§mcp-module}). |
| `streamable-http` | Connects to `url` with `headers` or `authorization` (`${VAR}` expanded at connect; redirects refused, {§mcp-transports}). |
| `PLURNK_MCP_ENABLED` / `PLURNK_MCP_<alias>_ENABLED` | Family and per-server enabledness (`_` encodes `-` in lowercase `<alias>`). |
| `PLURNK_MCP_<alias>_TOOLS` | JSON array of enabled tool names (`[]` enables none; unset/empty enables all). |
| `PLURNK_MCP_<alias>_WORKSPACE` / `_SESSION` | Scope bindings for inbound/outbound routing ({§mcp-configuration}). |
| `PLURNK_MCP_REGISTRY_URL` / `_LIMIT` | MCP Registry discovery endpoint (empty disables `discover`) and result cap. |

Tools with `annotations.readOnlyHint` run with `effect: "read"`; all others use `effect: "host"` (proposal-gated).

## Workspace management & model projection

| Surface | Form |
|---|---|
| `_plurnk/action` / `plurnk.mcp(...)` | `list`, `discover` (`query`), `add` / `replace` (`alias` + connection), `enable` / `disable` / `remove` (`alias`), `oauth.begin` (`alias`, `redirectUri`), `oauth.complete` (`alias`, `callbackUrl`), `complete` (`server`, `ref`, `argument`). |
| ACPv2 toggle | `session/set_config_option` (`mcp:<alias>`). |
| Tool teaching & schemas | `mcp:///<server>.md` summary (`plurnk.mcp({})`), `mcp:///<server>.json` catalog, and `mcp:///<server>/<encoded-tool>.json` full JSON Schema ({§tools-resource-materialization}). |
| Enabled tool call | `<server>.<tool>({ ... })` statement; media/embedded outputs land under `resources/`, raw wire output under `#json`. |
| Server resources & prompts | `<server>:///resources/<encoded-uri>` and `<server>:///prompts/<encoded-name>?arg=val` via `plurnk.find` and `plurnk.read`. |

## Interactive OAuth & credentials ({§oauth-continuation})

| Stage | Behavior |
|---|---|
| Challenge | Anonymous 401/refusal marks the alias `authorization-required` without publishing partial tools ({§mcp-host-composition}). |
| Initiation | `/mcp oauth <alias>` binds an ephemeral loopback port and calls `workspace.mcp.oauth.begin` (PKCE `S256`; optional `authorization.issuer` and `authorizationParams`). |
| Completion | `workspace.mcp.oauth.complete` returns `202`; tools publish at the next between-turn workspace boundary. |
| Persistence & refresh | Grants persist encrypted (`0600` AES-256-GCM outside SQLite), survive restarts, and auto-refresh until revoked, re-keyed (`PLURNK_SECRET`), or redefined. `list` exposes `detail.grant` metadata only, never tokens. |
| Client elicitation | Multi-turn server input uses ACPv2 `elicitation/create` and `session/resume`. |

## Inbound `/mcp` server ({§mcp-http-server})

| Route | Target binding |
|---|---|
| `/mcp` | Workspace `default` (or first unarchived), session `user` (or first model session). |
| `/mcp/<workspace>` | Named/numeric workspace (auto-created when named and absent), default session. |
| `/mcp/<workspace>/<session>` | Named/numeric workspace and session (`_plurnk` binds the runtime session). |

Exposes `mcp:///plurnk.json` tools (15 VM verbs, installed executors, 6 Functionality families), static resources (`mcp:///plurnk.md`, `session:///status.json`, `log:///recent.json`), and resource templates (`log:///...`, `mcp:///plurnk/{tool}.json`, `workspace:///{+path}`) under `Bearer` (`mcp` or `acp` scope) when `PLURNK_AUTH=1`.

## Verification

```sh
npm test -w @plurnk/plurnk-mcp
```

# @plurnk/plurnk-mcp

The [Model Context Protocol](https://modelcontextprotocol.io/) host module for
[Plurnk](https://github.com/plurnk/plurnk-service). It projects the MCP servers of installed
[Agent Plugins](https://agent-plugins.org) through Plurnk's executor, resource, proposal, entry,
Problem, lifecycle, and AG-UI contracts.

The module's own wire authority is protocol revision `2026-07-28`
({§mcp-authority}). Connection setup negotiates-and-degrades: a server that
offers the pinned revision and `server/discover` gets the complete extension
wire; a server the SDK negotiated below the pin is an ordinary MCP peer that
serves its standard surface at its own negotiated revision. Plurnk does not
downgrade its own extension wire, but it does not reject an older supported
revision.

## Servers come from Agent Plugins

An MCP server is a component of an installed Agent Plugin ({§mcp-plugin-servers}): the plugin's
`mcp.json` declares it, and installing the plugin enables it. Plurnk finds plugins in three roots,
nearest first; a nearer plugin shadows a server of the same name ({§agent-plugins-hosting}).

| Root | Seen by |
|---|---|
| `<project>/.agents/plugins/<plugin>/` | that project's workspaces |
| `$XDG_CONFIG_HOME/plurnk/plugins/<plugin>/` | Plurnk alone |
| `~/.agents/plugins/<plugin>/` | every Agent Plugins host |

A plugin directory holds its manifest, `plugin.json`:

```json
{ "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "name": "search" }
```

and its servers, `mcp.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "brave": { "type": "stdio", "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server@2.1.0"] },
    "forge": { "type": "streamable-http", "url": "https://forge.example/mcp" }
  }
}
```

The member name is the server's alias: the model's fence and the server's resource scheme, so it must
match `[a-z][a-z0-9-]*`. An `sse` entry, an unrepresentable name, and a shadowed alias are skipped
and reported in the daemon's diagnostics. A plugin added, changed, or removed is reflected at the
next turn, without a restart.

| Transport | Behaviour |
|---|---|
| `stdio` | `command` is a bare name found on `PATH` or a `./` path inside the plugin. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand in `args`, `env`, and `cwd`. The server starts in the plugin root unless `cwd` names a directory inside the plugin or its data. `PLUGIN_DATA` is `$XDG_DATA_HOME/plurnk/plugins/<plugin>`, created before launch and kept across restarts. |
| `streamable-http` | `url` with literal `headers`. Plurnk's own `Authorization`, `Accept`, `Content-Type`, `Last-Event-ID` and `Mcp-*` headers win over configured ones, and a redirect is refused ({§mcp-redirect-refused}). |

A local server inherits the operator's environment, as every MCP client launches one, because stdio
servers read their credentials from it; Plurnk's own settings and provider keys are withheld. The
workspace's `env` family applies on top, then the entry's `env` ({§mcp-launch-environment}).

A tool whose `annotations.readOnlyHint` is true runs with Plurnk's `read` effect. Every other tool
keeps the `host` effect and runs under the loop's proposal policy.

## Manage a workspace's servers

MCP is one family of workspace Functionality, managed with the six verbs every family has
({§mcp-management-actions}).

| Action | Parameters |
|---|---|
| `workspace.mcp.list` | — |
| `workspace.mcp.discover` | `query`: searches the MCP Registry ({§mcp-registry-discovery}) |
| `workspace.mcp.add` | optional `alias` (the definition's `name`), `definition`: a standard entry with its `scope` |
| `workspace.mcp.enable` / `disable` / `remove` | `alias` |
| `workspace.mcp.oauth.complete` | `alias`, complete `callbackUrl` |
| `workspace.mcp.complete` | `server`, completion `ref` and `argument`; optional `context` |

`add` installs a server as a one-server plugin at its scope's root: `project` for the workspace's
project, `plurnk` for every workspace, `global` for every Agent Plugins host. `remove` uninstalls what
`add` installed; a server from any other plugin is disable-only.

An AG-UI client sends each as the ordinary management action under
`forwardedProps.plurnk.action`, and the standard `plurnk.action.result` event reports the result or
exact RFC 9457 Problem Details:

```json
{ "forwardedProps": { "plurnk": { "workspace": "example", "action": {
  "kind": "workspace.mcp.add",
  "definition": { "name": "brave", "scope": "plurnk", "type": "stdio", "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server@2.1.0"] }
} } } }
```

The model manages the same family through ````` ````mcp (list|discover|add|enable|disable|remove) `````,
each change a proposal under the loop's policy. Disabling is durable and workspace-shared; enabling an
unavailable server retries its connection.

Tool discovery uses ordinary `FIND (worker:///_plurnk/tools/*.md)` and READ.
Each server's document lists enabled tool calls with required-field previews
and links to full input schemas under `tools/<server>/<encoded-tool>.md`.
The manager uses the same layout under `plurnk/mcp.md` and `plurnk/mcp/`;
schema documents preserve descriptions and constraints without adding them to
the initial survey ({§tools-resource-discovery}).

## Operator settings

A server's plugin says how to reach it; the operator decides what to allow and how to authorize, per
alias, in `$XDG_CONFIG_HOME/plurnk/.env` ({§mcp-server-settings}). `<ALIAS>` is the alias uppercased,
its hyphens as underscores.

| Variable | Setting |
|---|---|
| `PLURNK_MCP_<ALIAS>_TOOLS` | JSON array of the enabled tool names; absent enables every tool, `[]` none |
| `PLURNK_MCP_<ALIAS>_BEARER` | A fixed bearer for a Streamable HTTP server, as one `${NAME}` reference |
| `PLURNK_MCP_<ALIAS>_OAUTH` | OAuth or client credentials for a Streamable HTTP server, as `McpOAuth` JSON ({§mcp-oauth}) |
| `PLURNK_MCP_EXPANDED` | JSON array of aliases whose every tool is surveyed at turn 0 |
| `PLURNK_MCP_REGISTRY_URL`, `PLURNK_MCP_REGISTRY_LIMIT` | The registry `discover` searches, empty for none, and the most servers one search returns |

```text
PLURNK_MCP_BRAVE_TOOLS=["brave_web_search","brave_news_search"]
PLURNK_MCP_FORGE_BEARER=${FORGE_TOKEN}
```

A secret is only ever a `${NAME}` reference to the environment, expanded while preparing a
connection, so it stays in the login shell. The former `PLURNK_MCP_<server>` definitions and
`PLURNK_MCP_ENABLED` are retired: a daemon that finds one refuses to start and names its
replacement. Timeouts and the complete catalog live in [`.env.defaults`](./.env.defaults).

## Demo fixture

Web discovery is an ordinary MCP attachment ({§web-search-retrieval}). The demo
story that researches through it adds Brave Search to its fixture project, and
runs only when `BRAVE_API_KEY` is in the environment:

```json
{ "name": "brave", "scope": "project", "type": "stdio", "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server@2.1.0"] }
```

`@brave/brave-search-mcp-server@2.1.0` pins `@modelcontextprotocol/sdk@1.29.0`,
whose latest revision is `2025-11-25` and which does not implement
`server/discover`, so the host negotiates down to its standard tool surface
({§mcp-authority}). Its tools declare `openWorldHint` but not `readOnlyHint`,
so each search runs under the proposal policy.

## Plurnk projection

| MCP surface | Plurnk surface |
|---|---|
| Server tools | `worker:///_plurnk/tools/<server>.md` family summary |
| Enabled tool | Exact `worker:///_plurnk/tools/<server>/<encoded-tool>.json` document and ````` ````server (tool) ````` |
| Resource catalog | `server:///` or `server:///resources` |
| Resource | `server:///resources/<encoded-uri>` through ordinary `FIND` and `READ` |
| Prompt catalog | `server:///prompts` |
| Prompt retrieval | `server:///prompts/<encoded-name>?argument=value` through ordinary `READ` |
| Completion | Client-owned `workspace.mcp.complete` action |
| Tool image/audio or embedded resource | A named resource beneath the invocation's `resources/`; eight hexadecimal characters when unnamed |
| Exact tool-result evidence | The invocation's `#json` channel, retrieved on demand |

Tool results, resource bodies, prompt messages, and failures become ordinary
Plurnk entries and channels. Disabled tools appear in neither teaching nor
admission. There is no MCP-specific model discovery grammar.

Results link to media rather than dumping base64. An ordinary `READ` delivers
supported images natively; other content and unsupported models retain the
text/byte view. Listing the resource alone does not attach it.

Current pagination, cache hints, unified subscriptions, progress,
cancellation, multi-round-trip input, elicitation, and negotiated Tasks remain
inside the owning operation. Client input uses the standard AG-UI interrupt and
resume lifecycle; protocol continuation state is never exposed to the model or
client.

## Authorization

HTTP servers support bearer references, client credentials, and interactive
OAuth; stdio servers read their credentials from the environment. A server that
needs interactive OAuth comes up `authorization-required`, and enabling it
returns `{ "status": 202, "authorization": { "url": "..." } }` without
publishing a partial server. After the user completes that URL, the client
submits its complete callback URL through `workspace.mcp.oauth.complete`. PKCE,
issuer and resource validation, refresh, scope escalation, and credentials
remain inside the host connection.

## Verification

```sh
npm test -w @plurnk/plurnk-mcp
npm run test:mcp:dogfood -w @plurnk/plurnk-service
```

The package gate runs the exact current SDK and official conformance
requirements. The opt-in dogfood gate composes representative current stdio
and Streamable HTTP servers through the assembled daemon and AG-UI product.

# @plurnk/plurnk-mcp

The [Model Context Protocol](https://modelcontextprotocol.io/) host module for
[Plurnk](https://github.com/plurnk/plurnk-service). It projects configured MCP servers
through Plurnk's executor, resource, proposal, entry, Problem, lifecycle, and AG-UI contracts.

The module's own wire authority is protocol revision `2026-07-28`
({§mcp-authority}). Connection setup negotiates-and-degrades: a server that
offers the pinned revision and `server/discover` gets the complete extension
wire; a server the SDK negotiated below the pin is an ordinary MCP peer that
serves its standard surface at its own negotiated revision. Plurnk does not
downgrade its own extension wire, but it does not reject an older supported
revision.

## Configure servers

Put shared servers in `~/.agents/mcp.json` ({§mcp-file-configuration}):

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/project/path"] },
    "forge": { "type": "streamable-http", "url": "https://forge.example/mcp", "headers": { "Authorization": "Bearer ${FORGE_TOKEN}" } }
  }
}
```

Project `.agents/mcp.json` overrides `$XDG_CONFIG_HOME/plurnk/mcp.json`, which
overrides that shared global file, by complete server entry. The existing
`PLURNK_SERVICE_ROOTS` selection applies. Files stay read-only; no plugin is required.

Installed Agent Plugins also contribute `mcp.json` servers through the same
workspace management. Standalone definitions precede plugin components within
each scope; npm bundles come last. Plugin subprocesses use their plugin root
and persistent data directory, with the standard's literal-string rules
({§mcp-plugin-configuration}).
`list` identifies the winning file and entry; file changes are read before the next turn.

Environment-only configuration remains available and overrides file definitions
({§mcp-configuration}); live additions persist in the workspace and override both.

```dotenv
PLURNK_MCP_brave={"name":"brave","type":"stdio","command":"npx","args":["-y","@brave/brave-search-mcp-server@2.1.0"]}
PLURNK_MCP_forge={"name":"forge","type":"streamable-http","url":"https://forge.example/mcp","authorization":{"type":"bearer","token":"${FORGE_TOKEN}"}}
```

Aliases match `[a-z][a-z0-9-]*`; environment suffixes use lowercase and
encode hyphens as underscores. The alias names both the model's executor
and the server's resource scheme. A higher-precedence definition replaces
the whole connection, including authentication; it does not patch fields.
Declaring a server enables it unless an independent control disables it.
Explicit HTTP(S) endpoints may use private-network hosts; OAuth retains its
TLS and authorization requirements ({§mcp-endpoint-security}).

| Transport | Behaviour |
|---|---|
| `stdio` | Spawn `command` and `args` without a shell. Bare commands use PATH; relative commands use the working directory. References in `args`, `env`, and `cwd` expand at launch. |
| `streamable-http` | Connect to `url`, with optional `headers` and `authorization`. Header references expand at connection time; SDK protocol headers remain transport-owned. Structured authorization and an Authorization header cannot both be declared. Redirects are refused ({§mcp-redirect-refused}). |

A local server defaults to a stable, workspace-owned state directory outside
the project ({§mcp-launch-directory}). An explicit absolute `cwd` overrides
that location; the caller provisions it. This is file placement, not a sandbox.

Stdio servers inherit the operator's environment without Plurnk settings or
model-provider keys. Workspace `env` entries apply on top, then the definition's
`env`; worker-local overrides do not ({§mcp-launch-environment}). A running
server keeps its launch environment; disable then enable it to pick up changes.

A tool marked `annotations.readOnlyHint` runs with the `read` effect;
other tools retain the `host` effect: each call is reviewed by the worker's
owner unless `PLURNK_SERVICE_PROPOSALS` accepts or rejects it.

## Manage a workspace's servers

MCP is one family of workspace Functionality, managed with the verbs every family shares
({§mcp-management-actions}); `discover` is present while the operator configures a registry.

| Action | Parameters |
|---|---|
| `workspace.mcp.list` | — |
| `workspace.mcp.discover` | `query`: searches the MCP Registry; present while `PLURNK_MCP_REGISTRY_URL` names one ({§mcp-registry-discovery}) |
| `workspace.mcp.add` | optional `alias` (the definition's `name`), `definition`: a complete connection definition |
| `workspace.mcp.enable` / `disable` / `remove` | `alias` |
| `workspace.mcp.oauth.complete` | `alias`, complete `callbackUrl` |
| `workspace.mcp.complete` | `server`, completion `ref` and `argument`; optional `context` |

`add` persists a workspace definition; `remove` undoes it, restoring any inherited
definition and enabled state. Use `disable` to suppress an inherited server.
MCP management neither installs nor deletes plugins or configuration files.

An AG-UI client sends each as the ordinary management action under
`forwardedProps.plurnk.action`, and the standard `plurnk.action.result` event reports the result or
exact RFC 9457 Problem Details:

```json
{ "forwardedProps": { "plurnk": { "workspace": "example", "action": {
  "kind": "workspace.mcp.add",
  "definition": { "name": "brave", "type": "stdio", "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server@2.1.0"] }
} } } }
```

The model manages the same family through ````` ````mcp (list|discover|add|enable|disable|remove) `````
(`discover` while a registry is configured), each change a proposal reviewed by the worker's owner unless `PLURNK_SERVICE_PROPOSALS` accepts or
rejects it. Disabling is durable and workspace-shared; enabling an unavailable server retries its
connection.

Tool discovery uses ordinary `FIND (worker:///_plurnk/tools/*.md)` and READ.
Each server's document lists enabled tool calls with required-field previews
and links to full input schemas under `tools/<server>/<encoded-tool>.md`.
The manager uses the same layout under `plurnk/mcp.md` and `plurnk/mcp/`;
schema documents preserve descriptions and constraints without adding them to
the initial survey ({§tools-resource-discovery}).

## Operator settings

Independent controls use the same lowercase alias spelling as definitions
({§mcp-server-settings}). A control may precede its server; it is validated
without creating one.

| Variable | Setting |
|---|---|
| `PLURNK_MCP_ENABLED` | Family enabledness default |
| `PLURNK_MCP_<alias>_ENABLED` | Per-server override |
| `PLURNK_MCP_<alias>_TOOLS` | JSON array of exact tool names; absent or empty enables all, `[]` none |
| `PLURNK_MCP_EXPANDED` | JSON array of servers whose complete tool menu is surveyed at turn 0 |
| `PLURNK_MCP_REGISTRY_URL`, `PLURNK_MCP_REGISTRY_LIMIT` | Discovery endpoint (empty disables search) and result bound |

```dotenv
PLURNK_MCP_brave_TOOLS=["brave_web_search","brave_news_search"]
PLURNK_MCP_forge_ENABLED=0
```

HTTP authorization belongs in the complete definition. Bearer tokens and
OAuth client secrets are symbolic `${NAME}` environment references, resolved
only when preparing a connection; interactive grants remain in memory.
See [`.env.defaults`](./.env.defaults) for all controls and
[`SPEC.md`](./SPEC.md#mcp-configuration-configuration) for the contract.

## Demo fixture

Web discovery is an ordinary MCP attachment ({§web-search-retrieval}). The demo
story that researches through it adds Brave Search to its fixture workspace, and
runs only when `BRAVE_API_KEY` is in the environment:

```json
{ "name": "brave", "type": "stdio", "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server@2.1.0"] }
```

`@brave/brave-search-mcp-server@2.1.0` pins `@modelcontextprotocol/sdk@1.29.0`,
whose latest revision is `2025-11-25` and which does not implement
`server/discover`, so the host negotiates down to its standard tool surface
({§mcp-authority}). Its tools declare `openWorldHint` but not `readOnlyHint`,
so each search runs under the proposal policy.

## Plurnk projection

| MCP surface | Plurnk surface |
|---|---|
| Server tools | `worker:///_plurnk/tools/<server>.md` runtime summary |
| Complete tool definitions | `worker:///_plurnk/tools/<server>.json`: `{"tools":[...]}`, readable on demand with ordinary patterns |
| Enabled tool | `server (tool)` invocation in the runtime document; full input schema at `worker:///_plurnk/tools/<server>/<encoded-tool>.json` |
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
challenges an anonymous connection comes up `authorization-required`, without
publishing partial tools. A URL-only definition is sufficient; no callback
port needs to be configured. The terminal client's `/mcp oauth <alias>` binds
an available loopback port and calls `workspace.mcp.oauth.begin` before opening
the returned authorization URL. A fixed OAuth redirect, if configured, is
respected. Supplying the
callback URL explicitly also works for remote/headless use. The client submits
the complete URL through `workspace.mcp.oauth.complete`. Its `202` acknowledges
sign-in; tools activate at the next safe workspace boundary, without another
callback submission. `list` shows their current readiness. PKCE,
issuer and resource validation, refresh, scope escalation, and credentials
remain inside the host connection. Callback addresses and credentials never
replace the saved definition. `enable` retries a connection; it does not replace
user sign-in. Rejected configured credentials are reported as authentication
failures rather than retryable server downtime.

## Verification

```sh
npm test -w @plurnk/plurnk-mcp
npm run test:mcp:dogfood -w @plurnk/plurnk-service
```

The package gate runs the exact current SDK and official conformance
requirements. The opt-in dogfood gate composes representative current stdio
and Streamable HTTP servers through the assembled daemon and AG-UI product.

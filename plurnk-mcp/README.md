# @plurnk/plurnk-mcp

The current [Model Context Protocol](https://modelcontextprotocol.io/) host
module for [Plurnk](https://github.com/plurnk/plurnk-service). It projects
trusted MCP servers through Plurnk's existing executor, resource, proposal,
entry, Problem, lifecycle, and AG-UI contracts.

The module's own wire authority is protocol revision `2026-07-28`
({§mcp-authority}). Connection setup negotiates-and-degrades: a server that
offers the pinned revision and `server/discover` gets the complete extension
wire; a server the SDK negotiated below the pin is an ordinary MCP peer that
serves its standard surface at its own negotiated revision. Plurnk does not
downgrade its own extension wire, but it does not reject an older supported
revision.

## Manage Worker servers

Service environment variables provide available servers for every Worker;
`PLURNK_MCP_ENABLED` selects the exact cold-enabled subset. Users can add,
enable, disable, or remove one Worker's servers without restarting the daemon. An
existing AG-UI connection sends the ordinary management-action form under
`forwardedProps.plurnk.action`:

```json
{
  "forwardedProps": {
    "plurnk": {
      "workspace": "example",
      "action": {
        "kind": "worker.mcp.add",
        "alias": "project",
        "target": "/opt/mcp/current-server",
        "options": {
          "args": ["--stdio"],
          "env": { "PROJECT_TOKEN": "${PROJECT_TOKEN}" },
          "tools": ["issue_read", "issue_write"],
          "read": ["issue_read"]
        }
      }
    }
  }
}
```

The standard `plurnk.action.result` event reports success or exact RFC 9457
Problem Details. The definition is durable and Worker-private; symbolic
environment references remain unexpanded at rest.

Available Worker actions are:

| Action | Parameters |
|---|---|
| `worker.mcp.list` | optional client `overlay` |
| `worker.mcp.add` | `alias`, `target`; optional `options` |
| `worker.mcp.enable` | `alias`; optional client `overlay` and explicit `options` |
| `worker.mcp.disable` | `alias` |
| `worker.mcp.remove` | `alias` |
| `worker.mcp.oauth.complete` | `alias`, complete `callbackUrl` |
| `worker.mcp.complete` | `server`, completion `ref` and `argument`; optional `context` |

The owning [specification](./SPEC.md) defines the complete action and server
definition contracts.

Client and project configuration can specialize a cold service definition
without copying it or restarting the daemon. For example, a service catalog
can provide the executable while one project's `.env` supplies its identity:

```text
# $XDG_CONFIG_HOME/plurnk/.env, read by the service
PLURNK_MCP_GITEA=/usr/local/bin/possumtech-gitea-mcp
PLURNK_MCP_ENABLED=[]

# <project>/.env, read by the client
PLURNK_MCP_GITEA_ARGS=["plurnk_pk"]
```

The client carries its raw declarations while listing and enabling. Listing is
inert. `/mcp enable gitea` (or `plurnk mcp enable gitea` in a bound conversation)
composes service, durable worker, client, and optional command-file fields
in that order, prepares the connection, then persists the complete unexpanded
worker specialization. Arrays and maps replace rather than append or merge.

## Demo fixtures

Web discovery is an ordinary MCP attachment ({§web-search-retrieval}); the demo
tier exercises search through a documented fixture rather than an owned
runtime. Two service-owned definitions are permitted to participate in demos
of MCP and model behavior — Gitea (above) and Brave Search:

```text
# $XDG_CONFIG_HOME/plurnk/.env, read by the service — demo fixtures; never default-enabled
PLURNK_MCP_BRAVE=npx
PLURNK_MCP_BRAVE_ARGS=["-y","@brave/brave-search-mcp-server@2.1.0"]
PLURNK_MCP_BRAVE_ENV={"BRAVE_API_KEY":"${BRAVE_API_KEY}"}
PLURNK_MCP_BRAVE_TOOLS=["brave_web_search","brave_news_search"]
PLURNK_MCP_BRAVE_READ=["brave_web_search","brave_news_search"]
PLURNK_MCP_ENABLED=[]
```

The credential is one symbolic reference — the authoritative `BRAVE_API_KEY`
environment value is expanded only while preparing the connection, never
copied. The fixture admits exactly the web/news search tools and classifies
them read-only; the rest of the vendor catalog is not admitted.

**Pinned release and revision.** `@brave/brave-search-mcp-server@2.1.0`
(stdio) pins `@modelcontextprotocol/sdk@1.29.0`, whose latest protocol
revision is `2025-11-25` and which does not implement `server/discover`. The
host negotiates-and-degrades ({§mcp-authority}), so the fixture connects at
`2025-11-25` with the standard tool surface — verified live: the demo story
`{§web-search-retrieval}` researched through the real Brave MCP tool and
answered from it.

## Service defaults

One `PLURNK_MCP_<server>` variable declares each available server. Its suffix
case-folds to an `[a-z][a-z0-9-]*` executor and URI-authority name.

Streamable HTTP:

```text
PLURNK_MCP_github=https://example.test/mcp
PLURNK_MCP_github_BEARER=${GITHUB_TOKEN}
PLURNK_MCP_github_TOOLS=["issue_read","issue_search"]
PLURNK_MCP_github_READ=["issue_read","issue_search"]
PLURNK_MCP_ENABLED=["github"]
```

Stdio:

```text
PLURNK_MCP_local=/absolute/path/to/executable
PLURNK_MCP_local_ARGS=["--stdio"]
PLURNK_MCP_local_CWD=/absolute/working/directory
PLURNK_MCP_local_ENV={"TOKEN":"${LOCAL_TOKEN}"}
```

The stdio target is one exact executable path or name, including literal
whitespace. Arguments are a JSON array; the module never parses or invokes a
shell command. `${NAME}` references resolve from the daemon's inherited
environment only while preparing a connection.

`PLURNK_MCP_<server>_TOOLS` is an optional JSON array of exact names. Absence
enables every listed server tool; an array enables exactly those names; `[]`
enables none. `PLURNK_MCP_<server>_READ` is an exact enabled-tool subset whose
calls use Plurnk's `read` effect. Every other enabled tool conservatively uses
the proposal-gated `host` effect. Remote annotations never grant effect
authority.

Portable timeouts and complete examples live in [`.env.defaults`](./.env.defaults).

## Plurnk projection

| MCP surface | Plurnk surface |
|---|---|
| Server tools | `worker://~/_plurnk/tools/<server>.md` family summary |
| Enabled tool | Exact `worker://~/_plurnk/tools/<server>/<encoded-tool>.md` document and `## EXEC0 [server] (tool)` |
| Resource catalog | `server:///` or `server:///resources` |
| Resource | `server:///resources/<encoded-uri>` through ordinary `FIND` and `READ` |
| Prompt catalog | `server:///prompts` |
| Prompt retrieval | `server:///prompts/<encoded-name>?argument=value` through ordinary `READ` |
| Completion | Client-owned `worker.mcp.complete` action |

Tool results, resource bodies, prompt messages, and failures become ordinary
Plurnk entries and channels. Disabled tools appear in neither teaching nor
admission. There is no MCP-specific model discovery grammar.

Current pagination, cache hints, unified subscriptions, progress,
cancellation, multi-round-trip input, elicitation, and negotiated Tasks remain
inside the owning operation. Client input uses the standard AG-UI interrupt and
resume lifecycle; protocol continuation state is never exposed to the model or
client.

## Authorization

HTTP definitions support bearer references, client credentials, and
interactive OAuth. Stdio never receives OAuth. Interactive add or enable returns
`{ "status": 202, "authorization": { "url": "..." } }` without publishing a
partial server. After the user completes that URL, the client submits its
complete callback URL through `worker.mcp.oauth.complete`. PKCE, issuer and
resource validation, refresh, scope escalation, and credentials remain inside
the host connection.

## Verification

```sh
npm test -w @plurnk/plurnk-mcp
npm run test:mcp:dogfood -w @plurnk/plurnk-service
```

The package gate runs the exact current SDK and official conformance
requirements. The opt-in dogfood gate composes representative current stdio
and Streamable HTTP servers through the assembled daemon and AG-UI product.

# @plurnk/plurnk-execs-mcp

The [Model Context Protocol](https://modelcontextprotocol.io/) executor bridge
for [plurnk-service](https://github.com/plurnk/plurnk-service). Each configured
MCP server becomes an `EXEC` tag. Its live catalog exposes the server's tools,
input schemas, and annotations; invoking a tool writes its result behind the
tag's normal result address.

```text
<<EXEC[github]:?:EXEC
<<EXEC[github](create_issue):{"title":"Bug"}:EXEC
```

Built on the plurnk-execs framework and the official
[`@modelcontextprotocol/client`](https://www.npmjs.com/package/@modelcontextprotocol/client).
The package is inert until at least one server is configured.

## Dynamic runtimes

Servers are deployment configuration, not publish-time constants. The package's
`runtimesModule` discovers one executor runtime per configured server at boot.
Discovery reads only the environment; connection and live tool discovery happen
during `probe()` and execution.

Run a tag with no target (`?`, `help`, or an empty body) to retrieve its live
tool catalog. The complete server-provided `inputSchema` and annotations remain
attached to each tool.

## Configuration

Configuration mirrors model aliases: one variable per server. The suffix
case-folds to the tag name.

| Variable | Purpose |
|---|---|
| `PLURNK_EXECS_MCP_<server>` | HTTPS URL or stdio command |
| `PLURNK_EXECS_MCP_<server>_ENV` | JSON environment overlay for a stdio child |
| `PLURNK_EXECS_MCP_<server>_HEADERS` | JSON request headers for HTTP |
| `PLURNK_EXECS_MCP_INSTALL` | Permit runtime installation when nonzero |

The transport is inferred from the target: `http://` and `https://` use
streamable HTTP; other values are parsed as stdio commands. Companion suffixes
and `INSTALL` are reserved. Ambiguous case-folded server names fail hard.

```bash
PLURNK_EXECS_MCP_github="https://api.githubcopilot.com/mcp/"
PLURNK_EXECS_MCP_github_HEADERS='{"Authorization":"Bearer …"}'

PLURNK_EXECS_MCP_FIGMA="npx -y figma-developer-mcp --stdio"
PLURNK_EXECS_MCP_FIGMA_ENV='{"FIGMA_API_KEY":"…"}'
```

### Runtime installation

`installServer(name, { target, headers?, hotload })` checks the install gate,
connect-probes the server, and hands the consumer a `HotloadRegistration`.
Failed probes return `502` and roll back the injected configuration.
Environment-declared servers do not require the install gate.

### Authorization

Static credentials belong in the transport's `_HEADERS` or `_ENV` companion.
For OAuth, a `401` emits `mcp_auth_required`. The consumer relays the package's
RFC 8628 device-grant primitives:

- `authorize(server, { scope? })` begins the device grant.
- `poll(server, { device })` performs one caller-scheduled token poll.
- `install(server, headers)` overlays the resulting authorization headers and
  evicts the cached connection.

The bridge does not host a redirect server or own user interaction.

## Invocation and gating

The tool occupies the target slot and its arguments are one JSON object in the
body:

```text
<<EXEC[<server>](<tool>):<json-arguments>:EXEC
```

Tool results are written as `application/json` to the `results` channel. An MCP
`isError` result closes that channel errored with status `500`.

Gating is per tool. A cached `readOnlyHint: true` makes `effect()` return
`read`; mutating and not-yet-probed tools return `host`; catalog discovery is
read-only.

Connections are long-lived and cached per server. `closeAll()` disconnects them
on daemon shutdown.

## Deliberate boundary

This package adapts MCP tools to the executor contract. It does not expose a
generic `mcp://` scheme, provider-native tool calls, resources, prompts,
sampling, elicitation, or subscriptions. Those primitives require distinct
product contracts rather than an alternate face on tool execution.

## Verification

`npm test` type-checks the package and exercises configuration, discovery,
pagination, schemas, gating, tool calls, errors, cancellation, OAuth signaling,
and runtime installation through a real stdio MCP server.

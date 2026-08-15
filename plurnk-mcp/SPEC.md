# Plurnk MCP host specification

## §mcp-role Host boundary

`@plurnk/plurnk-mcp` is an MCP **host/client** that projects trusted remote
servers into Plurnk. It does not implement an MCP server or authorization
server. Protocol mechanics remain inside this package; core sees ordinary
executor, resource, proposal, entry, Problem, and lifecycle contracts.

## §mcp-authority Protocol authority

The only accepted revision is `2026-07-28`, specification commit
`5f5440bb26a62e2cf3440b92da5a667efa03b267`. The implementation exact-pins
`@modelcontextprotocol/client@2.0.0`. SDK exports are not protocol authority:
that package deliberately retains legacy and deprecated API shapes, while its
generic protocol seam remains available for final-release extension messages.

Every request carries the modern `_meta` envelope. Connection setup verifies
`server/discover` at the pinned revision before publishing any runtime or
scheme. There is no protocol downgrade or legacy fallback.

## §mcp-core-matrix Core capability matrix

| Surface | Upstream contract | Plurnk host disposition |
|---|---|---|
| Base | JSON-RPC 2.0; per-request protocol, identity, and capability metadata; every result has `resultType` | Require the modern envelope and preserve protocol results and errors without reconstructing them |
| Discovery | Servers implement `server/discover` | Probe before registration; retain identity, instructions, capabilities, versions, and cache hints |
| Tools | Negotiated server capability: `tools/list`, `tools/call` | Build one operator-filtered exact Registry snapshot at setup; route only its enabled names without renaming them |
| Resources | Negotiated server capability: `resources/list`, `resources/templates/list`, `resources/read` | Publish catalogs, templates, and materialized contents through the server's resource authority |
| Prompts | Negotiated server capability: `prompts/list`, `prompts/get` | Publish prompt definitions and retrieve prompt messages through the same server authority |
| Completion | Negotiated server capability: `completion/complete` | Make prompt and resource-template completion available to the host interaction that owns the argument |
| Pagination | Opaque cursors on list methods | Drain every page with a finite non-convergence guard; never publish a partial catalog as complete |
| Caching | `server/discover`, list methods, and `resources/read` carry `ttlMs` and `cacheScope` | Honor freshness and notification invalidation; partition private entries by authorization context |
| Subscriptions | `subscriptions/listen` plus acknowledged filters and correlated notifications | Use the unified stream for list changes and selected resources; re-listen after loss; never use the removed resource subscription methods |
| Progress | Request-scoped `notifications/progress` | Project progress onto the owning Plurnk operation without creating an independent protocol lifecycle |
| Cancellation | Per-request stream closure on HTTP; `notifications/cancelled` on stdio | Drive cancellation from the owning Plurnk abort signal and settle the same operation |
| MRTR | `input_required` on `tools/call`, `resources/read`, or `prompts/get` | Fulfill supported input requests, echo opaque `requestState` byte-for-byte, and retry only the originating request with a fresh JSON-RPC ID |
| Elicitation | Active client capability carried through MRTR | Advertise supported form/URL modes and route the request through Plurnk's client-owned interaction lifecycle |
| Authorization | OAuth profile for HTTP transports | Use protected-resource and authorization-server discovery, PKCE, issuer validation, resource indicators, refresh, and bounded scope escalation; never apply OAuth to stdio |

## §mcp-tasks Tasks extension

Tasks is the optional `io.modelcontextprotocol/tasks` extension, never core
conformance. Plurnk advertises it only when its complete lifecycle is active.
The server may return an unsolicited `resultType: "task"` handle from
`tools/call`; the host then uses `tasks/get`, `tasks/update`, and
`tasks/cancel`. `tasks/get` carries status, outstanding input, and the terminal
result or protocol error. Task notifications, when selected, use the unified
subscription stream. `tasks/list`, `tasks/result`, and per-call task opt-in do
not exist in this revision.

## §mcp-exclusions Removed, deprecated, and excluded surfaces

| Classification | Surfaces | Disposition |
|---|---|---|
| Deprecated | Roots, Sampling, Logging | Do not advertise or implement; use explicit resources/tool arguments, Plurnk's provider layer, and stderr/OpenTelemetry respectively |
| Deprecated | HTTP+SSE transport; OAuth Dynamic Client Registration; Sampling `includeContext` values | Do not adopt; use Streamable HTTP, Client ID Metadata Documents, and no Sampling |
| Removed | `initialize`, `notifications/initialized`, `Mcp-Session-Id`, HTTP GET event stream | Reject the legacy lifecycle; every request is stateless and self-contained |
| Removed | `ping`, `logging/setLevel`, `notifications/roots/list_changed` | Do not send, handle, or teach |
| Removed | `resources/subscribe`, `resources/unsubscribe`, SSE resumption and `Last-Event-ID` | Use `subscriptions/listen`; reissue a lost request with a new ID |
| Removed | Legacy Tasks `tasks/list`, `tasks/result`, and task-augmentation request fields | Use only the negotiated final Tasks extension |
| Excluded | Other official, experimental, or private extensions | Require a separately owned contract before negotiation |
| Excluded | Legacy revisions and dual-era operation | Pin `2026-07-28`; never probe-and-fallback |
| Excluded | MCP server and authorization-server roles | This package is the host/client only |

## §mcp-transports Transport bindings

| Binding | Contract |
|---|---|
| stdio | Spawn one exact executable with an explicit argument array and no shell; newline-delimited JSON-RPC is the only stdout/stdin traffic; stderr is diagnostic; shutdown closes stdin, waits, then terminates if necessary |
| Streamable HTTP | Send one POST per request or notification; accept JSON or SSE responses; close the response stream to cancel; never open the removed general GET stream |

Every HTTP request carries matching `MCP-Protocol-Version` and `Mcp-Method`
headers. Named requests also carry `Mcp-Name`; declared primitive tool
parameters carry validated `Mcp-Param-*` headers. Header names compare
case-insensitively, and body/header disagreement fails instead of guessing.

## §mcp-errors Error allocation

| Condition | Code and boundary |
|---|---|
| Standard JSON-RPC parse/request/method/params/internal failures | `-32700`, `-32600`, `-32601`, `-32602`, `-32603` |
| Missing resource or task handle | `-32602` |
| Header/body mismatch | `-32020` `HeaderMismatch`; HTTP 400 |
| Required client capability absent | `-32021` `MissingRequiredClientCapability`; HTTP 400 where applicable |
| Protocol revision unsupported | `-32022` `UnsupportedProtocolVersion`; HTTP 400 |
| Server-private errors | `-32000` through `-32019` only |
| Future MCP-reserved errors | `-32020` through `-32099` only as assigned by the protocol |

A tool-level `isError: true` result is a completed tool result, not a JSON-RPC
failure. A failed Task carries its originating JSON-RPC error; a Task wrapping
a tool-level error completes with that tool result. Plurnk preserves the
originating distinction in its canonical Problem/result path.

## §mcp-configuration Configuration

| Variable | Contract |
|---|---|
| `PLURNK_MCP_<server>` | HTTP(S) URL or exact stdio executable |
| `PLURNK_MCP_<server>_ARGS` | JSON string array for stdio |
| `PLURNK_MCP_<server>_CWD` | Working directory for stdio |
| `PLURNK_MCP_<server>_ENV` | JSON string map for stdio |
| `PLURNK_MCP_<server>_BEARER` | HTTP bearer credential; use `${TOKEN}` expansion to retain the authoritative environment value |
| `PLURNK_MCP_<server>_HEADERS` | JSON string map for supplementary HTTP headers |
| `PLURNK_MCP_<server>_TOOLS` | Optional JSON array of exact enabled tool names; absent enables all listed server tools, while `[]` enables none |
| `PLURNK_MCP_<server>_READ` | JSON string array forming an exact subset of enabled tools that the operator classifies as read-only; every other enabled tool retains the conservative `host` effect |
| `PLURNK_MCP_CONNECT_TIMEOUT` | Positive integer milliseconds |
| `PLURNK_MCP_REQUEST_TIMEOUT` | Positive integer milliseconds |

Configured server names match `[a-z][a-z0-9-]*` after case-folding and share
the executor and URI-authority namespace. Duplicate names, reserved-name
collisions, orphan companions, wrong-transport companions, missing environment
references, and invalid JSON fail startup. A stdio target is one exact
executable string even when its path contains whitespace; arguments never hide
inside it. Bearer authentication and a case-insensitive `Authorization` entry
in `_HEADERS` are mutually exclusive.

## §mcp-setup Atomic lifecycle

Setup parses every configured server, opens and probes every connection,
lists tools, applies the enabled/effect policy, builds each exact tool Registry,
validates the complete shared namespace, then publishes all registrations as
one transaction. A configured tool absent from the server, a duplicate remote
name, an enabled name not representable as a Plurnk target, or a `_READ` name
outside the enabled set fails setup. Any failure
publishes none and closes every acquired connection. Materialization and
registration inspect the complete owning operation result; a non-success
preserves its original Problem.

Shutdown first prevents new work, settles every connection attempt and active
request/subscription/task, closes every acquired connection, then reports all
close failures.

## §mcp-model-projection Model-facing projection

| MCP surface | Plurnk surface |
|---|---|
| Server | One registered executor family and matching resource scheme |
| Enabled tool | One exact Registered Tools row and `## EXEC0 [<server>] (<tool>)` call |
| Enabled tool details | `worker://plurnk/docs/<server>.md` through the standard kernel documentation surface |
| Resource catalog | `<server>:///` and `<server>:///resources` |
| Resources | `<server>:///resources` and encoded resource-URI descendants |
| Prompts | `<server>:///prompts` and encoded prompt-name descendants |

§mcp-tool-presentation One canonical enabled-tool snapshot owns every
model-facing and executable consequence. Each enabled remote tool becomes one
exact target in {§executor-tool-registry}. Its Registered Tools row carries the
remote description, requiredness derived from the input schema, and a
deterministic one-line JSON-shaped signature: quoted property names, `?` on
optional properties, primitive type words, and literal unions—never fabricated
argument data. The snapshot's standard kernel document contains each enabled
tool's description and exact input/output JSON Schemas. Disabled names appear
in neither surface, and there is no MCP-specific FIND, READ, authority-root, or
other model discovery mechanism for tools.

Core validates the exact target and the selected tool's invocation before
effect admission. `McpExecutor.run()` independently rejects a target outside
the same snapshot before issuing `tools/call`. The server's empty-authority
scheme is consequently resource-only: its root and `/resources` catalogs
contain resources and resource templates, never tools. Tool results become
ordinary Plurnk entries and channels, so slicing, tags, curation, notices, and
Problems need no MCP-specific parallel mechanism.

MCP tool annotations remain untrusted metadata, not admission authority. The
operator-owned `_READ` subset classifies enabled observations as the executor
`read` effect; every other enabled tool remains `host` and therefore uses the
ordinary proposal policy. Effect classification receiving an unregistered
target is an internal contract violation rather than a conservative guess.

## §mcp-conformance Conformance authority

Protocol conformance runs through official
`@modelcontextprotocol/conformance@0.2.0-alpha.11`, whose immutable
`2026-07-28` requirement manifest freezes the release-time alpha.10 scenario
set. The core client leg must pass; supported extension scenarios run and
report separately because Tasks cannot alter the core pass rate. Atlas and
third-party stdio/Streamable HTTP servers are composition evidence only.

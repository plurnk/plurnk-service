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
that package deliberately retains legacy and deprecated API shapes. It owns
core negotiation and transport; this package owns only exact-pinned extension
wire that the SDK does not yet implement.

The optional Tasks authority is the official `experimental-ext-tasks` contract
at commit `2c1425d9a288b9b1f489430fe1e00bb392b47e48`. Its absence from the current
SDK runtime does not revive that SDK's retained 2025 Tasks vocabulary.

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
| Subscriptions | `subscriptions/listen` plus acknowledged filters and correlated notifications | Keep one current filter for list changes, resource URIs read into cache, and active Task IDs; overlap filter replacement, re-listen after loss, and never use the removed resource subscription methods |
| Progress | Request-scoped `notifications/progress` | Project progress onto the owning Plurnk operation without creating an independent protocol lifecycle |
| Cancellation | Per-request stream closure on HTTP; `notifications/cancelled` on stdio | Drive cancellation from the owning Plurnk abort signal and settle the same operation |
| MRTR | `input_required` on `tools/call`, `resources/read`, or `prompts/get` | Fulfill supported input requests, echo opaque `requestState` byte-for-byte, and retry only the originating request with a fresh JSON-RPC ID |
| Elicitation | Active client capability carried through MRTR | Advertise supported form/URL modes and route the request through Plurnk's client-owned interaction lifecycle |
| Authorization | OAuth profile for HTTP transports | Require validated protected-resource and authorization-server metadata; never infer endpoints; use PKCE, issuer validation, resource indicators, refresh, and bounded scope escalation; never apply OAuth to stdio |

## §mcp-tasks Tasks extension

Tasks is the optional `io.modelcontextprotocol/tasks` extension, never core
conformance. Plurnk advertises it only when its complete lifecycle is active.
The server may return an unsolicited `resultType: "task"` handle from
`tools/call`; the host then uses `tasks/get`, `tasks/update`, and
`tasks/cancel`. `tasks/get` carries status, outstanding input, and the terminal
result or protocol error. Task notifications, when selected, use the unified
subscription stream. `tasks/list`, `tasks/result`, and per-call task opt-in do
not exist in this revision.

Polling honors each current `pollIntervalMs` under the one owning operation
deadline. Task input keys are fulfilled at most once, in one atomic client
interaction per observed input set. A completed Task is validated as the
originating tool result; a failed Task preserves its JSON-RPC error.

## §mcp-exclusions Removed, deprecated, and excluded surfaces

| Classification | Surfaces | Disposition |
|---|---|---|
| Deprecated | Roots, Sampling, Logging | Do not advertise or implement; use explicit resources/tool arguments, Plurnk's provider layer, and stderr/OpenTelemetry respectively |
| Deprecated | HTTP+SSE transport; Sampling `includeContext` values | Do not adopt; use Streamable HTTP and no Sampling |
| Deprecated fallback | OAuth Dynamic Client Registration | Prefer pre-registration, then CIMD when advertised; use DCR only when authorization-server metadata advertises `registration_endpoint`; otherwise fail without probing an inferred endpoint |
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
For `tasks/get`, `tasks/update`, and `tasks/cancel`, `Mcp-Name` is the encoded
`taskId` required by the Tasks extension.

## §mcp-errors Error allocation

| Condition | Code and boundary |
|---|---|
| Standard JSON-RPC parse/request/method/params/internal failures | `-32700`, `-32600`, `-32601`, `-32602`, `-32603` |
| Missing resource or task handle | `-32602` |
| Tasks extension capability absent | `-32003` |
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

Two inputs produce one effective definition per workspace. Service environment
variables are convenience defaults instantiated independently for every
workspace. The workspace's durable attachment map may add a server, replace a
default, or retain a tombstone that suppresses a default after detach. Neither
source expands the model-facing namespace with a second discovery surface.

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

§mcp-definition-wire The contracts-owned `McpServerDefinition` JSON Schema is
the one workspace action and durable-state shape. It is a closed discriminated
union:

| Transport / authorization | Required definition | Optional definition |
|---|---|---|
| `stdio` | `name`, `transport`, `command` | `args`, `cwd`, `env`, `tools`, `read` |
| `http` + none | `name`, `transport`, `url` | `headers`, `tools`, `read` |
| `http` + bearer | above plus `authorization: { type: "bearer", token: "${NAME}" }` | — |
| `http` + interactive OAuth / CIMD preferred | above plus `authorization: { type: "oauth", redirectUrl, clientMetadataUrl }` | `scope`; DCR remains the server-advertised fallback when CIMD is unavailable |
| `http` + interactive OAuth / pre-registered | above plus `authorization: { type: "oauth", redirectUrl, clientId, clientSecret: "${NAME}" }` | `scope` |
| `http` + interactive OAuth / DCR fallback only | above plus `authorization: { type: "oauth", redirectUrl }` | `scope` |
| `http` + client credentials | above plus `authorization: { type: "client-credentials", clientId, clientSecret: "${NAME}" }` | `scope` |

`tools` absent enables the complete listed set; `[]` enables none. `read` is an
exact subset of the enabled set. A credential field is one complete symbolic
environment reference, not a copied token. Other string-valued `headers`,
`env`, `cwd`, and argument values may contain symbolic references and are
expanded only while preparing a connection. The unexpanded definition is the
only durable form. Interactive OAuth tokens, PKCE verifier, issuer-bound
discovery state, and authorization callback state remain process-memory
credentials; a restart reconstructs the attachment as authorization-required
instead of writing secrets into SQLite.

### §mcp-management-actions Workspace management

Every action below declares `scope: "workspace"` under
{§module-action-registration}. AG-UI binds its workspace; none accepts a
workspace identifier in params.

| Action | Parameters | Result / effect |
|---|---|---|
| `workspace.mcp.list` | none | Sorted effective server summaries: name, source, transport, connection/authorization state, negotiated identity/capabilities, enabled tools, and read subset. No credential values. |
| `workspace.mcp.attach` | `server: McpServerDefinition` | Adds a name absent from the effective workspace. Preparation completes before publication. |
| `workspace.mcp.replace` | `server: McpServerDefinition` | Replaces one effective definition under the same name; absence is 404. |
| `workspace.mcp.detach` | `name` | Removes a workspace attachment or writes a tombstone for a service default, then removes its exact Registry, docs, and resource authority. |
| `workspace.mcp.reconnect` | `name` | Builds a fresh connection from the existing unexpanded definition and atomically replaces the old connection after successful preparation. |
| `workspace.mcp.oauth.complete` | `name`, `callbackUrl` | State- and issuer-validates one pending interactive callback through the SDK, completes connection preparation, then performs the originally requested attach, replace, or reconnect. |
| `workspace.mcp.complete` | `server`, `ref`, `argument`; optional `context` | Requests negotiated prompt/resource-template argument completion for a client-owned interaction. |

Expected preparation failures cross the action boundary as MCP-management
Problems rather than generic AG-UI failures:

| Endpoint condition | Problem |
|---|---|
| Definitively does not offer pinned `2026-07-28` through `server/discover` | `502 protocol-revision-unsupported`, non-retryable; names the server, required revision and method, and directs the operator to upgrade or replace the legacy endpoint |
| Cannot connect or complete current discovery/catalog preparation | `502 server-unavailable`, retryable; names the server and transport without exposing credentials |

Interactive preparation returns a successful pending result shaped as
`{ status: 202, authorization: { url } }`; it publishes no candidate runtime.
The action owner retains one pending candidate per `(workspace, name)` and a
new request cancels and replaces it. Unrelated workspace changes remain
authoritative while authorization is pending; drift of the same server fails
completion with a conflict instead of replaying a stale workspace snapshot.
`oauth.complete` accepts the complete
callback URL so state, `code`, and `iss` remain one parsing unit. A missing,
expired, mismatched, or replayed callback fails without exposing attacker-owned
OAuth error text. It completes either pending hydration or the originally
requested attach, replace, or reconnect. There is no callback HTTP endpoint,
authority-root resource, or MCP-specific AG-UI route.

## §mcp-setup Atomic lifecycle

For each workspace, hydration resolves service defaults against the durable
attachment/tombstone map, opens and discovers every effective connection,
lists the negotiated catalogs, applies enabled/effect policy, builds each exact
tool Registry and resource facet, and submits one complete owner snapshot to
{§module-workspace-capabilities}. A configured tool absent from the server, a
duplicate remote name, an enabled name not representable as a Plurnk target,
or a `read` name outside the enabled set fails that workspace hydration. No
partial namespace is published and every acquired candidate closes.

Attach, replace, and reconnect prepare the candidate while the old snapshot
remains authoritative, then commit only at {§module-workspace-quiescence}. The
old connection rejects replacement while it owns an active protocol request,
MRTR exchange, or Task. Cache/list-change watches are infrastructure and close
with the old connection after the new snapshot commits. A failed candidate or
commit leaves the durable definition, connection, Registry, docs, and resource
authority unchanged. Materialization and registration inspect the complete
owning operation result; a non-success preserves its original Problem.

Shutdown first prevents new work, cancels pending OAuth candidates and
infrastructure watches, settles every active request and Task, closes every
acquired connection, then reports all close failures. Whole-connection
shutdown retires subscription work before closing its transport; it does not
first issue a redundant per-listen cancellation.

## §mcp-host-composition Protocol-to-Plurnk composition

One `ServerConnection` owns negotiation, SDK caches, authorization partition,
subscriptions, active request controllers, MRTR rounds, and Tasks for one
workspace attachment. The host does not reproduce SDK protocol machinery.

| Protocol event | Plurnk composition |
|---|---|
| `tools/call` progress | Writes ordinary transient progress on the owning EXEC stream; it creates no log sibling or polling vocabulary. |
| Operation cancellation | The owning EXEC abort signal closes the HTTP request stream or sends the stdio cancellation notification. |
| `input_required` | Batches all embedded requests from one result into one atomic client interaction. Opaque `requestState` remains private to the connection and only the originating request is reissued after a complete response. |
| Elicitation form / URL | Validates the response against the requested form or URL action contract. Client cancellation becomes the standard `cancel` action; unsupported families or modes fail before any interaction or retry. |
| Task handle | Keeps the original EXEC stream active, follows `tasks/get` and selected Task notifications, and settles that same stream with the terminal result or error. |
| Task input | Routes through the operation's client interaction, then sends `tasks/update`; it never asks the model to manufacture protocol state. |
| Task cancellation | The owning EXEC cancellation invokes `tasks/cancel` before settling the ordinary stream cancellation. |
| List/resource invalidation | List changes invalidate SDK catalogs and atomically refresh the attachment snapshot. Updates to selected resource URIs invalidate their SDK cache entries; private entries remain authorization-partitioned. |
| Prompt get / completion | Serves ordinary resource-authority reads and host interactions from negotiated prompt/template definitions; no prompt becomes an executable tool. |

The general executor interaction contract, not this package, owns client
interrupt durability and AG-UI presentation. A disconnect re-surfaces its
pending client-owned interaction exactly as proposal review does. MRTR round
limits, request timeout, cancellation, and Task terminal state are one
operation lifecycle; none becomes a hidden retry loop.

## §mcp-model-projection Model-facing projection

| MCP surface | Plurnk surface |
|---|---|
| Server | One registered executor family, `worker://plurnk/tools/<server>.md`, and matching resource scheme |
| Enabled tool | One exact `worker://plurnk/tools/<server>/<encoded-tool>.md` document and `## EXEC0 [<server>] (<tool>)` call |
| Tool survey | Ordinary FIND summary metadata from the standard executable-tool resource tree |
| Resource catalog | `<server>:///` and `<server>:///resources` |
| Resources | `<server>:///resources` and encoded resource-URI descendants |
| Prompts | `<server>:///prompts` and encoded prompt-name descendants |

§mcp-tool-presentation One canonical enabled-tool snapshot owns every
model-facing and executable consequence. Each enabled remote tool becomes one
exact target in {§executor-tool-registry}. Its standard
{§executor-tool-document} carries the normalized remote description as Summary,
requiredness derived from the input schema, and a deterministic one-line
JSON-shaped invocation signature: quoted property names, `?` on optional
properties, primitive type words, and literal unions—never fabricated argument
data. A missing remote description receives a deterministic server-and-tool
summary rather than an invented capability claim. Output schemas do not enter
model teaching; the returned value remains ordinary evidence. Disabled names
appear in neither discovery nor admission, and there is no MCP-specific FIND,
READ, authority-root, or other model discovery mechanism for tools.

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

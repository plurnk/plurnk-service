# Plurnk MCP host specification

## Host boundary

`@plurnk/plurnk-mcp` is an MCP **host/client** that projects trusted remote
servers into Plurnk. It does not implement an MCP server or authorization
server. Protocol mechanics remain inside this package; core sees ordinary
executor, resource, proposal, entry, Problem, and lifecycle contracts.

## §mcp-authority Protocol authority

The host's own wire authority is revision `2026-07-28`, specification commit
`5f5440bb26a62e2cf3440b92da5a667efa03b267`. The implementation exact-pins
`@modelcontextprotocol/client@2.0.0`. SDK exports are not protocol authority:
that package deliberately retains legacy and deprecated API shapes. It owns
core negotiation and transport; this package owns only exact-pinned extension
wire that the SDK does not yet implement.

Connection setup negotiates-and-degrades. A server that negotiates the pinned
revision and offers `server/discover` is a **modern** peer: it gets the complete
extension wire (the `_meta` envelope, `resultType`, the Tasks extension) and its
discover result is the identity and capability source. A server the SDK
negotiated below the pin is an ordinary MCP peer: it serves the standard
tool/resource/prompt surface from its `initialize` result at its negotiated
revision, and the host applies no envelope, discover, or Tasks requirements to
it. There is no rejection for offering an older supported revision and no
protocol downgrade of the host's own extension wire: modern peers and legacy
peers simply carry different surfaces.

The optional Tasks authority is the official `experimental-ext-tasks` contract
at commit `2c1425d9a288b9b1f489430fe1e00bb392b47e48`. It is negotiated
per-connection and absent from a legacy peer.

## §mcp-core-matrix Core capability matrix

The accountable capability matrix lives in `capabilityMatrix.ts`
({§mcp-capability-matrix}). This table describes the pinned revision;
{§mcp-authority} owns the SDK-negotiated older-peer surface.

| Surface | Upstream contract | Plurnk host disposition |
|---|---|---|
| Base | JSON-RPC 2.0; per-request protocol, identity, and capability metadata; every result has `resultType` | Require the modern envelope and preserve protocol results and errors without reconstructing them |
| Discovery | Servers implement `server/discover` | Probe before registration; retain identity, instructions, capabilities, versions, and cache hints |
| Tools | Negotiated server capability: `tools/list`, `tools/call` | Build one operator-filtered exact Registry snapshot at setup; route only its enabled names without renaming them |
| Resources | Negotiated server capability: `resources/list`, `resources/templates/list`, `resources/read` | Publish catalogs, templates, and materialized contents through the server's resource authority |
| Prompts | Negotiated server capability: `prompts/list`, `prompts/get` | Publish prompt definitions and retrieve prompt messages through the same server authority |
| Completion | Negotiated server capability: `completion/complete` | Make prompt and resource-template completion available to the host interaction that owns the argument |
| Pagination | Opaque cursors on list methods | Drain every page with a finite non-convergence guard; never publish a partial catalog as complete ({§mcp-catalog-convergence}) |
| Caching | `server/discover`, list methods, and `resources/read` carry `ttlMs` and `cacheScope` | Honor freshness and notification invalidation; partition private entries by authorization context |
| Subscriptions | `subscriptions/listen` plus acknowledged filters and correlated notifications | Keep one current filter for list changes, resource URIs read into cache, and active Task IDs; overlap filter replacement, re-listen after loss, and never use the removed resource subscription methods |
| Progress | Request-scoped `notifications/progress` | Project progress onto the owning Plurnk operation without creating an independent protocol lifecycle |
| Cancellation | Per-request stream closure on HTTP; `notifications/cancelled` on stdio | Drive cancellation from the owning Plurnk abort signal and settle the same operation |
| MRTR | `input_required` on `tools/call`, `resources/read`, or `prompts/get` | Fulfill supported input requests, echo opaque `requestState` byte-for-byte, and retry only the originating request with a fresh JSON-RPC ID |
| Elicitation | Active client capability carried through MRTR | Advertise supported form/URL modes and route the request through Plurnk's client-owned interaction lifecycle |
| Authorization | OAuth profile for HTTP transports | Require validated protected-resource and authorization-server metadata; never infer endpoints; use PKCE, issuer validation, resource indicators, refresh, and bounded scope escalation; never apply OAuth to stdio |

§mcp-catalog-convergence **A catalog is complete or it is an error.** The pinned SDK's aggregating
list walk (`listTools`, `listResources`, `listResourceTemplates`, `listPrompts`) stops silently when
a server returns a cursor it already returned, drops `nextCursor`, and caches the partial aggregate
as if it were whole; only its page cap (`listMaxPages`) throws. The host's client watches the pages
the SDK requests and refuses the page that repeats a cursor with `CatalogNonConvergenceError`
(method and cursor named), so the listing fails and nothing partial is published or cached.
Pagination, caching, and the cap remain the SDK's; a converging server's pages aggregate exactly as
before. This is a host guard over an upstream behavior, not a second paginator; the upstream
report is #601's to file.

§mcp-catalog-deadline `PLURNK_MCP_CONNECT_TIMEOUT` bounds connection setup and,
separately, each complete catalog/list walk, including parallel collections and
all pagination. Failure cancels unfinished sibling lists; it never publishes a
partial catalog. Caller cancellation and connection shutdown still apply.
Tool calls, resource reads, prompt retrieval, and their client-input waits retain
`PLURNK_MCP_REQUEST_TIMEOUT`; discovery does not borrow that operation allowance.

§mcp-retry-pacing Every retry the adapter schedules on its own — reopening a dropped
subscription, refreshing a catalog a server announced as changed — waits
`PLURNK_MCP_RETRY_FLOOR_MS`, doubling per attempt up to `PLURNK_MCP_RETRY_CEILING_MS`.
One pacing serves them all; a ceiling beneath the floor fails configuration. The
deadlines above bound an attempt; this paces the next one.

§mcp-catalog-list-absence **An unsupported list method does not disable the server.**
At the first page of `tools/list`, `resources/list`, `resources/templates/list`, or
`prompts/list`, JSON-RPC `-32601` yields an empty collection for that method and an
availability detail naming the unsupported method. This is host tolerance, not
a claim that the server satisfies its advertised capabilities. The empty result
is immediately stale; a later successful listing clears the diagnostic. An error
after the first page, any other protocol error, transport/authentication failure,
or non-convergence remains a failure. SDK pagination and caching retain ownership.

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
Handle ownership and the restart journey are bounded in {§tasks-lifetime}.

§mcp-subscription-ownership Notification filters belong to the shared connection,
not an individual operation. Acquiring or releasing Task interest schedules a
filter update without blocking Task polling, settlement, or cancellation; the
ordinary `tasks/get` path remains available before acknowledgement and during
watch recovery. A resource READ may await cache-watch setup, but owner
cancellation ends only that caller's wait. It neither cancels another caller's
setup nor closes the connection. Filter acknowledgement, overlap replacement,
retry, and teardown retain one connection-level owner.

## §tasks-lifetime Tasks lifetime

Task handles belong to the connection and operation that created them. They
are process-local, never persisted or automatically replayed. Ordinary host
lifecycle owns interruption and recovery ({§worker-lifecycle-restart-recovery});
MCP adds no second scheduler or client-disconnect policy.

| Boundary | Behaviour |
|---|---|
| Client interrupt / reattach | The live operation retains its pending input across the intentional Run boundary; synchronization re-presents it ({§agui-conversation-sync}). |
| Client hangup | Inherits the owning client's cancellation or observer-detachment semantics; MCP does not change them. |
| Graceful shutdown | Aborts and settles owned work before closing its protocol connection ({§mcp-connection-shutdown}). |
| Restart after owner loss | No Task resume or automatic tool replay; core reconciles the interrupted operation and its durable evidence. |
| Workspace reactivation | Reconstructs the attachment from its definition, not an old Task handle. Active Tasks retain workspace residency ({§module-workspace-residency}). |
| Expiry | The owning operation deadline also bounds client-input waits ({§mcp-input-deadline}); expiry cancels the Task before settling the failed operation. MRTR retains its separate round bound. |
| Cancellation | Owner abort cancels the task before settling; the handle is then terminal. |
| Already terminal | Terminal results and errors are consumed by the drive loop; a completed or failed task is never re-polled or re-resumed. |

## §mcp-exclusions Removed, deprecated, and excluded surfaces

| Classification | Surfaces | Disposition |
|---|---|---|
| Deprecated | Roots, Sampling, Logging | Do not advertise or implement; use explicit resources/tool arguments, Plurnk's provider layer, and stderr/OpenTelemetry respectively |
| Deprecated | HTTP+SSE transport; Sampling `includeContext` values | Do not adopt; use Streamable HTTP and no Sampling |
| Deprecated fallback | OAuth Dynamic Client Registration | Prefer pre-registration, then CIMD when advertised; use DCR only when authorization-server metadata advertises `registration_endpoint`; otherwise fail without probing an inferred endpoint |
| Removed at pinned revision | `initialize`, `notifications/initialized`, `Mcp-Session-Id`, HTTP GET event stream | Absent on modern connections; the negotiated older-peer lifecycle remains SDK-owned ({§mcp-authority}) |
| Removed | `ping`, `logging/setLevel`, `notifications/roots/list_changed` | Do not send, handle, or teach |
| Removed | `resources/subscribe`, `resources/unsubscribe`, SSE resumption and `Last-Event-ID` | Use `subscriptions/listen`; reissue a lost request with a new ID |
| Removed | Legacy Tasks `tasks/list`, `tasks/result`, and task-augmentation request fields | Use only the negotiated final Tasks extension |
| Excluded | Other official, experimental, or private extensions | Require a separately owned contract before negotiation |
| Excluded | Dual-era operation | Modern peers and legacy peers carry different surfaces; the host never mixes the two on one connection |
| Excluded | MCP server and authorization-server roles | This package is the host/client only |

## §mcp-capability-matrix Accountable capability matrix

`capabilityMatrix.ts` is the one accountable support matrix: one row per core
surface, official extension, or explicitly selected experimental candidate,
carrying authority, disposition (supported, partial, excluded, deferred),
advertisement, interactivity, and evidence citations. Rows are "supported"
only when every layer their owning contract includes has real coverage; a row
cannot claim support merely because the direct SDK or conformance path passes.
Every evidence citation must resolve through a named specification tag or a
named composed test.

The static wire advertisement is derived from the matrix by construction
(`staticClientCapabilities`): an extension reaches the wire only because its
row says `always`, and a `conditional` extension is added only by its owning
connection logic ({§oauth-client-credentials}). The matrix unit tests enforce
unique identities, no excluded row advertising, supported rows citing evidence,
composed coverage for every advertised row, and exact reconciliation
between the matrix and the derived advertisement. Official required
conformance stays a separate named gate, never folded into a matrix row.

## §mcp-transports Transport bindings

| Binding | Contract |
|---|---|
| stdio | Spawn one exact executable with an explicit argument array and no shell; newline-delimited JSON-RPC is the only stdout/stdin traffic; stderr is diagnostic; shutdown closes stdin, waits, then terminates if necessary |
| Streamable HTTP | Send one POST per request or notification; accept JSON or SSE responses; close the response stream to cancel; modern connections never open the removed general GET stream |

§mcp-endpoint-security **Configured MCP and registry endpoints accept HTTP or HTTPS,
including private-network hosts.** Transport admission does not relax OAuth:
the SDK retains token-endpoint TLS enforcement (with its loopback exception),
issuer/resource binding, PKCE and redirect validation. No transport-policy bypass is supplied.

§mcp-stdio-process-ownership A stdio connection owns the complete process group
created for its server. Ordinary closure forwards stdin EOF and permits a
bounded graceful exit; an expired shutdown bound or disappearance of the host
process forcibly terminates the group, including descendants.

§mcp-redirect-refused **An HTTP endpoint is never redirected.** Every Streamable HTTP request,
authorization discovery included, sets `redirect: "manual"`; a 301, 302, 303, 307, or 308 fails the
connection naming the `Location`. Configured headers therefore never reach another origin
and the endpoint URL is corrected where it is configured.

At the pinned revision, HTTP requests carry matching `MCP-Protocol-Version` and `Mcp-Method`
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

MCP servers are complete connection definitions ({§mcp-server-definition}). Standalone files, plugin components, and environment declarations
supply the service baseline; live additions belong to the workspace. All use the common resolution
and lifecycle ({§configuration-definition-resolution}, {§functionality-coordinator}). Disabled definitions remain
client-visible but contribute no connection, Registry, documentation, or resource authority.

§mcp-file-configuration **Standalone `mcp.json` files are read-only configuration inputs, not plugins.**
The module reads `mcp.json` in the directories supplied by {§agent-roots}. Definitions resolve
by alias, highest precedence first:

| Source | Location |
|---|---|
| Workspace overlay | Ordinary `mcp (add)` state |
| Environment | `PLURNK_MCP_<alias>` |
| Project | `<project>/.agents/mcp.json`, then selected project plugins |
| Plurnk-only | `$XDG_CONFIG_HOME/plurnk/mcp.json`, then selected Plurnk plugins |
| Shared global | `~/.agents/mcp.json`, then selected global plugins |
| Installed npm plugins | Selected plugin bundles in the installed graph |

- The document is an object with required `mcpServers`, an object keyed by server alias,
  and an optional string `$schema` editor hint. No schema is fetched. No other top-level fields.
- Each entry is the owning connection definition without `name`; its map key supplies the name.
  An omitted `type` is inferred from `command` (stdio) or `url` (Streamable HTTP).
  Ambiguous, unsupported, or incomplete entries fail the same definition validator as environment/live inputs.
- Select the whole winning entry before validating it; never merge fields or fall back from an invalid winner.
  Environment enabledness and tool controls apply independently to file-backed aliases.
- Missing files contribute nothing. Invalid/unreadable files or selected entries produce a named
  configuration diagnostic under {§configuration-repair-path}, not a daemon exit or an empty catalog.
- Inspection reports `kind: file`, the absolute file `source`, and the entry's JSON Pointer `reference`.
  Normal pre-turn refresh observes file edits and deletion; `list` never starts a server or writes a file.
  Workspace removal restores the current inherited definition and controls.
- File entries retain {§mcp-launch-directory} and {§mcp-launch-environment}; a file's location is
  not a subprocess working directory. Plugin-root configuration and packaging are separate.

`mcpServers` follows the common MCP catalog shape, also used by
[MCP Inspector](https://github.com/modelcontextprotocol/inspector/blob/main/docs/mcp-server-configuration.md).
The discovery locations are Plurnk's supported cross-client convention, not an MCP wire requirement.

§mcp-plugin-configuration **Plugin MCP components use their format's interpretation, not the native file dialect.**
The validated components supplied by {§agent-plugins-hosting} become ordinary configured MCP
definitions. The adapter carries the canonical plugin root and persistent data directory as
interpretation context under {§functionality-adapter}; inspection preserves symbolic definitions.

| Field or boundary | Agent Plugins v1 behavior |
|---|---|
| `command` | Bare executable or plugin-root-relative `./` path; no expansion |
| `args`, `env`, `cwd` | One nonrecursive expansion of `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` only; all other placeholder-like text stays literal |
| Omitted `cwd` | Plugin root; explicit plugin/data cwd is contained within its corresponding resolved root |
| Subprocess environment | Ordinary admitted operator/workspace environment, then configured values, then authoritative `PLUGIN_ROOT` and `PLUGIN_DATA` |
| Data | Created before launch; preserved across disable, removal of an override, and in-place plugin updates |
| Filesystem containment | Rechecked before each subprocess launch, including existing parents of missing paths |
| HTTP URL and headers | Literal; client-owned protocol headers win; existing no-redirect rule applies |
| Unsupported transport or name | Skip the entry with a configuration notice; never rename, reinterpret, or disable independent entries |

Supported transports are stdio and Streamable HTTP, not legacy SSE. Server names must meet
Plurnk's runtime alias grammar `[a-z][a-z0-9-]*`; other standard map keys are explicitly unsupported.
The standard loader owns component validation and narrow failure boundaries
({§agent-plugins-mcp-entries}, {§agent-plugins-components}). Connection failures remain ordinary
unavailable outcomes. Current adapter notices join client/model configuration diagnostics;
source repair replaces them, rather than retaining a historical warning.

§mcp-activation-isolation **Cold endpoint failure is capability-local.** An enabled server
that cannot connect or complete discovery during workspace activation remains
enabled and client-visible as `unavailable`. It publishes no runtime, tools,
resources, or documentation and cannot prevent other capabilities or the daemon
from starting or serving dormant workers. Enabling that already-enabled alias is an explicit reconnect
attempt; failure preserves the unavailable snapshot, while success atomically
replaces it. An interactive enable continues to reject an unavailable candidate
without changing durable state.

| Variable | Contract |
|---|---|
| `PLURNK_MCP_<alias>` | Complete `McpServerDefinition` JSON; transport and authentication replace together |
| `PLURNK_MCP_ENABLED`, `PLURNK_MCP_<alias>_ENABLED` | Shared default and per-alias flags ({§resource-environment}); declared servers default enabled |
| `PLURNK_MCP_<alias>_TOOLS` | Optional JSON array of exact enabled tool names; absent or empty enables every listed tool, and `[]` enables none |
| `PLURNK_MCP_EXPANDED` | JSON array of aliases whose tool invocations are surveyed at turn 0 ({§tools-resource-materialization}); absent or `[]` expands none |
| `PLURNK_MCP_CONNECT_TIMEOUT` | Positive integer milliseconds for setup and each complete catalog walk |
| `PLURNK_MCP_REQUEST_TIMEOUT` | Positive integer milliseconds for the whole operation |
| `PLURNK_MCP_REGISTRY_URL` | HTTP(S) registry discovery endpoint; empty disables registry search |
| `PLURNK_MCP_REGISTRY_LIMIT` | Positive integer result bound |

Aliases and controls follow {§resource-environment}. Malformed definitions or controls fail
configuration by variable name, even when disabled or not yet associated with a resource.
Authentication belongs in the definition, never in separate bearer/OAuth environment companions.
The package's offline validator composes these same readers
({§operator-config-offline-validation}); it performs no connection or secret resolution.
Runtime configuration errors leave the manager inspectable without publishing MCP
capabilities or preventing unrelated model work ({§configuration-repair-path}).

§mcp-definitions **A server is not a plugin installation.** `add` persists a workspace
connection definition; `remove` removes that definition through the common coordinator.
Neither writes nor deletes project, user or global configuration files. MCP management
and preparation do not enumerate or install Agent Plugins. Plugin integration is a separate
configuration-source concern, not an MCP definition or lifecycle.

| Transport | Launch or connection |
|---|---|
| `stdio` | Spawn `command` with `args`, without a shell. Bare executable names use PATH; relative executable paths use the working directory. `args`, `env` and explicit `cwd` expand `${NAME}` references once against the workspace-composed operator environment. |
| `streamable-http` | Connect to `url` with `headers` and `authorization` from that same definition. Header references expand at connection time. Protocol-generated headers are transport-owned; application authentication headers are retained. Declaring both structured authorization and an Authorization header is invalid. No redirect is followed ({§mcp-redirect-refused}). |

§mcp-launch-directory **An implicit working directory is workspace-owned state, not the project.**
Core's {§module-workspace-directory} supplies a stable directory isolated by workspace and MCP alias.
An explicit `cwd` must resolve to an absolute path and overrides that directory; it is not confined
to an installation root. The caller owns provisioning an explicit directory. Runtime paths and
resolved environment values are never copied back into a stored definition. Disabling or removing
a server closes its connection, not its retained state directory or saved results.

A tool whose `annotations.readOnlyHint` is true takes the `read` effect; every other tool keeps the
conservative `host` effect ({§mcp-model-projection}).

§mcp-summary-derivation **Orientation prefers the server's own purpose over display
labels; no capabilities are inferred.** Blank values fall through:

| Summary | Precedence, highest first |
|---|---|
| Server | `serverInfo.description` → `instructions` → `serverInfo.title` → effective admitted tool-name list → server alias |
| Tool | `description` → `title` → `annotations.title` → tool name |

Derived prose is whitespace-normalized, limited to its first sentence, and
clipped within 80 characters plus an ellipsis, preferring a word boundary. Full server instructions remain authored
Markdown in the family document's runtime `details`, available on demand;
turn0 surveys only the compact summary/invocations. Full tool descriptions
remain in the linked input-contract documents. With tools, the runtime declares
`{ from: "tools", description }`: purpose annotates rather than replaces the
complete effective menu in the family Summary and survey row
({§scheme-catalog-aside}). Without a stated purpose the menu stands alone. The tool
doc's Summary section IS the invocation form
```` ```server (tool) <!-- one-liner --> ````, so the discovery row teaches the
call ({§tools-resource-materialization}).

§mcp-server-settings **Independent behavior settings do not change connection definitions.**
`<alias>_TOOLS` narrows the effective tool catalog. A valid control may precede its definition,
without creating a server; all control values are validated immediately ({§resource-environment}).
Bearer and OAuth settings belong to the whole HTTP definition. Secrets in structured authorization
are `${NAME}` references expanded only while preparing the connection. Interactive tokens,
PKCE verifiers and callback state remain in memory; restart reconstructs an authorization-required
attachment, never a stored credential.

### §mcp-module The MCP family beneath the coordinator

The package declares itself a daemon module in `package.json#plurnk`, so the host discovers it
({§module-discovery}). It is setup-only: `setup` registers the family adapter and there is no
start seam. Its factory only reads the environment, so configuration errors surface where they
always have: in the family's diagnostics at runtime and in the offline check
({§operator-config-offline-validation}). It claims no HTTP mounts.

§mcp-launch-environment **A server inherits the operator's environment.** A stdio server
starts with the operator's environment without plurnk's own secrets ({§exec-env-scoped}), as every MCP
client launches one: stdio servers read their credentials from the environment. The model's command
ceiling is not its base. The workspace layer ({§workspace-env}) applies on top, its values and
withholdings included, never the invoking worker's overrides; the definition's `env` follows. Definition references resolve against the operator environment with the same workspace
entries and masks applied, and resolved ambient values are never copied into definitions. A running server keeps its launch environment:
`disable` and `enable` restart it after an environment change, and there is no automatic restart or
stale-configuration state. HTTP servers have no local process environment.

§mcp-management-actions MCP is one family of workspace Functionality ({§functionality-coordinator}). The
coordinator publishes `workspace.mcp.list | discover | add | enable | disable | remove` and the model's
`mcp` executable fence family with the common semantics, durable state, and publication; this module
registers the family adapter and owns protocol truth beneath it. `available` is the configured service baseline; `add` and `remove` change workspace state ({§mcp-definitions}), and
`discover` searches the MCP Registry ({§mcp-registry-discovery}). `prepare` connects the enabled set, reusing
unchanged live attachments, and returns one executor family and resource facet per connected server,
one outcome per alias (`active` with catalog detail — negotiated protocol version, server identity,
capabilities, tool names, resource and prompt counts — `unavailable` with its exact Problem, or
`authorization-required` with its URL), and a two-phase snapshot: `commit` closes connections the new
set no longer uses and records pending authorizations; `abort` closes only what the attempt opened.

§mcp-registry-discovery **`discover` searches the MCP Registry.** `{ query }` asks
`PLURNK_MCP_REGISTRY_URL` (API v0.1) for one page of at most `PLURNK_MCP_REGISTRY_LIMIT` servers, each at
its latest version, whose names match. Each npm, PyPI, NuGet or OCI package with a stdio transport
becomes a stdio entry run as the registry's own examples run it (`npx -y`, `uvx`, `dnx`, or
`docker run -i --rm` passing each declared variable through), and each Streamable HTTP remote becomes a
URL entry with its non-secret literal headers. An entry that needs a person's input first, such as a
template variable or a required argument with no value, has none. A candidate is a complete definition;
its summary names the environment variables and headers the
server needs, and its provenance names the registry and the server's `name@version`. `source` and
`configuration` are not registry queries and are refused.

| Discovery, admission, or installation condition | Problem | Status |
|---|---|---|
| No registry is configured | `registry-not-configured` | 501 |
| The registry is unreachable, fails, or answers malformed | `discover-failed`, retryable | 502 |
| `discover` names a `source` or client `configuration` | `source-unsupported`, `configuration-unsupported` | 400 |
| The complete connection definition is invalid | `definition-invalid` | 400 |
| The alias differs from the definition's name | `alias-mismatch` | 400 |

Protocol continuations remain MCP-registered workspace actions beneath the
common grammar:

| Action | Parameters | Result / effect |
|---|---|---|
| `workspace.mcp.oauth.begin` | `alias`, `redirectUrl` | Begin sign-in using a client-owned callback, without changing the connection definition; publish the pending URL through the coordinator. An active alias is returned unchanged. |
| `workspace.mcp.oauth.complete` | `alias`, `callbackUrl` | Validates and exchanges the pending callback through the SDK, returning `McpOAuthCompletionResult` (`202`, `alias`); ordinary capability refresh publishes the authenticated tools at the next safe boundary ({§oauth-continuation}). |
| `workspace.mcp.complete` | `server`, `ref`, `argument`; optional `context` | Requests negotiated prompt/resource-template argument completion for a client-owned interaction. |

Expected preparation failures cross the boundary as MCP-management Problems
rather than generic failures; an explicit client action rejects them and a
Worker's own accepted mutation publishes them as unavailable
({§functionality-model-mutation}):

| Endpoint condition | Problem |
|---|---|
| Cannot connect or complete discovery/catalog preparation at the negotiated revision | `502 server-unavailable`, retryable; names the server and its `type` without exposing credentials |
| HTTP 401 without configured credentials | Enabled `authorization-required`, no runtime and no URL until the client begins sign-in |
| HTTP 401 with configured credentials | `502 server-authentication-failed`, non-retryable, with `upstreamStatus: 401`; credentials are not replaced by interactive OAuth |
| Sign-in discovery lacks validated authorization metadata or a usable client-registration method | `502 oauth-metadata-unavailable` or `oauth-registration-unavailable`, non-retryable; retain the definition and surface the setup boundary, not retryable downtime |
| The endpoint answers with a redirect | `502 server-redirected`, non-retryable ({§mcp-redirect-refused}) |
| An operator setting of the alias is invalid | `422 server-settings-invalid`, non-retryable ({§mcp-server-settings}) |
| Client-credentials grant rejected by the authorization server | `502 oauth-client-credentials-failed`, non-retryable; names the server and client id, never the secret ({§oauth-client-credentials}) |

Resource and prompt failures retain one caught remote diagnostic only through
the executor-owned `PLURNK_EXECS_ERROR_DETAIL_LIMIT` bound; complete causes stay
in daemon diagnostics. No MCP resource Problem admits an unbounded SDK message.

§oauth-continuation A URL-only HTTP definition is sufficient to reach the client
sign-in handoff. An unauthenticated 401 publishes `authorization-required` with
an empty `authorization` object, not retryable downtime. No browser is opened,
client is registered, or workspace lease retained merely for that challenge.
The client binds its callback before `oauth.begin`; absent an explicitly
configured redirect, it obtains an ephemeral loopback port (RFC 8252 §7.3).
The MCP SDK owns metadata discovery, registration, PKCE and token exchange.
An explicit OAuth definition may supply scope and client-registration metadata;
its optional fixed redirect is respected, never silently rewritten. Bearer,
client-credentials and Authorization-header configurations cannot be replaced
by `oauth.begin`. Callback addresses and acquired credentials are session state,
not changes to the persisted definition.

```mermaid
sequenceDiagram
    Model->>MCP: add URL-only definition
    MCP-->>Model: authorization-required
    User->>Client: sign in to alias
    Client->>Client: bind callback
    Client->>MCP: oauth.begin(alias, redirectUrl)
    MCP-->>Client: authorization URL
    Client->>User: open consent page
    User->>Client: browser callback
    Client->>MCP: oauth.complete(alias, callbackUrl)
    MCP-->>Client: 202 sign-in accepted; activation pending
    MCP-->>Model: active tools through normal publication
```

`oauth.begin` prepares an authorization attempt without enabling the alias or
waiting for workspace quiescence. It returns `202` with an `authorization.url`
when consent is required, `202` without that field when an accepted connection
awaits publication, or `200` when tools are already active. These results name
the alias, not a capability snapshot. The adapter retains one pending candidate
per `(workspace, alias)` holding the connection and one workspace residency
lease. An unchanged publication preserves that independent attempt; a new
challenge supersedes it ({§oauth-lifetime}).
Concurrent begin requests for one alias are refused; a later begun attempt
supersedes the prior one unless its grant is already accepted and awaiting
publication. An in-flight begin cannot attach after disable,
remove or definition replacement. `oauth.complete` accepts the complete callback URL so state, `code`, and
`iss` remain one parsing unit. Grant acceptance returns without waiting for
workspace quiescence; it is not a configuration mutation and cannot re-enable
an alias. The existing catalog-refresh path prepares and publishes the current
enabled definitions, then consumes the candidate and releases its lease.
The accepted result does not claim tool readiness: `list` reports the current
published snapshot, including any subsequent preparation failure. A callback
for a superseded attempt fails as invalid; a
committed attachment that no longer matches the pending definition fails
with a conflict instead of replaying a stale snapshot. A missing, expired,
mismatched, or replayed callback fails without exposing attacker-owned OAuth
error text.

| Callback boundary | Result |
|---|---|
| Active workspace | Accept the valid grant without waiting for the held turn; queue publication through the coordinator's ordinary workspace gate. |
| Identical concurrent or accepted-but-unpublished callback | Share the same acceptance; exchange the one-time code once. |
| Different callback for that accepted attempt | Reject; never borrow another callback's acceptance. |
| Disable, remove, or replacement | Current definitions win; the old candidate cannot restore a withdrawn server. |
| Publication failure | Do not claim active tools; retain the accepted candidate for normal refresh/enable retry, without another code exchange. |
| Preparation failure published as unavailable | Preserve the preparation diagnostic; release the pending lease and close its unused connection. |
| Callback after publication | The attempt has been consumed; `404 oauth-not-pending`. |

## §oauth-lifetime Interactive OAuth lifetime and reauthorization

Interactive OAuth state is deliberately ephemeral and process-memory: client
registration data, access and refresh tokens, the PKCE verifier, and pending
state live only in the owning connection or pending candidate. Nothing
OAuth-secret is written to SQLite; the durable workspace state holds only the
unexpanded definition ({§mcp-configuration}). There is no daemon callback HTTP
listener, authority-root resource, or daemon-side browser side channel: an
interactive client may receive its configured loopback redirect, or accept a
pasted callback for remote/headless use. It returns the complete URL through `workspace.mcp.oauth.complete`
so `state`, `code`, and `iss` remain one parsing unit. Reauthorization after a
daemon restart is the intended journey, documented here rather than presented
as an accidental failure.

| Journey point | Behaviour |
|---|---|
| Pending authorization | One pending candidate per `(workspace, alias)`; a new challenge or customized enable cancels and replaces it. A callback from a superseded attempt fails state validation instead of cross-completing. |
| Client disconnect | Does not touch the pending candidate; it can still be completed, or replaced by a fresh request. |
| Daemon restart during pending | The candidate is lost: nothing was durable, no attachment publishes, and `oauth.complete` answers `404 oauth-not-pending`. Start authorization again. |
| Daemon restart after authorization | The durable definition rehydrates but tokens are gone; a challenged attachment publishes `authorization-required` and enable returns `202`. A URL is present only when a callback is already configured. The operator reauthorizes. |
| Token expiry | An expired access token surfaces as one unauthorized response; the SDK re-acquires via `refresh_token` when one was issued, otherwise re-enters interactive authorization. |
| Refresh | Happens only against the issuer bound during the original authorization; the refreshed token replaces the in-memory token. |
| Workspace disable/remove | Closes the attachment and clears its pending candidate; no durable secret deletion is needed because nothing secret is durable. |
| Server replacement | Publication discards any superseded pending connection and releases its residency, including replacement by a definition without OAuth. Completion of an unpublished configuration drift fails `409 oauth-target-conflict` instead of replaying a stale snapshot. |
| Cross-authorization protection | Candidates are keyed by `(workspace, alias)`; callback state, PKCE, and issuer are validated by the SDK against the attempt that created them, so no other workspace, alias, or attempt can complete this authorization. |

## §oauth-client-credentials Client-credentials grant adoption

The `client-credentials` arm of `McpServerDefinition.authorization` adopts the
official `io.modelcontextprotocol/oauth-client-credentials` extension's
client-secret form faithfully: a connection whose definition holds a
client-credentials grant ({§mcp-server-settings}) advertises the extension capability in
`clientCapabilities.extensions`; connections without one never claim it. The
grant uses `client_secret_basic` authentication with `grant_type
client_credentials`. The setting's optional `scope` is passed to
the token request. The credential itself is one complete symbolic environment
reference (`clientSecret: "${NAME}"`), expanded only while preparing the
connection; it is never stored in SQLite, logged, or echoed in Problems.

| Aspect | Behaviour |
|---|---|
| Issuer binding | The setting's optional `issuer` is passed as the SDK provider's `expectedIssuer`, stamping the credential with its authorization server so SEP-2352 issuer checks refuse to send it elsewhere. Absent, the SDK's legacy no-binding behaviour applies. |
| Token lifetime | Token refresh is 401-triggered by the SDK client: an expired access token surfaces as one unauthorized response, the provider re-fetches with the stored credential, and the request is retried. Proactive expiry scheduling is a client-internal optimization, not a wire requirement; Plurnk does not wrap the SDK with its own scheduler. |
| Rotation | `clientSecret` resolution happens per connection preparation, so rotating the operator environment value takes effect on the next preparation of the server. |
| Errors | A rejected grant crosses the action boundary as `502 oauth-client-credentials-failed`, non-retryable, naming the server and client id only; SDK OAuth error text is never echoed. Other connection failures keep the generic `server-unavailable` allocation. |

Static credentials authorize application principals (service attachments, CI,
daemons), not human users. Private-key JWT and static JWT assertions for
client authentication are a declared non-goal; the specification permits a
secret-only client and Plurnk declines the assertion arms. The interactive
OAuth arm is the human-principal path ({§mcp-management-actions}); bearer
remains the private-service/legacy transport credential.

## §mcp-ema-deferral Enterprise-managed authorization deferral

Plurnk does not advertise or implement
`io.modelcontextprotocol/enterprise-managed-authorization`. The SDK supplies
the wire steps (ID-JAG acquisition via RFC 8693 and the RFC 7523 JWT bearer
grant); the extension's remaining responsibilities are enterprise deployment
policy, not open-source host mechanics:

| Responsibility | Ownership |
|---|---|
| Capability advertisement, ID-JAG and access-token exchange, scope-error handling | Public protocol responsibilities the SDK host could own |
| SSO acquisition of the identity assertion (ID token or SAML) | Presumes a user session the headless daemon does not own |
| Saving the identity assertion for later use | Durable identity material; conflicts with the credential policy — secrets have one owner, the operator environment, and never a durable store |
| IdP endpoint and client registration configuration | Organization-owned; Plurnk has no org-level configuration seam |

The conformance client declines the enterprise scenarios, the capability
matrix keeps the extension non-advertised ({§mcp-capability-matrix}), and the
extension stays separate from core OAuth and client-credentials reporting.
Re-evaluate when an organization-owned configuration owner exists and a
decision on durable identity material is ratified.

## §mcp-setup Atomic lifecycle

When a cold workspace is demanded, activation resolves service defaults and durable positive
workspace state, opens and discovers only enabled connections,
lists the negotiated catalogs, applies enabled/effect policy, builds each exact
tool Registry and resource facet, and submits one complete owner snapshot to
{§module-workspace-capabilities}. A configured tool absent from the server, a
duplicate remote name, an enabled name not representable as a Plurnk target,
or a `read` name outside the enabled set fails that workspace activation. No
partial namespace is published and every acquired candidate closes.

§mcp-catalog-refresh-in-place **A catalog change refreshes in place.** An unchanged
definition re-lists over its existing connection and atomically republishes its
executor, documents, and resource facet through {§functionality-publication}.
SDK cache invalidation and the host's publication acknowledgement are separate
boundaries; neither closes or replaces the committed connection.

| Refresh boundary | Pending invalidation |
|---|---|
| Notification | Marks the alias immediately; notifications coalesce under the existing refresh timer. |
| Successful publication | Acknowledges only the invalidation captured by that preparation. A newer notification remains pending. |
| Failed listing | Keeps the previous usable snapshot and retries pending work with bounded backoff. |
| Aborted publication | Does not acknowledge the unpublished catalog. |
| Disable/remove, workspace cooling, or shutdown | Retires obsolete refresh timers and invalidations. |

MCP participates in core Functionality residency ({§module-workspace-residency}).
Preparation reports the current server alias through the coordinator's activity
contract ({§functionality-preparation-visibility}); inspection never starts a
connection ({§functionality-inspection}).
Every tool call and Task retains the workspace from executor entry through its
terminal result; an interactive OAuth candidate retains it until completion,
replacement, cancellation, or module shutdown. Catalog refresh timers are
infrastructure, not residency owners: cooling serializes behind a refresh
already running and cancels any timer not yet begun. At a lease-free quiescent
boundary, deactivation removes the workspace snapshot and closes all of its
connections. Core separately withdraws the executor/scheme publication while
preserving durable MCP state and generated reference entries for transparent
reactivation.

Add and enable prepare the candidate while the old snapshot remains
authoritative, then commit only at {§module-workspace-quiescence}. Disable and
remove commit the complete reduced snapshot at the same boundary. The
old connection rejects replacement with `409 server-busy` while it owns an active protocol request,
MRTR exchange, or Task. Cache/list-change watches are infrastructure and close
with the old connection after the new snapshot commits. A failed candidate or
commit leaves the durable definition, connection, Registry, docs, and resource
authority unchanged. Materialization and registration inspect the complete
owning operation result; a non-success preserves its original Problem.

§mcp-connection-shutdown Module `stop()` prevents new work and aborts each connection's
active requests, including client-input waits. Discovery and preparation recheck
admission after asynchronous environment resolution, before owning a new connection;
connection startup rechecks after asynchronous directory resolution before opening
its transport. Their protocol cleanup settles
before the extension channel or connected transport closes, so a created Task
can receive `tasks/cancel`. Concurrent closers await the same settlement.
Candidates still negotiating and standalone OAuth transports close immediately.
Infrastructure watches retire without a redundant per-listen cancellation;
active mutations settle, process-local snapshots are discarded, and close
failures are reported. Core's shutdown deadline remains the outer bound
({§crash-only-stop}).

## §mcp-host-composition Protocol-to-Plurnk composition

One `ServerConnection` owns negotiation, SDK caches, authorization partition,
subscriptions, active request controllers, MRTR rounds, and Tasks for one
workspace attachment. The host does not reproduce SDK protocol machinery.

| Protocol event | Plurnk composition |
|---|---|
| `tools/call` progress | Writes ordinary transient progress on the owning execution stream; it creates no log sibling or polling vocabulary. |
| Operation cancellation | The owning execution's abort signal closes the HTTP request stream or sends the stdio cancellation notification. |
| `input_required` | Batches all embedded requests from one result into one atomic client interaction. Opaque `requestState` remains private to the connection and only the originating request is reissued after a complete response. |
| Elicitation form / URL | Validates the response against the requested form or URL action contract. Each response-schema property's `description` carries its request message and, for URL mode, the browser URL; a generic schema renderer can present the decision without decoding MCP arguments. Client cancellation becomes the standard `cancel` action; unsupported families or modes fail before any interaction or retry. |
| Task handle | Keeps the original execution stream active, follows `tasks/get` and selected Task notifications, and settles that same stream with the terminal result or error. |
| Task input | Routes through the operation's client interaction, then sends `tasks/update`; it never asks the model to manufacture protocol state. |
| Task cancellation | The owning execution's cancellation invokes `tasks/cancel` before settling the ordinary stream cancellation. |
| List invalidation | Invalidates SDK catalogs and atomically refreshes the attachment snapshot. |
| Selected resource update | Invalidates that URI's SDK cache entry; a subsequent READ acquires current content. Private entries remain authorization-partitioned. Earlier READ receipts stay unchanged; ordinary remote changes neither broadcast nor wake workers ({§actor-boundary-lineage-attention}). |
| Prompt get / completion | Serves ordinary resource-authority reads and host interactions from negotiated prompt/template definitions; no prompt becomes an executable tool. |

The general executor interaction contract, not this package, owns client
interrupt durability and AG-UI presentation. Reattachment re-surfaces input
only while its originating operation remains live. MRTR round
limits, request timeout, cancellation, and Task terminal state are one
operation lifecycle; none becomes a hidden retry loop.

§mcp-input-deadline Client-input waits consume the remaining owning operation
budget (`PLURNK_MCP_REQUEST_TIMEOUT`); each MRTR round or Task input set does not
start a fresh budget. Expiry aborts the input's ordinary Core waiter, removes it
from pending/reconnect discovery, and enters the same bounded protocol cleanup
as other operation failures. A late response is no longer pending. No response
or tool replay is fabricated; the failed operation remains available to the
worker for recovery. SDK wire-leg timeouts retain ownership of transport waits.

§mcp-tool-replay A tool call is effectful unless host policy proves otherwise.
After dispatch, a transport failure cannot prove that the MCP server did not
apply the call, so `tool-call-failed` is non-retryable and never recommends
automatic identical replay. Read-classification controls proposal policy; it
does not weaken this uncertain-outcome boundary.

§mcp-tool-problem-detail Tool-call Problems keep runtime, tool, and any bounded
remote diagnostic as structured extensions. Their prose states only the failed
boundary fact; it neither repeats those fields nor infers whether the remote
effect occurred.
For `isError: true`, nonblank text content blocks, in order and joined by
newlines, supply `diagnostic` under the existing executor error-detail bound.
Nontext parts and structured data are not interpreted as explanations. With no
text explanation the extension is absent; successful results do not acquire one.
The complete result and passive output remain unchanged ({§mcp-result-content}).

§mcp-trailing-aside A tool call's body is one JSON object. HTML comments after
that object are the writer's aside, not arguments: when the body does not parse
as written, trailing `<!-- … -->` comments are removed and the object is read.
Any other trailing text is still `invalid-tool-arguments`. Nothing teaches the
tolerance (#758).

## §mcp-result-content Passive result content

The default output channel carries the tool's result, not its transport envelope:
text parts are written as text with their own newlines
— whitespace-formatted `application/json` when the text is a complete JSON document,
else unchanged `text/plain` ({§json-document-presentation});
several text parts join with newlines; an empty content with
`structuredContent` writes it pretty-printed — so the page rule and a scoped
READ mean what they say and nothing reaches the model double-escaped. The
complete result, including metadata and annotations, remains available in
`#json` as protocol evidence. The default body preserves content order:

| Content | Model-facing projection |
| --- | --- |
| Text | Its text. |
| Inline image/audio | Link to an invocation-owned typed byte resource, published through {§executor-entry-sink}. |
| Embedded text/blob resource | Link to a typed resource snapshot; use the supplied URI's filename when present. |
| Resource link | Link to the existing MCP resource address; acquisition occurs on READ, not on listing. |

Unnamed resources receive eight-character hexadecimal identifiers, not ordinal
labels. No binary base64 is copied into the default result body. Listing a
resource creates no native model attachment; READ uses {§packet-attachment-parts},
including scoped byte reads, supported modalities, and the owning READ's retention
and curation lifecycle.
Resource publication is passive; completion of the originating execution retains
its ordinary wake semantics. A single `resources/read` content item becomes the
resource's typed body; multiple items become named children under its `resources/`
folder and a directory of links. Each response retains its complete `#json` evidence;
reconstructing the same collection preserves child paths ({§resource-publication-names}).
Generated catalogs and prompt documents use two-space
JSON indentation; individual text resources preserve their source layout. A
standalone `blob` content block is not a modern `tools/call` content member
(blobs ride inside embedded blob resources) and is rejected as
protocol-invalid. Size limits and MIME trust remain ordinary channel and
entry policy, not MCP-specific rules.

§mcp-prompt-content Retrieved prompts retain their ordered message list, roles,
text, and metadata as data, not conversation injections. The same content
projection used for tools replaces non-text parts with resource links: embedded
content becomes typed snapshots under the prompt's `resources/` folder; remote
links resolve through the server resource authority. Reading a snapshot does
not retrieve the prompt again or discard its arguments. A missing snapshot is
not found, never an implicit prompt re-execution. The prompt's `#json` preserves
the complete original response. Media acquisition, native delivery, retention,
and curation use the ordinary READ contract, not a separate prompt lifecycle.

## §mcp-apps-exclusion MCP Apps exclusion

Plurnk does not advertise or implement MCP Apps. An Apps host must sandbox
render third-party HTML/JavaScript, enforce CSP and `_meta.ui` permissions,
mediate a `postMessage` JSON-RPC `ui/` dialect, proxy app-initiated tool
calls with consent, and own teardown. No Plurnk client can enforce that
sandbox today (the terminal cannot), the daemon is not a second
application platform, and AG-UI has no standard Apps projection — inventing
a private event stream to carry Apps is rejected. Compact tool summaries and
invocations derive only from name, description, title, and input schema,
without `_meta.ui`. The on-demand raw tool catalog preserves `_meta` as inert
data: no UI resource is fetched or preloaded, permissions are not granted,
and reading a definition does not activate an App. The capability matrix keeps the extension
non-advertised ({§mcp-capability-matrix}). Re-evaluate only when a
sandbox-capable client exists and a standard AG-UI projection is agreed;
even then the capability would be per-client-advertised, never daemon-wide.

## §mcp-skills-deferral Skills extension adoption boundary

Plurnk does not advertise or implement `io.modelcontextprotocol/skills`.
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md)
is Final, with a
[stable extension specification](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx).
Deferral concerns host integration, not standards maturity: origin-qualified
identities, manifest verification, content-bound approval, and activation
must compose with the existing skills, resource, and proposal owners before
adoption. Reading an MCP resource does not claim extension support or activate
it as a skill. The design review is tracked in #654.

## §mcp-model-projection Model-facing projection

| MCP surface | Plurnk surface |
|---|---|
| Server | One registered executor family, `worker:///_plurnk/tools/<server>.md`, and matching resource scheme |
| Enabled tool | One annotated call in the compact family document plus one exact `worker:///_plurnk/tools/<server>/<encoded-tool>.json` input-contract document |
| Complete tool definitions | `worker:///_plurnk/tools/<server>.json`, containing `{"tools":[...]}` from the same effective snapshot |
| Tool survey | Ordinary FIND summary metadata from the standard executable-tool resource tree |
| Resource catalog | `<server>:///` and `<server>:///resources` |
| Resources | `<server>:///resources` and encoded resource-URI descendants |
| Prompts | `<server>:///prompts` and encoded prompt-name descendants |

Qualified `<server>://<worker>/…` resources, prompts, and catalogs follow
{§runtime-resource-binding}: the qualifier selects the stored projection, not
a private attachment. Acquisition uses the workspace attachment; the requesting
operation retains its policy and client interactions.
Returned Plurnk resource links retain that qualifier; MCP protocol URIs remain
unchanged on the wire.

§mcp-tool-presentation One canonical enabled-tool snapshot owns every
model-facing and executable consequence. Each enabled remote tool becomes one
exact target in {§executor-tool-registry}. Its standard
{§executor-tool-document} carries a compact summary, requiredness derived from
the input schema, and the original schema itself. The common renderer owns
{§executor-input-schema-preview}, not an MCP-specific schema interpreter.
The compact family document contains annotated, copyable tool invocations with
shallow required-field previews and alias-scoped schema links. Each linked child
preserves the complete remote description and raw input schema, without
reconstructing property tables or expanding nested constraints into the preview.
Output schemas do not enter compact invocation teaching; the returned value remains ordinary evidence. Disabled names
appear in no model teaching, and there is no MCP-specific FIND,
READ, authority-root, or other model discovery mechanism for tools.

Each registry entry carries the original MCP `Tool` object as its
{§executor-tool-catalog} definition. The catalog preserves full descriptions,
input and output schemas, annotations, icons, and metadata as received through
the MCP client, without synthesized fields or schema expansion. It contains
the selected tools from all catalog pages, sorted by tool name, not the JSON-RPC
envelope, pagination cursors, or transport cache controls. The Markdown family
document links to it; ordinary READ and JSONPath can inspect one tool or the
whole catalog. Reading the catalog performs no additional MCP discovery and
does not inject its contents into turn 0.

Core validates the exact target and the selected tool's invocation before
effect admission. `McpExecutor.run()` independently rejects a target outside
the same snapshot before issuing `tools/call`. The server's empty-authority
scheme is consequently resource-only: its root and `/resources` catalogs
contain resources and resource templates, never tools. Tool results become
ordinary Plurnk entries and channels, so slicing, tags, curation, notices, and
Problems need no MCP-specific parallel mechanism.

A configured server's `annotations.readOnlyHint` supplies its tool's declared effect:
a tool marked read-only takes the executor `read` effect; every other enabled
tool remains `host` and therefore uses the ordinary proposal policy. Effect classification receiving an unregistered
target is an internal contract violation rather than a conservative guess.

## §mcp-conformance Conformance authority

Protocol conformance runs through official
`@modelcontextprotocol/conformance@0.2.0-alpha.11`, whose immutable
`2026-07-28` requirement manifest freezes the release-time alpha.10 scenario
set. Its required client leg must pass; `not_scored` probes remain visible
without changing that verdict. The adopted `auth/client-credentials-basic`
extension runs as a separate named gate requiring successful grant and bearer
checks; an empty or skipped report never passes. Extension scenarios have no
dated-spec filter and do not alter the core pass rate. The JWT arm remains
excluded under {§oauth-client-credentials}. Atlas and third-party
stdio/Streamable HTTP servers are composition evidence only.

§problems-mcp **MCP Problems.** Every code this family mints, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `tool-required` | 400 | An MCP tool target is required. Recovery: Select a target documented under worker:///_plurnk/tools/*runtime*/. |
| `tool-not-enabled` | 404 | The MCP tool is not enabled. Recovery: Select a target documented under worker:///_plurnk/tools/*runtime*/. |
| `tool-reported-error` | 502 | The MCP tool reported an error (the tool call failed). |
| `invalid-tool-arguments` | 400 | The tool arguments are not one JSON object. Recovery: One JSON object per MCP tool call; a second call is a second fence. |
| `oauth-client-credentials-failed` | 502 | MCP server '*name*' rejected the client-credentials grant; check the configured client credentials and issuer. |
| `server-authentication-failed` | 502 | MCP server '*name*' rejected authentication (HTTP 401). |
| `oauth-metadata-unavailable` | 502 | MCP OAuth requires validated authorization-server metadata; legacy endpoint inference is not supported. |
| `oauth-registration-unavailable` | 502 | The authorization server exposes no usable client registration: configure pre-registration or advertised CIMD; its metadata does not advertise a Dynamic Client Registration endpoint. |
| `oauth-redirect-invalid` | 400 | The OAuth callback must use HTTPS or HTTP loopback with a usable port. |
| `oauth-configuration-conflict` | 409 | MCP server '*alias*' is not configured for this interactive OAuth callback. |
| `oauth-busy` | 409 | MCP server '*alias*' is already starting authorization. |
| `parameters-invalid` | 400 | Unsupported parameter(s): *names*. |
| `server-settings-invalid` | 422 | MCP server '*name*' has invalid operator settings: *cause*. |
| `server-busy` | 409 | MCP server '*name*' has *n* active request(s). |
| `obsolete-connection-close-failed` | 500 | The MCP capability change committed, but an obsolete connection did not close cleanly. |
| `oauth-not-pending` | 404 | MCP server '*alias*' has no pending OAuth authorization. |
| `oauth-target-conflict` | 409 | MCP server '*alias*' changed while its OAuth authorization was pending. Recovery: Start authorization again from the server's current definition. |
| `oauth-callback-invalid` | 400 | OAuth authorization for MCP server '*alias*' could not be completed. |
| `server-not-connected` | 409 | MCP server '*name*' is not connected for this workspace. |
| `completion-parameters-invalid` | 400 | MCP completion requires 'ref' and 'argument' objects. |
| `server-unavailable` | 502 | Configured MCP server '*name*' is unavailable. |
| `server-redirected` | 502 | MCP endpoint *url* redirected to *location*; plurnk follows no redirect, so the server's url must be the endpoint itself ({§mcp-redirect-refused}). |

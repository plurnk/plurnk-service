# Plurnk MCP host specification

`@plurnk/plurnk-mcp` is an MCP **host/client** that projects trusted remote servers into Plurnk. It does not implement an MCP server or authorization server.

## §mcp-authority Protocol authority, core matrix, capabilities, and exclusions

- **Protocol authority:** Pinned wire revision `2026-07-28`, specification commit `5f5440bb26a62e2cf3440b92da5a667efa03b267`, `@modelcontextprotocol/client@2.4.0`. Optional Tasks authority: `experimental-ext-tasks` (`io.modelcontextprotocol/tasks`) at commit `2c1425d9a288b9b1f489430fe1e00bb392b47e48`.
- **Negotiate-and-degrade:** A server negotiating `2026-07-28` and offering `server/discover` is a **modern** peer (uses `_meta` envelope, `resultType`, Tasks extension, `server/discover` identity/capabilities). A server negotiated below the pin is an ordinary legacy peer (`initialize` result at its negotiated revision; no modern envelope, `server/discover`, or Tasks required). Dual-era mixing on one connection is forbidden.
- **Accountable capability matrix (`capabilityMatrix.ts`):** One row per core surface, official extension, or selected experimental candidate, carrying authority, disposition (`supported`, `partial`, `excluded`, `deferred`), advertisement (`always`, `conditional`, `none`), interactivity, and evidence citations. Static wire advertisement (`staticClientCapabilities`) derives from `always` rows; `conditional` extensions are added by connection logic ({§oauth-client-credentials}).

| Surface | Upstream contract | Plurnk host disposition |
| --- | --- | --- |
| Base | JSON-RPC 2.0; per-request protocol, identity, and capability metadata; every result has `resultType` | Require the modern envelope and preserve protocol results and errors without reconstructing them. |
| Discovery | `server/discover` | Probe before registration; retain identity, instructions, capabilities, versions, and cache hints. |
| Tools | `tools/list`, `tools/call` | Build one operator-filtered exact Registry snapshot at setup; route only its enabled names without renaming them. |
| Resources | `resources/list`, `resources/templates/list`, `resources/read` | Publish catalogs, templates, and materialized contents through the server's resource authority. |
| Prompts | `prompts/list`, `prompts/get` | Publish prompt definitions and retrieve prompt messages through the same server authority. |
| Completion | `completion/complete` | Make prompt and resource-template completion available to the host interaction that owns the argument. |
| Pagination | Opaque cursors on list methods | Drain every page; refuse repeated cursors with `CatalogNonConvergenceError` (method and cursor named) so partial catalogs are never published or cached (#601). |
| Deadlines & Pacing | `PLURNK_MCP_CONNECT_TIMEOUT` (default `30000` ms), `PLURNK_MCP_REQUEST_TIMEOUT` (default `86400000` ms), `PLURNK_MCP_RETRY_FLOOR_MS` (`250` ms) .. `PLURNK_MCP_RETRY_CEILING_MS` (`5000` ms) | `CONNECT_TIMEOUT` bounds connection setup and each complete catalog/list walk; `REQUEST_TIMEOUT` bounds tool calls, resource/prompt reads, and client-input waits. Adapter-scheduled retries double from `RETRY_FLOOR_MS` up to `RETRY_CEILING_MS`. |
| Unsupported list absence | First-page JSON-RPC `-32601` on `tools/list`, `resources/list`, `resources/templates/list`, or `prompts/list` | Yields an empty collection and availability detail naming the unsupported method without disabling the server; errors after page 1 or other protocol/transport errors remain failures. |
| Caching | `ttlMs` and `cacheScope` on `server/discover`, list methods, and `resources/read` | Honor freshness and notification invalidation; partition private entries by authorization context. |
| Subscriptions | `subscriptions/listen` + acknowledged filters and correlated notifications | Keep one current filter for list changes, cached resource URIs, and active Task IDs; overlap filter replacement, re-listen after loss. |
| Progress & Cancellation | Request-scoped `notifications/progress`; HTTP stream close / stdio `notifications/cancelled` | Project progress onto the owning Plurnk operation; drive cancellation from the owning Plurnk abort signal. |
| MRTR & Elicitation | `input_required` on `tools/call`, `resources/read`, or `prompts/get` | Advertise form/URL elicitation modes; echo opaque `requestState` byte-for-byte; retry only the originating request with a fresh JSON-RPC ID. |
| Authorization | OAuth profile for HTTP transports | Require validated protected-resource and authorization-server metadata; never infer endpoints; use PKCE, issuer validation, resource indicators, refresh, and bounded scope escalation; never apply OAuth to stdio. |
| Exclusions | Deprecated/removed/excluded surfaces | Exclude Roots, Sampling, Logging, legacy HTTP+SSE, `ping`, `logging/setLevel`, `notifications/roots/list_changed`, `resources/subscribe`, `resources/unsubscribe`, SSE `Last-Event-ID`, legacy `tasks/list` & `tasks/result`; prefer pre-registration/CIMD over DCR (never probe inferred `/register`). |

## §mcp-tasks Tasks extension, subscription ownership, and lifetime

- **Tasks protocol (`io.modelcontextprotocol/tasks`):** Advertised only when its complete lifecycle is active. When `tools/call` returns an unsolicited `resultType: "task"` handle, the host uses `tasks/get`, `tasks/update`, and `tasks/cancel`, honoring `pollIntervalMs` under `PLURNK_MCP_REQUEST_TIMEOUT`. Task input keys are fulfilled at most once in one atomic client interaction per observed input set.
- **Subscription ownership:** Notification filters belong to the shared `ServerConnection`, not an individual operation. Acquiring/releasing Task interest schedules a filter update without blocking `tasks/get` polling, settlement, or cancellation. Cancelling one resource READ ends only that caller's wait without cancelling another caller's subscription setup or closing the connection.
- **Tasks lifetime:** Task handles are process-local, never persisted or automatically replayed ({§session-causal-admission}):

| Boundary | Behaviour |
| --- | --- |
| Client interrupt / reattach | Live operation retains pending input across the Run boundary; synchronization re-presents it ({§acp-history-window}). |
| Client hangup / Graceful shutdown | Inherits owning client's cancellation/detachment semantics; shutdown aborts and settles owned work before closing the protocol connection ({§mcp-setup}). |
| Restart / Workspace reactivation | No Task resume or automatic tool replay on restart; reactivation reconstructs the attachment from its definition. Active Tasks retain workspace residency ({§module-workspace-residency}). |
| Expiry / Cancellation / Terminal | Operation deadline bounds client-input waits ({§mcp-host-composition}); expiry or owner abort invokes `tasks/cancel` before settling; terminal Tasks are never re-polled or re-resumed. |

## §mcp-transports Transport bindings, security, header declarations, and errors

| Binding | Contract |
| --- | --- |
| `stdio` | Spawn one exact executable with an explicit argument array and no shell; newline-delimited JSON-RPC on stdout/stdin; stderr is diagnostic. Owns the complete process group (watchdog wrapper): forwards stdin EOF for bounded graceful exit, then forcibly terminates the process group (including descendants) on timeout or parent SIGKILL. |
| `streamable-http` | Send one POST per request or notification; accept JSON or SSE responses; close the response stream to cancel; modern connections never open a general GET stream. Accepts HTTP or HTTPS (including private-network hosts) while retaining SDK token-endpoint TLS enforcement (with loopback exception), issuer/resource binding, and PKCE. Every HTTP request sets `redirect: "manual"`; 301/302/303/307/308 fails with `McpRedirectError` (`502 server-redirected`) naming `Location` so configured headers never reach another origin. |

- **HTTP protocol & routing headers:** At `2026-07-28`, HTTP requests carry `MCP-Protocol-Version` and `Mcp-Method`. Named requests carry `Mcp-Name` (encoded `taskId` for `tasks/get`, `tasks/update`, `tasks/cancel`; safe ASCII preserved, ambiguous values encoded as `=?base64?...?=`). Declared primitive tool parameters carry `Mcp-Param-*` headers.
- **`x-mcp-header` declarations (SEP-2243):** Before either request leg of a tool call (Tasks or direct), the tool's `inputSchema` is scanned for `x-mcp-header`:
  - Must sit on a property reached through `properties` alone (never under `items`, `additionalProperties`, `oneOf`/`anyOf`/`allOf`, `if`/`then`/`else`, `$defs`, or `$ref`).
  - Header name must be a non-empty RFC 9110 token, unique case-insensitively across the tool.
  - Property `type` must be `string`, `integer`, or `boolean` (never `number`, `object`, `array`, `null`, or untyped).
  - Violation refuses the call before any request is sent with `HeaderDeclarationError` $\to$ `502 tool-header-invalid` ({§mcp-model-projection}) naming `tool` and `declaration`.
- **Error allocation:** Standard JSON-RPC `-32700`, `-32600`, `-32601`, `-32602` (missing resource/task handle), `-32603`; `-32003` (Tasks capability absent); `-32020` `HeaderMismatch` (HTTP 400); `-32021` `MissingRequiredClientCapability` (HTTP 400); `-32022` `UnsupportedProtocolVersion` (HTTP 400); `-32000..-32019` server-private. A tool-level `isError: true` is a completed tool result (`502 tool-reported-error`), whereas a failed Task preserves its JSON-RPC protocol error (`502 tool-call-failed`).

## §mcp-configuration Configuration, files, plugins, isolation, and summaries

MCP servers are complete connection definitions ({§contracts-ownership}, {§configuration-authority}, {§functionality-coordinator}). Definitions resolve by alias (`[a-z][a-z0-9-]*`), highest precedence first:

| Precedence | Source | Location / Key |
| --- | --- | --- |
| 1 | Workspace overlay | `plurnk (mcp)` `add` / `replace` state (never writes/deletes host `mcp.json` files) |
| 2 | Environment | `PLURNK_MCP_<alias>` (complete `McpServerDefinition` JSON; transport and auth replace together) |
| 3 | Project | `<project>/.agents/mcp.json`, then selected project plugins |
| 4 | Plurnk-only | `$XDG_CONFIG_HOME/plurnk/mcp.json`, then selected Plurnk plugins |
| 5 | Shared global | `~/.agents/mcp.json`, then selected global plugins |
| 6 | Installed npm plugins | Selected plugin bundles in the installed graph |

- **Standalone `mcp.json` files:** Object with required `mcpServers` map and optional `$schema` string. Omitted `type` is inferred from `command` (`stdio`) or `url` (`streamable-http`). Whole winning entry is selected before validation (no field merging or fallback from an invalid winner). Reported with `provenance: { kind: "file", source: <file>, reference: "/mcpServers/<alias>" }`.
- **Agent Plugins (`PluginConfiguration`):** Validated plugin components ({§agent-plugins-containment}, {§agent-plugins-containment}, {§functionality-adapter}) carry `{ root, data }` context and `provenance: { kind: "plugin", source, reference }`:
  - `command`: bare executable or plugin-root-relative `./` path (no placeholder expansion).
  - `args`, `env`, `cwd`: one nonrecursive expansion of `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` only; all other `${...}` text stays literal. Omitted `cwd` defaults to `root`; explicit `cwd` and relative `./` command paths must resolve inside `root` or `data` (checked via `realpath` before launch). `PLUGIN_ROOT` and `PLUGIN_DATA` are injected into the child environment.
  - Unsupported transport (e.g., `sse`) or invalid server name is skipped with a configuration notice without blocking valid siblings.
- **Environment knobs ({§env-knob}):**
  - `PLURNK_MCP_ENABLED` (default `1`), `PLURNK_MCP_<alias>_ENABLED` (`0` or `1`).
  - `PLURNK_MCP_<alias>_TOOLS`: optional JSON array of enabled tool names; absent/`""` enables all, `[]` enables none.
  - `PLURNK_MCP_EXPANDED`: JSON array of aliases whose tool invocations are surveyed at turn 0 ({§system-entry-owners}); default `[]`.
  - `PLURNK_MCP_REGISTRY_URL` (default `""`), `PLURNK_MCP_REGISTRY_LIMIT` (default `5`).
  - Native `stdio` definitions expand `${NAME}` once in `args`, `env`, and explicit absolute `cwd` against the workspace-composed operator environment; implicit `cwd` uses Core's workspace-and-alias state directory ({§module-seam-slices}). `streamable-http` definitions expand `${NAME}` in `headers` and `authorization` (`bearer.token`, `client-credentials.clientSecret`, `oauth.clientSecret`) only at connection preparation; supplying both `authorization` and an `Authorization` header is invalid.
- **Cold endpoint isolation & unavailable runtimes:** Cold failure during workspace activation leaves the server enabled and client-visible as `unavailable` (or `authorization-required`). Preparation still registers the alias as an unavailable runtime ({§exec-lifetime}) whose availability detail names `it awaits the operator's sign-in` (for `authorization-required`) or its Problem's bounded diagnostic/detail (for `unavailable`).
- **Summary derivation:** Whitespace-normalized, first sentence, clipped within 80 chars + `…`:
  - **Server:** `serverInfo.description` $\to$ `instructions` $\to$ `serverInfo.title` $\to$ effective admitted tool-name list (`Tools: ...`) $\to$ `MCP server <alias>.` With tools, `runtimeDecl` uses `{ from: "tools", description? }` and full `instructions` as `details` ({§scheme-contract}, {§system-entry-owners}).
  - **Tool:** `description` $\to$ `title` $\to$ `annotations.title` $\to$ tool `name`.

## §mcp-module Module adapter, launch environment, management, registry, and diagnostics

- **Setup-only module (`@plurnk/plurnk-mcp`):** Registers the `mcp` family adapter ({§module-lifecycle}, {§functionality-coordinator}) and workspace actions `workspace.mcp.oauth.begin`, `workspace.mcp.oauth.complete`, and `workspace.mcp.complete`. Invalid `PLURNK_MCP_REGISTRY_URL` or `PLURNK_MCP_REGISTRY_LIMIT` is contained in `module.contained` ({§module-contract}), withholding `discover` while keeping the family operational.
- **Stdio launch environment:** Receives (1) operator ambient base excluding `PLURNK_*` and provider credential names ({§exec-stream}), (2) workspace shared `env` values and masks, and (3) definition `env` values with `${NAME}` resolved once against the workspace-composed operator environment ({§functionality-model-projection}, {§capability-admission}).
- **Registry discovery (`discover`):** Active when `PLURNK_MCP_REGISTRY_URL` is non-empty; queries `<url>/v0.1/servers?search=<query>&version=latest&limit=<limit>`. Converts launchable `npm` (`npx -y`), `pypi` (`uvx`), `nuget` (`dnx`), and `oci` (`docker run -i --rm`) stdio packages and `streamable-http` remotes into self-contained definitions (`aliasOf` takes the last name segment, lowercased, `[a-z][a-z0-9-]*`), omitting entries requiring user template variables or missing required positional arguments. Failures reject with `502 discover-failed` (retryable); invalid definitions reject with `400 definition-invalid` or `400 alias-mismatch`.
- **Preparation diagnostics (`PreparationDiagnostics`):** `502 server-unavailable` carries `elapsedMs`, `timeoutMs`, bounded `diagnostic` (innermost cause chain first, excluding OAuth error text), and bounded `stderr` tail, each capped at `PLURNK_EXECS_ERROR_DETAIL_LIMIT` (`0` omits text). Redacts known launch-environment values, configured args/headers, referenced env values, and URL userinfo with `__redacted__` across chunk and truncation boundaries before slicing.

## §oauth-continuation Interactive OAuth continuation, issuer, lifetime, and grants

- **Sign-in continuation (`workspace.mcp.oauth.begin` / `workspace.mcp.oauth.complete`):**
  - Unauthenticated HTTP 401 publishes `authorization-required` with `authorization: {}` (or `authorization: { url }` when `redirectUrl` is pre-configured on the definition).
  - `oauth.begin({ alias, redirectUrl })` prepares a pending candidate per `(workspace, alias)` holding one workspace residency lease ({§module-workspace-residency}), returning `202` with `authorization.url` (or `202` without `url` when an unchallenged connection is accepted as-is, or `200` when already active). Concurrent begins for the same alias reject with `409 oauth-busy`.
  - When an alias awaits sign-in because a request was refused ({§mcp-host-composition}) and `oauth.begin`'s connection meets no catalog challenge, `begin` starts the SDK's authorization on that connection anyway.
  - `oauth.complete({ alias, callbackUrl })` validates `state`, `code`, and `iss` as one unit, exchanges the code once, records the grant, and triggers capability refresh (`202`).
- **Configured issuer (`authorization.issuer` & `authorization.authorizationParams`):** Discovery reads RFC 8414 / OIDC metadata at `issuer` whether or not the MCP server publishes protected-resource metadata, binding registration, tokens, and refresh to `issuer`. Without `issuer` or server metadata, sign-in fails `502 oauth-metadata-unavailable` (recovery names `authorization.issuer`). `authorizationParams` (e.g., `access_type: "offline"`, `prompt: "consent"`) join the authorization URL.
- **Process-memory lifetime & grants (`OAuthGrantSummary`):** Tokens and PKCE verifiers never touch SQLite. An accepted sign-in is held in memory per `(workspace, alias)` bound to the exact definition it was accepted for:
  - Presented and refreshed via `refresh_token` across workspace cooling, explicit `enable`, and `disable`+`enable` with the same definition, and summarized in `detail.grant: { issuer, scope?, refreshable }`.
  - Never presented to a changed definition or another workspace.
  - Ends when rejected by the authorization server or on daemon stop; replaced when a new sign-in is accepted.

## §oauth-client-credentials Client-credentials grant and EMA deferral

- **`client-credentials` (`io.modelcontextprotocol/oauth-client-credentials`):** Advertised in `clientCapabilities.extensions` only on connections whose definition configures `authorization.type === "client-credentials"`. Uses `client_secret_basic` with `grant_type=client_credentials`, optional `scope`, and optional `issuer` (`expectedIssuer`). `clientSecret: "${NAME}"` expands per connection preparation. Rejected grants fail with `502 oauth-client-credentials-failed` (non-retryable, naming server and `clientId` only). JWT assertion arms are excluded.
- **Enterprise-managed authorization (`io.modelcontextprotocol/enterprise-managed-authorization`):** Deferred and non-advertised; headless daemon does not own interactive SSO assertion acquisition, durable identity storage, or org-level IdP configuration.

## §mcp-setup Atomic setup, in-place catalog refresh, and connection shutdown

- **Atomic setup:** Opens and discovers enabled connections in parallel, lists catalogs, applies `<alias>_TOOLS` and `readOnlyHint` policy, and submits one snapshot. Missing configured tools, duplicate remote tool names, or unrepresentable target names fail activation.
- **In-place catalog refresh:** `notifications/tools/list_changed` (and resource/prompt list changes) coalesce under a refresh timer, re-list over the existing connection, and atomically republish through {§functionality-coordinator}. Active protocol requests, MRTR exchanges, or Tasks reject connection replacement with `409 server-busy`.
- **Connection shutdown (`Module.stop()` / `connection.close()`):** Prevents new work, aborts active requests and client-input waits, honors host preparation `AbortSignal` ({§functionality-adapter}) after async env/directory resolution, awaits `tasks/cancel` before closing the extension channel/transport, and retires subscription watches without redundant per-listen cancellation ({§module-shutdown-order}).

## §mcp-host-composition Protocol-to-Plurnk composition, deadlines, Problems, and unauthorized requests

- **MRTR & client interactions:** `input_required` routes each embedded elicitation (`mode: "form"` or `mode: "url"`) through `interact(request, signal)` (`toolName: "mcp_input_required"`), keeping `requestState` private and bounding rounds at 10. Unclaimed input families (e.g., `sampling/createMessage`) fail before opening an interaction (and cancel any owned Task).
- **Input deadline:** Client-input waits consume the remaining `PLURNK_MCP_REQUEST_TIMEOUT` budget across MRTR rounds and Task inputs rather than resetting per round.
- **Tool replay & Problem detail:** `tool-call-failed` (`502`) is always `retryable: false` because post-dispatch transport failure cannot prove the remote effect did not occur. Tool Problems carry `runtime`, `tool`, and bounded `diagnostic` (from the error cause or joined nonblank text blocks of `isError: true`) as structured fields, while `detail` states only the boundary fact.
- **Request-time 401 (`authorization-required`):** When an `active` server with a URL-only or interactive `oauth` definition refuses `tools/call`, `resources/read`, `prompts/get`, or `completion/complete` with HTTP 401 (or an unrefreshable interactive grant), the request fails `401 authorization-required` (non-retryable) and republishes the alias as `authorization-required` (out of service, `detail: "it awaits the operator's sign-in"`). Configured `bearer`, `client-credentials`, or `Authorization` header definitions fail as ordinary request errors without state change.
- **Trailing HTML comment aside:** When a tool call body does not parse directly as JSON, trailing `<!-- … -->` comments after the single JSON object are stripped before parsing (#758); any other non-object body fails `400 invalid-tool-arguments`.

## §mcp-result-content Result content, prompt content, Apps exclusion, and Skills deferral

- **Tool result channels:** `#json` stores the complete raw MCP result object. Default `#body` writes the result without the envelope: single/multiple text blocks join with `\n` (pretty-printed `application/json` via `renderJsonResult` when a complete JSON document, else `text/plain` under {§contracts-ownership}); empty `content` with `structuredContent` writes pretty-printed JSON; inline `image`/`audio` and embedded `resource` items publish via `entry(null, ...)` ({§executor-output-address}) and link as `<runtime>:///<id>/resources/<name-or-hex8>`; `resource_link` items link as `<runtime>:///resources/<encoded-uri>`. Standalone `blob` items in `tools/call` are rejected as protocol-invalid.
- **Prompt content (`/prompts/<name>?key=val`):** Preserves `#json` raw response and writes projected `GetPromptResult` JSON to `#body` where non-text parts become `resource_link` items pointing to snapshot children under `/prompts/<name>/resources/<name-or-hex8>` (or `<runtime>:///resources/<encoded-uri>` for remote `resource_link`s) ({§log-wire-format}, {§scheme-contract}). Reading a snapshot never re-executes the prompt.
- **Exclusions:** MCP Apps (`_meta.ui` remains inert in raw catalogs and is excluded from compact invocations) and `io.modelcontextprotocol/skills` (SEP-2640, #654) are not advertised or implemented.

## §mcp-model-projection Model projection, tool presentation, conformance, and Problems

| MCP surface | Plurnk surface |
| --- | --- |
| Server | Runtime `<server>`, `workspace:///_plurnk/tools/<server>.md`, and resource scheme `<server>:///` ({§exec-stream}) |
| Enabled tool & raw catalog | Compact invocation in `<server>.md`, schema doc `workspace:///_plurnk/tools/<server>/<encoded-tool>.json`, and full catalog `workspace:///_plurnk/tools/<server>.json` (`{"tools":[...]}` sorted by name) ({§executor-discovery}) |
| Resources & Prompts | `<server>:///`, `<server>:///resources[/<encoded-uri>]`, `<server>:///prompts[/<encoded-name>]` (never lists tools) |
| Tool effect | `annotations.readOnlyHint === true` $\to$ `read`; all other enabled tools $\to$ `host` (unregistered target throws) |

- **Conformance authority:** `@modelcontextprotocol/conformance@0.2.0-alpha.12` (`--requirements 2026-07-28`, 39 client scenarios including SEP-2243 `http-invalid-tool-headers`, plus `--scenario auth/client-credentials-basic`).

| Problem code | Status | Contract (`detail` and `recovery`) |
| --- | --- | --- |
| `tool-required` | 400 | An MCP tool target is required. Recovery: `Select a target documented under workspace:///_plurnk/tools/<runtime>/.` |
| `tool-not-enabled` | 404 | The MCP tool is not enabled. Recovery: `Select a target documented under workspace:///_plurnk/tools/<runtime>/.` |
| `tool-reported-error` | 502 | The MCP tool reported an error. Recovery: the tool's working invocation fence with its schema note and schema link (#1228). |
| `tool-call-failed` | 502 | The MCP tool call failed (`retryable: false`, with `runtime`, `tool`, and bounded `diagnostic`). |
| `invalid-tool-arguments` | 400 | MCP tool arguments must be one JSON object. Recovery: `One JSON object per MCP tool call.` followed by the tool's working invocation fence (#1228). |
| `tool-header-invalid` | 502 | `MCP tool '<name>' declares an invalid x-mcp-header; the tool was not called.` (`tool` and `declaration` fields). |
| `resource-address-invalid` | 400 | The MCP resource address is invalid (`retryable: false`). |
| `resource-part-not-found` | 404 | The resource response does not contain this part / the requested part. |
| `resource-read-failed` / `resource-find-failed` | 502 | MCP resource preparation / listing failed (`retryable: true`, with bounded `diagnostic`). |
| `authorization-required` | 401 | `MCP server '<name>' awaits the operator's sign-in; the request was not completed.` |
| `server-authentication-failed` | 502 | `MCP server '<name>' rejected authentication (HTTP 401).` (`upstreamStatus: 401`). |
| `oauth-client-credentials-failed` | 502 | `MCP server '<name>' rejected the client-credentials grant.` |
| `oauth-metadata-unavailable` | 502 | `MCP OAuth requires validated authorization-server metadata, and the server provided none.` Recovery (when no issuer): `Name the authorization server as the definition's authorization.issuer.` |
| `oauth-registration-unavailable` | 502 | `No client is registered with the authorization server: none is configured for it, it advertises no Dynamic Client Registration endpoint, and no client metadata document it accepts is configured.` |
| `oauth-redirect-invalid` | 400 | `The OAuth callback must use HTTPS or HTTP loopback with a usable port.` |
| `oauth-configuration-conflict` | 409 | `MCP server '<alias>' is not configured for this interactive OAuth callback.` |
| `oauth-busy` | 409 | `MCP server '<alias>' is already starting authorization.` |
| `oauth-not-pending` | 404 | `MCP server '<alias>' has no pending OAuth authorization.` |
| `oauth-target-conflict` | 409 | `MCP server '<alias>' changed while its OAuth authorization was pending.` Recovery: `Start authorization again from the server's current definition.` |
| `oauth-callback-invalid` | 400 | `OAuth authorization for MCP server '<alias>' could not be completed.` |
| `parameters-invalid` / `completion-parameters-invalid` | 400 | `Unsupported parameter(s): <names>.` / `MCP completion requires 'ref' and 'argument' objects.` |
| `server-settings-invalid` | 422 | `MCP server '<name>' has invalid operator settings: <cause>.` |
| `server-busy` / `server-not-connected` | 409 | `MCP server '<name>' has <n> active request(s).` / `MCP server '<name>' is not connected for this workspace.` |
| `obsolete-connection-close-failed` | 500 | `The MCP capability change committed, but an obsolete connection did not close cleanly.` |
| `server-unavailable` | 502 | `Configured MCP server '<name>' is unavailable.` |
| `server-redirected` | 502 | `MCP endpoint <url> redirected to <location>; plurnk follows no redirect, so the server's url must be the endpoint itself.` |
| `discover-failed` / `definition-invalid` / `alias-mismatch` | 502 / 400 | Registry discovery failed (`retryable: true`) / definition invalid / alias differs from definition name. |

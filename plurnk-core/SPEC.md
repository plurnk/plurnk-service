# plurnk-service — Specification

Canonical contracts plurnk-service exposes, architecture it implements, promises it makes to the constellation (`plurnk-contracts`, `plurnk-providers`, `plurnk-schemes`, `plurnk-mimetypes`, `plurnk-execs`, the user-facing `plurnk` CLI). `AGENTS.md` covers process; this file covers contract.

## Contents

- [Glossary](#glossary)
- [Architecture](#architecture)
- [Sessions and workspace boundaries](#actor-boundary-sessions-and-workspace-boundaries)
- [File membership and project roots](#membership-file-membership-and-project-roots)
- [Loop scheduling and lifecycle](#session-loop-lifecycle-loop-scheduling-and-lifecycle)
- [Provider Contract](#provider-surface-provider-contract)
- [Scheme Contract](#scheme-scheme-contract)
- [Mimetype Contract](#mimetype-mimetype-contract)
- [Search indexing](#persistent-search-index-search-indexing)
- [Channel Topology](#channels-channel-topology)
- [Op Surface](#op-surface)
- [Text line anchors](#line-anchors-text-line-anchors)
- [EDIT](#edit-edit)
- [READ](#read-read)
- [The Log](#log-history-projection-the-log)
- [COPY](#copy-copy-engine-orchestrated)
- [MOVE](#move-move-engine-orchestrated)
- [FIND](#find-find)
- [Messaging and turn disposition](#send-messaging-and-turn-disposition)
- [Executions](#exec-executions)
- [Proposals and client interactions](#proposal-proposals-and-client-interactions)
- [Stream Model](#stream-stream-model)
- [Storage Model](#storage-model)
- [Extension composition](#core-extension-composition-extension-composition)
- [Bundled Set](#bundled-set-bundled-set)
- [Grammar Dependency](#grammar-dependency)
- [Operator Configuration](#operator-config-operator-configuration)
- [Module seam](#rpc-module-seam)
- [Workspace Functionality](#functionality-coordinator-workspace-functionality)
- [Application interface](#methods-application-interface)
- [Packet assembly](#packet-assembly-packet-assembly)
- [Packet shape](#packet-packet-shape)
- [Matcher selection and text regions](#matcher-selection-and-text-regions)
- [Testing and evidence](#testing-and-evidence)

---

## Glossary

### §lifecycle-terms Lifecycle, storage, execution, and packet vocabulary

```mermaid
flowchart LR
    W["Workspace<br/>shared resources and configuration"] --> K["Session<br/>actor and history"]
    K --> L["Loop<br/>queued-to-terminal work"]
    L --> T["Turn<br/>one admitted scheduling unit"]
    T --> O["Op<br/>one statement / action row"]
    H["ACP thread<br/>names a session"] -. resolves to .-> K
    R["ACP Run<br/>client stream envelope"] -. binds to .-> L
    R -. or executes .-> A["Management action<br/>no core loop required"]
```

| Term | Layer | Meaning |
|---|---|---|
| **agent** | PLURNK | The plurnk runtime acting in-workspace as the `_plurnk` session ({§actor-boundary}), never a privileged singleton owning entries ({§execution-output-identity}, {§machine-processes}). |
| **workspace** | Core | Durable shared resources, configuration, and optional `project_root`. Identity: `workspaces.id`; mutable label: unique `workspaces.name`. |
| **session** | Core | Durable actor and history over one workspace (`parent_session_id` optional, one process-local cancellation scope while active). |
| **loop** | Core | Queued-to-terminal unit of work within a session (`100` pending · `102` running · `200` done · `202` waiting, {§send} · `413` input-capacity · `429` turn ceiling · `499` cancelled · `500` failed · `504` timeout, {§operator-config-workspace-settings} · `508` runaway). |
| **turn** | Core | One durable, producer-neutral batch of ordered operations (`(loop_id, sequence)`) authored by `model`, `client`, or `_plurnk`; only a model turn assembles a packet and owns an emission call. |
| **model call** | Core/provider | One logical `provider.generate` invocation (`(turn_id, sequence)`); emission attempts and BARE inferences share this owner while retries are physical requests beneath it. |
| **op / statement / action / dispatch** | Core | An op is one submitted DSL operation ({§turn-record}), parsed into a `PlurnkStatement` AST, dispatched to its scheme handler, and recorded as a `log_entries` action row at `log:///<L>/<T>/<S>/<op>` (or `op='error'`, {§operation-results}). |
| **ACP Run / ACP thread** | ACP | A client stream envelope (`runId`) bound to a core loop or management action; within a workspace, `threadId` resolves to one model session. |
| **entry / channel** | Storage | Canonical state unit `(workspace_id, scheme, authority, pathname)` ({§db-migrations}) holding named `channels` (`body`, `stdout`, `stderr`, `headers`, `symbols` with `content`, `mimetype`, `weight`, and `state`: `static \| active \| closed \| errored`) plus scheme `attributes`. |
| **scheme / mimetype / provider** | Extensions | Addressable namespace handler ({§scheme-surface}), content-type structural projector ({§mimetype}), and LLM transport adapter ({§provider-surface}). |
| **status / proposal state / outcome** | Execution | Operation HTTP status on `log_entries.status_rx` ({§operation-results}); proposal lifecycle `proposed \| resolved \| failed \| cancelled` ({§proposal}); short terminal reason string (`outcome`). |
| **writer / origin / writable_by** | Authority | Identity authoring a write (`model \| client \| _plurnk`, logged as `log_entries.origin`); engine enforces scheme `manifest.writableBy` with `403` ({§subscriptions}). |
| **verdict / strike / emission attempt / cycle** | Engine | End-of-turn ruling ({§loop-terminals}); turn matching a rail ({§engine-rails}); provider exchange under {§emission-admission}; repeated operational inputs/results ({§engine-rails}). |
| **BARE inference** | Engine | Isolated child-provider model call whose response becomes an ordinary BARE log result without session, packet, tools, or output grammar ({§op-methods-op-dispatch}). |
| **capability policy / approval owner / proposal / resolution** | Governance | Subtractive `only`/`deny` selector layers; workspace-scoped approval recipient ({§session-ownership}); deferred side-effecting action ({§proposal-disposition}); client decision settling a proposal ({§methods}) or interaction ({§methods}, {§acp-proposal-resolve}). |
| **packet / log / render** | Packet | Turn's optional model-exchange record (`sections`, plus `assistant`/`assistantRaw` on admitted emission); chronological `log` section of in-scope `log_entries`; packet computation under {§packet-assembly} and {§packet-markdown}. |

---

## Architecture

### §observability-boundary Observability and package boundaries

OpenTelemetry may observe PLURNK; it never becomes product state, failure transport, scheduler input, model teaching, or client protocol. Domain and client activity remain on ACP. Reusable packages and the daemon depend on the OTel API only; `@plurnk/plurnk-otel` constructs configured trace and metric providers from standard `OTEL_*` variables ({§otel-module}, {§otel-contained}), while unconfigured or disabled processes keep no-op behavior and OTel Logs have no provider path. Telemetry shutdown runs at module `stop` ({§module-shutdown-order}); exporter failure never alters product results.

| Surface | Contract |
|---|---|
| HTTP & general spans | HTTP spans carry only an ACP-owned bounded route class (never pathname/query); other spans carry high-cardinality IDs while metric labels stay low-cardinality; prompts, reasoning, file bodies, arbitrary URLs, secrets, and extension payloads are never recorded by default. |
| GenAI convention projection | Provider request spans follow the GenAI registry (`c88d504` on core v1.44.0): a `CLIENT` `chat {model}` span with `gen_ai.operation.name="chat"`, `gen_ai.provider.name` (constructed route provider ID, or `other`), `gen_ai.request.model`, settled `gen_ai.usage.input_tokens`/`output_tokens` ({§tokenomics-provider-usage}), `gen_ai.response.finish_reasons`, and failure `error.type` alongside Plurnk attempt/kind/status/loop/turn attributes. |
| Service session composition | Both the service launcher and live/demo workspace helper discover ACP, MCP, Schedule, and command hooks ({§module-lifecycle}); management families and reference docs exist even with no enabled definitions, governed by workspace capability policy and {§operator-config-precedence}. The launcher binds the one listener ({§http-host}); the helper binds none ({§module-http-mounts}). |
| Package export surface | `@plurnk/plurnk-service` exports only `./launch` ({§startup-admission}), `./evidence` ({§digest-evidence-reader}), and `./package.json`. |

### §startup-admission Startup, listener admission, and service commands

```mermaid
flowchart LR
    LISTENER["Bind HTTP listener<br/>unadmitted: HTTP 503"] --> DB["Acquire lock and<br/>admit SQLite schema"]
    DB --> DAEMON["Discover and<br/>start modules"]
    DAEMON --> CLIENT["Admit listener<br/>print readiness line"]
    CLIENT --> SELECT["Session selects or<br/>first uses a model"]
    SELECT --> PROVIDER["Construct and verify<br/>selected provider"]
    LISTENER -. failure .-> FAIL["Fail startup<br/>durable state untouched"]
    DB -. failure .-> CLOSE_LISTENER["Close listener"] --> FAIL
    DAEMON -. failure .-> TEARDOWN["Close started owners<br/>in reverse order"] --> FAIL
    PROVIDER -. failure .-> REPAIR["Return selection failure<br/>client remains available"]
```

- **Runtime floor**: Before any other module of `plurnk-service` evaluates, it checks `process.versions.node` against `engines.node`; below the floor it writes one stderr line naming both versions and exits `1` before binding a listener or touching durable state.
- **Listener and admission order**: The production service binds its listener ({§http-host}) before creating, opening, migrating, or mutating anything in the durable data directory; losing the bind race leaves storage byte-identical. Core answers `503 service-starting` until database admission and all module starts complete ({§module-http-mounts}). Startup validates model selectors without provider I/O; provider construction and endpoint verification happen on session selection or first use. Any startup failure closes started resources in reverse order (`daemon`, `observability`, `database`, `listener`).
- **Readiness line**: Once admitted, the service prints one stdout line `plurnk-service acp=<url> db=<json string> route=<json string>` (with IPv6 hosts bracketed and `db`/`route` JSON-encoded). After readiness, `discover` distinguishes this daemon from any other listener.
- **Daemon launcher (`@plurnk/plurnk-service/launch`)**: Spawns a daemon argv with caller-supplied `readyTimeoutMs` and `stopGraceMs` ({§host-path-layout}), resolving on the readiness line with `{ acpUrl, dbPath, route, logFile, stop }`. Failed starts stop and await the child before throwing with both output streams. `"private"` lifetime pipes streams to the parent and terminates with it; `"shared"` runs in its own process group, appends streams to `logFile` (default `<state dir>/service.log`), reads readiness from that file, and unrefs the child.
- **`plurnk-service stop`**: Reads the owning PID from the database lock, sends `SIGTERM`, and returns `0` once the process exits ({§module-shutdown-order}); an unlocked database reports not running and exits `0`.
- **Explicit update (`PLURNK_SERVICE_UPDATEABLE`)**: Nothing phones a third party or installs packages automatically. Startup loads `$XDG_CACHE_HOME/plurnk/models.json` if present ({§model-catalog-cache}). When `PLURNK_SERVICE_UPDATEABLE=1` (default), `plurnk-service update`, `updateService()`, `service.update`, or `/update` atomically refreshes `models.json`, hot-swaps the active catalog, and updates installed `@plurnk/plurnk-service` (and co-installed `@plurnk/plurnk`) via `npm` (or reports `status: "source"` in a checkout). When `0`, update requests fail with `403 update-disabled`.

### §http-host Shared HTTP host and request origin

Core binds one HTTP listener on `PLURNK_HOST:PLURNK_PORT` and exposes `registerHttpRoute(prefix, handler)`, `registerHttpUpgrade(prefix, handler)`, and `httpAddress()` on the application port ({§application-port}, {§module-lifecycle}).

| Aspect | Rule |
|---|---|
| Prefix matching | Absolute pathnames claiming themselves and their subtree (`/` is root); longest mounted prefix with the matching handler kind (`route` vs `upgrade`) wins without falling through to a shorter prefix. |
| Admission & errors | Before activation every request gets `503 service-starting`; unparsable targets get `400 request-target-invalid`; unmatched paths get `404 route-not-found`; throwing handlers return `500 route-failed` (or abort in-flight streams) without crashing the listener ({§module-http-mounts}). |
| Request origin | `requestOrigin` is the configured public origin, else the request's `Host` over HTTP, else the listener's own address. Every advertised URL (including OAuth issuer, {§auth-oauth-endpoints}) uses `requestOrigin`, and no request is refused for the hostname it used. |

### §credential-authority Credential authority

Every credential presented to the listener is an opaque in-memory token (`access`, `refresh`, or browser `session`) issued by the daemon's `credentials` authority ({§application-port}) with subject, client, scopes, family, and expiry. Restart revokes all credentials; revoking a family revokes its access, refresh, and browser session tokens together, and replaying a consumed refresh token revokes its family. The issuing module publishes `{ issuer }` at setup ({§module-phases}, {§acp-http-authorization}, {§auth-oauth}).

| Surface | Rule |
|---|---|
| `PLURNK_AUTH` posture | When `1`, holds `PLURNK_SECRET` or mints a `0600` `secret` file beside the database before admitting mounts and requires a published auth face; when `0`, no secret file or face exists and mounts admit anonymously ({§operator-config-precedence}). |
| Confidential module clients | At setup a module calls `registerClient({ id, redirectPaths, scopes, stylesheetPath })` (`id` matching `[A-Za-z0-9._-]+` except `operator`; pathnames under its own mounts without query/fragment, {§auth-oauth-documents}, {§auth-oauth-endpoints}). The authority mints an in-memory secret for the registrant and verifies it in constant time (`authenticateClient`, {§auth-oauth-clients}); duplicate or malformed registrations throw. |
| Credential sessions | `sessions(subject)` lists families holding a live `session` credential ({§auth-oauth-session}), oldest first (family handle, subject, created timestamp, expiry, client IDs); `client_credentials` and code grants without a browser session are omitted. |

---

## §actor-boundary Sessions and workspace boundaries

```mermaid
flowchart LR
    child["Child session"] -->|"durable activity<br/>environment door"| parent["Direct parent log"]
    actor["Any session"] -->|"mutate workspace:/// commons"| commons["Workspace commons"]
    commons -->|"one body-suppressed broadcast occurrence"| logs["Every existing session log"]
    actor -->|"SEND to named session<br/>voice door"| log["Addressed session log"]
    client["User / client"] -->|"loop.inject<br/>voice door"| log
```

- **Session isolation & attribution**: A packet renders only the assembling session's log alongside shared workspace state ({§packet}, {§membership}). `origin` (`model \| client \| _plurnk`, {§scheme-surface}) records provenance ({§env-delta}) and never filters rows. Client management commands mutate workspace Functionality ({§module-lifecycle}) while client ops journal in `_plurnk` ({§connection-lifecycle}).
- **Two cross-session doors**:
  1. *Environment door*: Direct child durable activity ({§env-delta-child-activity}) enters only the direct parent's log (never republished to grandparents), and successful mutations of `workspace:///` emit one broadcast occurrence to every existing session (unioned with parent lineage so a parent never gets duplicate rows). Intermediate child activity and commons broadcasts never wake; only a child's terminal disposition wakes a parked parent ({§session-loop-lifecycle}, {§env-delta}).
  2. *Voice door*: Directed `loop.inject`, `SEND (session://name)`, or exact-message replies ({§message-reply-delivery}) enter the addressed session's log and wake idle or waiting work.
- **No mutex & self-hosting**: Sessions share workspace state without session locks; stale writes reject at anchor or revision boundaries ({§line-anchors}, {§file-snapshot-revision}, {§file-snapshot-revision}). Work with an operation runs as the unmintable `_plurnk` session (`DispatchAsPlurnk` for reference materialization), while git membership ingestion, disk-divergence `source=file` narration, search derivation, and packet/budget rails stay in the kernel.

### §session-ownership Session ownership and client interaction routing

Every session has one durable workspace-scoped approval owner (`session_owners`), enforced by database invariant. Root sessions take an explicit owner or default to `_plurnk`; `WORK`/`FORK` children inherit their parent's owner; `SEND` and scheduled messages preserve the recipient's owner; explicit client control attachment claims a model session and its model descendants (including pending interaction recipients) without ever claiming `_plurnk`.

- **Owner capabilities & proposals**: An owner declares its implemented client tools and whether it is `interactive` (attended by a person); `_plurnk` implements no tools and is non-interactive. Proposals record their session's owner and disposition (`review`, `accept`, or `reject`); `review` waits only for that owner, and capability policy precedes approval.
- **Client interactions**: Clarifications and questions route to the session's owner only when it is `interactive` and declares the tool; otherwise the request fails immediately with `501` without parking. Only the recorded recipient may resolve the pending interaction.

### §session-initialization-entry Turn-0 orientation and reference materialization

Workspace reference documents and projected instructions are materialized into `workspace:///_plurnk/` through `_plurnk` maintenance turns whose loops are excluded from `work_loops` ({§application-session-observation}, {§application-loop-observation}) and emit no ambient broadcasts.

- **Project instructions**: When `<projectRoot>/AGENTS.md` exists, LoopDocs materializes `workspace:///_plurnk/AGENTS.md` and turn 0 foists a `READ` of it (global XDG `AGENTS.md` stays in the system prompt, {§policy-sections}). When root `<projectRoot>/AGENTS.local.md` exists (regardless of git ignore status, unless excluded), LoopDocs materializes `workspace:///_plurnk/AGENTS.local.md` and turn 0 foists its `READ` immediately after. Absent files produce no entry and no `404`.
- **Catalog preview (`PLURNK_SERVICE_FILES_ITEMS`)**: When non-zero (`-1` for markerless page, positive `N` to cap `*`), turn 0 foists bodyless `FIND` surveys in order: `skill://*/SKILL.md` (`<1,-1>`, {§skills-resources}), `workspace:///_plurnk/plurnk/*.md` (`<1,-1>`), `workspace:///_plurnk/tools/*.md` (`<1,-1>`, {§tools-resource-materialization}), `workspace:///_plurnk/members/*.md` (`<1,-1>`, {§members-projection}), `*` (`project root member files`), `workspace:///*` (`workspace knowledgebase entries`), and `session://<session>/*` (`session knowledgebase entries`). Unregistered schemes and surveys selecting zero items are omitted before recording.
- **Turn-0 execution**: A model session's first loop starts with one packetless `{ producer="_plurnk", kind="initialization" }` turn (`init` rows) submitted through {§turn-record} and {§op-methods-op-dispatch}, framed by opening and closing `<!-- plan -->` `NOTE`s when any survey runs, with no fabricated emission row ({§turn-source-resources}). Initial messages arrive in the first model turn (sequence `2`, {§message-arrival}).

### §machine-processes Session topology, fork, and hiding

```mermaid
flowchart TB
    workspace["Workspace"] --> files["Project files & membership overlay"]
    workspace --> commons["Shared entries (workspace:///...)"]
    workspace --> parent["Session A (log, loops, session://a/...)"]
    parent -->|FORK| child["Session B (copied terminal log & session://b/... snapshot)"]
    files -->|"shared live"| child
    commons -->|"shared live"| child
```

| State | Owner & Fork Behavior |
|---|---|
| Project filesystem, membership overlay, `workspace:///`, `sh://`, `http://` | Workspace-owned and shared live; never copied on fork. Workspaces themselves cannot be forked. |
| Named scratch (`session://<name>/...`) | Workspace-owned under literal namespace `<name>`. When the `sessions` row with `parent_session_id` and `forked_from_turn_id` is inserted, `sessions_fork_copies_history` ({§db-migrations}) snapshots quiescent `session://<parent>/...` entries into `session://<child>/...` without rewriting body text. |
| Log, loops, turns, curation, and accounting | Session-owned. Fork copies the parent's loops, turns, and `log_entries` up to `forked_from_turn_id` as settled terminal history (`100`/`102`/`202` clamped to `200`, open turns to `499`, pending proposals to `cancelled`, stream subscriptions omitted), preserving `weight`, `forget_The_Past`, and observation cursor while copying zero provider cost ({§tokenomics-turn-summary}). |
| Session identity & origin | Each session carries `origin` (`model` or `_plurnk`; `WORK`/`FORK` create `model` sessions regardless of operation producer, {§connection-lifecycle}) and an immutable unique 128-bit hex `provider_identity` (`sessions.provider_identity`, {§provider-cache-identity}). |
| Place hiding (`hidden_at`) | Hiding a workspace marks the workspace alone; hiding a session marks it and its subtree (`hidden_by` naming the root of the hide group; `409 live-work` if any covered session holds a live loop, {§session-loop-lifecycle}, open stream, pending proposal, or pending question). Starting a live loop or selecting a workspace by its default folder name ({§execution-output-identity}) shows it; `listWorkspaces`, `listSessions`, and `overview` ({§methods-workspace-create}) filter by `hidden_at` and emit `workspace/hidden` / `session/hidden`. |

### §session-scheme Session scheme addressing, delegation, and collection

- **Authority & scratch scope**: `session://<name>/<path>` keys workspace entries by literal `authority = <name>` (`workspace:///<path>` has `authority = ""`; `session:///<path>` is refused with `400 named-session-required` pointing to `workspace:///`). Any session in the workspace can `READ`, `FIND`, `EDIT`, `COPY`, `MOVE`, or `KILL` any `session://<name>/<path>` entry without ancestry checks ({§execution-output-identity}, {§scheme-address}), and entries outlive their namesake session. `workspace:///_plurnk/` is ordinary shared workspace scratch reconciled by `_plurnk` ({§tools-resource-materialization}, {§skills-resources}).
- **Minting & control addressing**: Minted session names must match `SESSION_NAME` ({§session-name}, `^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`, case-sensitive; `_plurnk` is unmintable, though readable by `readLog` / {§methods-workspace-create}). Session control addresses (`WORK`, `FORK`, `SEND`, `READ`, `KILL`) must be authority-only `session://<name>` with no userinfo, port, pathname, query, or fragment (`400 control-address-invalid`), `~` is never an alias, and `EDIT (session://<name>)` fails with `400 session-entity-not-editable`.
- **Delegation (`WORK`, `FORK`) and messaging (`SEND`, `KILL`)**:
  - `WORK (session://<name>)` spawns a fresh child if `<name>` is unused ({§connection-lifecycle}), or delivers its non-empty body as a message to the existing session `<name>` (`attrs.delivered = "message"`). Omitting `(session://<name>)` auto-allocates an 8-hex-character name ({§execution-output-identity}). Passing a non-`session://` resource path on `WORK (<path>)` reads that resource whole (`<1,-1>`) as the prompt (composed with any inline body, {§bare-prompt-composition}) and auto-names the child.
  - `FORK (session://<name>)` (or addressless `FORK`) branches the calling session into a fresh name; if `<name>` already exists, `FORK` fails with `409 session-name-conflict` naming `WORK or SEND (session://<name>)`. Inherited loops are terminal so {§loop-completion} sees only the branch's new loop. Both `WORK` and `FORK` enforce `PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE` (`508`) and require a non-empty prompt (`422 spawn-prompt-empty`).
  - `SEND (session://<name>)` delivers a non-empty message or attachment ({§op-methods-op-dispatch}; `422 message-empty` when blank, `404` when absent) to `<name>`, folded into a running loop or queued as a new loop (`202` parked loops re-queue to `100` without firing terminal hooks). `KILL (session://<name>)` cancels the session's active tree (`404` when absent).
- **Collection (`READ (session://<name>)` and `ops://<name>/<L>`)**: Each concluded child loop reaches its direct parent as an `_plurnk` `READ` of `ops://<name>/<L>` ({§message-completion}, {§message-reply-delivery}, {§env-delta-child-termination}), and `READ (session://<name>)` (or `ops://<name>/<L>`) collects that same terminal result on demand without `lineAnchors` ({§session-loop-lifecycle}): `404` if absent, `425 loop-running` (`resource: "ops://<name>/<L>"`) while unresolved, `200` with answer content on completion, or the child's exact failure status and Problem on error.

### §child-orientation Open-work orientation and Session footer

Every model packet includes two orienting blocks in the status clump below `## Log` ({§packet-cache-monotone}), carrying no date, time, or timezone anywhere:

- **`## Session`**: Renders `{"path": "session://<name>", "parent": <"session://..." | null>, "loop": L, "turn": T, "owner": {"address": "<owner>", "interactive": <boolean>}}`, naming the actor, its parent, the `(L, T)` coordinate this packet's response will occupy (`reasoning://<session>/L/T`, `ops://<session>/L/T`, `log:///L/T/*`), and its owner's attendance ({§session-ownership}).
- **`## Open Work`**: Always renders (even when all lists are `[]`, as the deliberate exception to empty-section omission) as `{"sessions": [...], "streams": [...], "messages": [...]}`, listing unconcluded child sessions, active stream subscriptions, and sent messages awaiting completion ({§loop-completion}, {§schedule-delivery}). Each active stream pointer carries `detail: "elapsed <E>s; output unchanged <U>s; <channel> <lines> lines (+<growth> bytes)"` (or `output timing unknown` when `output_changed_at` is null); `opened_at` is fixed at subscription open, while `output_changed_at` resets atomically only when a published channel's content actually changes ({§exec-stream}).

## §membership File membership and project roots

A file is a member of a workspace when Git tracks it or a `members` definition includes it and none excludes it: `(tracked ∪ include ∪ created) − exclude`. Only members can be READ, found by FIND, or changed by EDIT, and every member path resolves under `workspaces.project_root` (null is headless). Internal entries do not participate in the project-file disk loop.

```mermaid
flowchart LR
    git["Git tracked"] --> resolve["Resolve workspace membership"]
    include["include"] --> resolve
    exclude["exclude"] -->|subtract| resolve
    resolve --> materialize["Pre-turn materialize<br/>disk → file snapshot"]
    materialize --> read["READ snapshot"]
    materialize --> edit["EDIT against snapshot"]
    edit --> proposal["Proposal"]
    proposal -->|"client accepts or loop auto"| cas["Validate captured file revision"]
    cas -->|"file snapshot → disk"| project["Project file"]
    project --> materialize
```

| Concern | Rule |
| --- | --- |
| Baseline and exceptions | To a workspace a project file is **invisible**, **added**, or **tracked by git**; ambient admission of untracked files is prohibited ({§fs-write-surface}). Exceptions enter only by exact creation records (`source: "create"`, origin `constraint` from accepted EDIT or COPY/MOVE destinations), standard instruction projection (`AGENTS.md` / `AGENTS.local.md` into `workspace:///_plurnk/…` unless ignored or excluded, {§session-initialization-entry}), or model `members` proposals under `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` ({§members-model-scope}) and `PLURNK_MEMBERS_AUTO_ADD` ({§membership-auto-add}). |
| Native Git and hermetic execution | Core Git reads (`git ls-files`, `git status`, `git check-ignore -v`) execute the installed Git binary with ambient `GIT_*` and global/system config scrubbed, `core.fsmonitor=false`, `core.hooksPath=/dev/null`, and only the daemon user's `core.excludesFile` preserved. Repositories declaring `filter.<name>.clean` or `filter.<name>.process` are skipped with a `git_inspection_refused` notice. `PLURNK_SERVICE_GIT_ALLOWED` gates `PLURNK_SERVICE_GIT_AUTO` ({§operator-config-workspace-settings}). |
| Ignore attribution and edit gate | An ignore refusal or `discover` verdict names its rule (`<file>:<line>`) from `git check-ignore -v`; negated patterns re-include paths. EDIT is bounded by membership: existing non-members refuse 403 before reading or writing bytes; accepted creations recursively create missing parent directories. |
| Web discovery and retrieval | Web search is an ordinary MCP concern ({§mcp-tool-presentation}); executors prefetch discovered pages through the generic `content: null` `entry()` request ({§execution-output-identity}) into `WebFetcher`, which materializes sanitized readable projections under canonical HTTP URLs ({§scheme-address}) and omits failed candidates. |

### §membership-auto-add Overlay, auto-add, and SQL reconciliation

`workspace_constraints` holds projected `members` definitions (`source: "members"` for human definitions, `source: "model"` for model definitions, `source: "create"` for accepted creations) and `!glob` exclusions ({§members-projection}). Only `source: "members"` inclusions override active Git ignore; exclusions mask creation records without deleting their provenance ({§fs-write-surface}).

- **Auto-add (`PLURNK_MEMBERS_AUTO_ADD=1`)**: Model READ and FIND see untracked, non-ignored files under `project_root` minus exclusions. Listing FIND rows mark candidates `untracked` without admitting them; content READ or text-matching FIND proposes a `202` host-effect admission (`{"files": [...]}`) under `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` ({§proposal}, {§proposal}, {§proposal}), emitting one `member_added` notice per admitted path ({§notice-directive}) and re-running the operation. Client operations and `PLURNK_MEMBERS_AUTO_ADD=0` read members only.
- **Set reconciliation and SQL globs**: Membership reconciles in two SQL set statements (`INSERT … SELECT FROM json_each` and `DELETE … WHERE pathname NOT IN (json_each) RETURNING`), recording EMI divergence only when a removed path also left disk truth. `glob_match(pathname, glob)` (`src/core/glob_match.ts`) evaluates {§find} directly in SQLite queries over `workspace_constraints`.

### §derivation-dedup-parallel Materialization, source projection, and search derivation

| Disk source | Durable body and materialization rule |
| --- | --- |
| Text within `PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES` (`1..104857600`) | Verbatim Unicode under the detected textual mimetype; READ and EDIT use the snapshot. |
| Binary with or without readable projection | Bounded by {§mimetype-binary-input}: readable projections store derived `text/markdown` (EDIT returns 415); unprojectable binaries store an empty marker under the binary mimetype (READ uses {§binary-parity}, EDIT returns 415). |
| Oversized or failed acquisition | Remains a member with an empty body channel carrying a durable 413/failure producer result; stat-gated until policy or file metadata changes, while whole-file KILL streams a digest without materializing the body. |

Search maintenance deduplicates by hashing the representation's `content_hash` ({§tokenomics-content-hash-identity}), mimetype, reader identity, and `PLURNK_SERVICE_SEARCH_EXCLUDE` pattern without loading unchanged channel bodies into the process:

- **Bounded parallel derivation**: Distinct pending artifacts sort smallest-first and run under `PLURNK_SERVICE_DERIVE_CONCURRENCY`, writing symbol graphs in `PLURNK_SERVICE_DERIVE_STORE_BATCH` batches and joining all launched siblings before settling. Changed passes emit `preparing`, `indexing` heartbeats (`PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS`), and `complete`/`failed` notices; FTS reads text from `{§content-store}` and retains `{§mimetype-parse-issues}` and `{§mimetype-summary}` metadata.
- **Member-local derivation failures**: Each completed artifact records `indexed`, `excluded`, `unsearchable`, or `failed`. A handler defect on one member (`MimetypeDerivationError` under {§mimetype-derivation-evidence}, or `MimetypeInputError` under {§mimetype-error-policy}) attaches a terminal `failed` disposition for that representation and completes the pass with a `level: warn` `search_progress` notice naming the failed member; contract, persistence, missing-grammar, or abort failures remain fatal to the pass and leave the artifact `building` for retry.

### §file-snapshot-revision Snapshot revisions and serialized file commits

Materialization checks physical identity and raw-byte digest (never timestamps alone), publishing the revision and channels in one database statement and recording observed external changes as `source="file"` `EDIT` rows ({§env-delta-filesystem-narration}). Final validation, atomic temp-file-and-rename publication or deletion, and projection settlement serialize per physical path within the daemon:

| Commit boundary | Filesystem and settlement outcome |
| --- | --- |
| Captured revision matches disk | Publish staged bytes atomically (preserving mode/ownership on replacement) or unlink source (`KILL`/`MOVE`), stamping the new revision from written bytes so native writes are not narrated as external divergence. |
| Unknown baseline or observed drift | Return `409 edit-collision` without mutating disk ({§line-anchors} separately guards anchored neighborhoods before proposal). |
| Partial publication or rollback | If incorporation fails after existing-file replacement, report the partial update; if incorporation fails after new-file creation, unlink only the unchanged creation; if `MOVE` source drifts after destination publication, keep both and report conflict ({§move}). |

## §session-loop-lifecycle Loop scheduling and lifecycle

A session is a log plus a cancellation scope (`AbortController`) advanced by at most one registered per-session drain that claims queued loops (`100 → 102`). A Session is live while any of its loops is unresolved (`100`, `102`, or `202`).

```mermaid
stateDiagram-v2
    [*] --> Queued: runLoop request
    Queued --> Running: queued task claimed by drain
    Running --> Parked: wait with live obligations
    Parked --> Queued: obligation settles or arrival
    Running --> Terminal: conclude or fail
    Parked --> Terminal: cancel
    Queued --> Terminal: cancel
    Terminal --> [*]
```

| Invariant | Contract |
| --- | --- |
| State machine and terminal result | Only `100 → 102`, `102 → 202`, `202 → 100`, and unresolved-to-terminal transitions are admitted; terminal rows are immutable and must carry `loops.terminal_result` (exact status and RFC 9457 Problem Details), while active rows have `terminal_result = NULL`. Completion and cancellation never borrow the last reply's body. |
| Independent collection (`425`) | Reading an unfinished child (`READ (session://<running-child>)`) returns `425 Too Early` without a strike or scheduler side effect; `WAIT` joins live obligations (`{§loop-completion}`). |
| Stream and child wake matrices | Streams are durable session subscriptions (`[0].stream: { state, ... }`, {§subscriptions}). At `WAIT`, open streams or live children park the loop (`202`); closed streams or terminated children with undelivered results continue immediately (`102`) to observe the terminal delta; `[0]` or `[{"lifetime":"turn"}]` streams reap at the next pre-turn boundary. |

### §session-wait-timing Durable waits, wake identity, and execution allowance

When a loop parks on live work, `PLURNK_SERVICE_WAIT_SEC` (or `WAIT [seconds]`, `{§send-wait-scope}`) commits `wait_until` atomically with the wait revision; `WAIT [0]` or an idle `WAIT` continues at `102` without parking.

- **Wake identity and completion revision**: Timers and wakes bind to the exact loop and wait generation. Each loop captures the session's completion revision and acknowledges it before inference only after every addressed reply/child terminal has crossed the observation cursor and every closed stream has published its terminal channels.
- **First-claim latency and execution allowance**: `loops.claimed_at` is stamped once by trigger on first entry to `102`. The first execution snapshots `PLURNK_SERVICE_LOOP_TIMEOUT` ({§operator-config-workspace-settings}) on the loop; active execution segments (inference, retries, turn-lock waits, proposal waits, optimistic holds) consume that allowance via a monotonic clock, while parked/queued/offline intervals do not. Exhaustion aborts execution with `504`.
- **Recipient selection and loop-addressed admission**: Unaddressed session arrivals select the running loop, else the oldest parked loop, else a new queued loop under the session's admission lock. When `runLoop` specifies an explicit `loopId`, admission requires that exact loop to belong to the session and remain unresolved, failing `409 daemon/admission/loop-not-open` rather than falling back to a new loop.

### §session-causal-admission Drains, cancellation, settlement, and restart recovery

`DrainSupervisor` serializes message admission, orphan-message recovery, and recursive subtree cancellation within the workspace, holding at most one active drain per session and re-checking the queue before relinquishing the drain slot.

| Mechanism | Rule |
| --- | --- |
| Recursive cancellation and epoch bound | `lifecycle_cancel_sessions` and the `sessions_cancel_live_loops` trigger atomically record `cancelled_through_sequence` and terminalize unresolved loops (`499`, `terminated_by = 'cancel'`) across the session subtree, while process-local teardown invokes every durable open subscription's live cancellation handle (`PLURNK_SERVICE_EXEC_KILL_GRACE_MS`) and aborts pending proposal waiters (`daemon_stopping`, {§proposal}). Streams bind to the cancellation scope captured at spawn; cancelled work never resurrects its scope. |
| Child wake and optimistic settlement | Every child task completion notifies its direct parent without injecting a prompt. Before model dispatch, `PLURNK_SERVICE_OPTIMISTIC_WAIT_MS` (default 5s; `0` disables) bounds both initiating-turn stream settlement and wake holds that coalesce sibling stream/child arrivals while another obligation remains live. |
| Durable disposition and idle rule | A loop concludes only under {§loop-completion}; a concluded session retains history and starts a new loop on a later addressed arrival. At turn boundaries, a committed `202` park survives a racing daemon-shutdown abort. |
| Daemon lock and restart recovery | Before opening transports, the daemon acquires an exclusive database-adjacent lock (`DaemonLock`), replacing dead-PID claims atomically. Boot recovery commits atomically: `100` loops restore drains; `102` loops, pending provider calls, proposed operations (`owner_vanished`, {§methods}), and open subscriptions settle `500`; pending client interactions are removed ({§proposal-projection}); and `202` loops requeue if obligations settled or restore guarded wait timers. |

### §turn-record Producer-neutral turn record

Every turn (`producer`: `model | client | _plurnk`; `kind`: `inference | initialization | operation | maintenance`) opens at status `102` (`completed_at = NULL`), orders operations by `(turn_id, sequence)`, preserves source-backed programs in `turn_sources` ({§log-history-projection}), and records `packet`/provider evidence only on `model`/`inference` turns.

- **Shared admission and selection snapshot**: Every admitted program parses once and dispatches through the same executor, which captures the session's log high-water mark before statement dispatch so log-targeted `KILL` operations cannot select rows emitted by their own turn (including `{§turn-source-resources}`).
- **Exceptional inference exits**: An exceptional exit completes any still-open turn it acquired without overwriting completed turns or fabricating provider evidence—settling `499` when caused by the owning abort signal, `504` on `LOOP_TIMEOUT_REASON`, and `500` on unrelated or `AggregateError` failures—and rethrows the original cause.

### Engine notifications: one bundle of daemon callbacks

The daemon's observation callbacks (stream, reasoning, outside-text and packet events, session wake, inject and cancel, operation settlement, and notices) are passed to `Engine` as one flat `EngineNotifications` bundle consumed directly by internal collaborators.

### §engine-rails Engine rails, cycle evidence, and provider recovery

After each admitted turn, the engine evaluates one inline rail verdict. Rail state (strike streak and cycle window) belongs to the durable loop across wakes and restarts, closing the cycle window on an actual `202` park or an output-allowance-cut turn ({§output-allowance-notice}).

| Mechanism | Rule |
| --- | --- |
| Strike sources and progress immunity | A turn earns at most one strike from: (1) a hard non-execution operation or parse failure (`status >= 400`, excluding soft `404`, `409`, `416`, `425`, `501` and `{§matcher-refusal}`), (2) an exact operation+result cycle across `MIN_CYCLES × MAX_CYCLE_PERIOD`, or (3) an empty turn ({§outside-text}). A turn where any task-acting operation succeeded (`status < 400`, excluding `NOTE`, `WAIT`, and targetless `SEND`) is immune to hard-result strikes and resets the streak. Crossing `PLURNK_SERVICE_MAX_STRIKES` terminates at `508` (cycle) or `500` (`output_allowance`, `repetition`, `no_operation`, or `operation`, citing `{§outside-text}`). |
| Cycle identity | Hashes ordered executed operations and results (operands, scopes, bodies, metadata, and `NOTE`/response bodies; or raw text for empty turns), ignoring source positions, asides, Problem `instance` URIs, and `NOTE` storage coordinates. |
| Provider recovery | Retryable provider failures ({§provider-retryable-truth}) record a `_plurnk` Problem row, emit `provider_unavailable`, back off (`PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF` up to `PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF_MAX`), and reissue against the frozen messages up to `PLURNK_SERVICE_PROVIDER_RECOVERY` without consuming emission attempts or scoring strikes (applicable to loop inference and `{§op-methods-op-dispatch}`). When recovery is exhausted, interactive sessions park at `202` ({§session-ownership}) while non-interactive sessions terminate with the provider's exact failure. |

## §provider-surface Provider Contract

Core consumes [`@plurnk/plurnk-providers`](../plurnk-providers/SPEC.md) through three entry points and one normalized inference ledger:

| Surface / Guarantee | Contract |
| --- | --- |
| `provider.generate(args)` | Invoked once per logical model call. Emission calls pass packet messages, session/turn coordinates, generation envelope, optional local grammar, attribution tags, and `callKind: "emission"`; `BARE` calls pass one user message plus call identity and `callKind: "bare"` ({§provider-call-kind}). Both wire `signal` to the session `AbortController` and supply `observeRequest({ provider, model })` to record each physical provider I/O before wire dispatch. |
| `provider.assessRequestCapacity` & `countPromptTokens` | Capacity verdicts ({§provider-capacity-admission}) govern context-envelope admission ({§tokenomics-context-envelope-admission}); `countPromptTokens` measures complete requests ({§provider-prompt-measurement}) without replacing the curation ruler. Provider capacity and identity are immutable per instance ({§provider-interface}). |
| Logical inference ledger | Every model call opens a `model_calls` row (`state = "pending"`), specialized by `turn_attempts` (turn-packet emissions) or `bare_inferences` (stateless `BARE` calls). Physical requests settle in `provider_requests`, and core verifies that returned `ProviderRequestAccounting` matches observed requests before accepting a response or classifying a `ProviderError`. |
| Metadata & `assistantRaw` | `generate` may return `meta: Record<string, unknown>` (defaulting to `{}`), persisted on `turns.meta` and forwarded opaque in `loopUsage(loopId).meta`. `assistantRaw` is opaque forensic evidence persisted on the attempt row. |

### §emission-admission Emission Admission, Retry, and Attribution

An emission attempt parses `assistant.content` as the operational turn program and `assistant.reasoning` for explicit `NOTE` blocks ({§reasoning-operations}):

| Outcome | Rule |
| --- | --- |
| Admitted response | Admitted when (a) `assistant.content` contains no fabricated log heading (`### log:///` outside a fenced block) and (b) either `parseStatements(assistant.content)` has no unparsed tail boundary ({§unparsed-tail-boundary}), at least one closed statement precedes the lost boundary, or `finishReason === "length"` ({§outside-text}). Admitted statements execute in source order; bounded parse errors record `400` log rows without resampling. |
| Private retry (`PLURNK_SERVICE_EMISSION_ATTEMPTS`) | When the entire emission is rejected before any statement closes (or fabricates a `### log:///` heading), core records `accepted = 0` on `turn_attempts` and re-invokes `generate` with the exact same `messages` up to `PLURNK_SERVICE_EMISSION_ATTEMPTS` (default `3`), keeping prompt caches warm. |
| Exhaustion & recovery turn | Exhausting private attempts completes the turn at `102` without fabricating an `error` log row, records a durable body-suppressed `_plurnk` `emissionAttempt` row, and scores one contract strike ({§session-loop-lifecycle}). If the strike rail does not terminate the loop, the next turn projects the latest rejected text and parser diagnostic once in `notices`. |
| Attribution & client metadata | Each attempt queries `attributions(context)` across schemes, executors, mimetypes, and the provider ({§extension-attribution}), passing the deduplicated sorted tags on `generate` and persisting them on `turn_attempts`. Workspace `settings.client` (`1..128` printable ASCII chars) is stored on `workspaces.settings` and never sent to providers. |

### §provider-instantiation Provider Instantiation and Operator Grammar

`ProviderInstantiate` resolves model selectors through `@plurnk/plurnk-aliases` ({§alias-env-contract}) and constructs providers via `ProviderRegistry` (`discoverExternal`, `register`, `has`, `list`), caching instances by canonical `(provider, model, baseUrl, alias)` spec. `Mock` from `@plurnk/plurnk-providers` serves deterministic integration suites ({§mock-provider}).

| Mechanism | Rule |
| --- | --- |
| Operator grammar (`PLURNK_PROVIDERS_GBNF[_<alias>]`) | Resolves per alias (empty string disables) as a filesystem path (absolute or relative to daemon `cwd`) read via `readFileSync` on each `generate` call and passed as `grammar`. Unreadable paths fail before inference; `ProviderInstantiate.validateGrammarConfiguration` refuses providers that do not set `constrainsOutput === true`. Turn `meta.railsAttached` records `"client"` or `"withheld"` from `ProviderResponse.grammarEvidence`. |

---

## §scheme Scheme Contract

Core mediates between the model and scheme handlers ([`@plurnk/plurnk-schemes`](../plurnk-schemes/SPEC.md)). Data and streaming schemes store resources in `entries` and `entry_channels`; control schemes (`session`, `plurnk`) act on runtime state without entry rows.

### §scheme-address Scheme Addressing and Entry Matrix

Core decomposes targets via RFC 3986 / WHATWG URL parsing ({§path-grammar}): namespace schemes fold authority into `pathname` (`authority = ""`), network schemes preserve `hostname[:port]` in `authority` and serialize `?query` into `pathname` ({§url-decomposition}), and `#fragment` selects the channel ({§channel-selection}). Client `entry.read` acquires addresses through the same exact-READ pipeline.

| Scheme | Category | Address & Ownership | Mutability & Scope |
| --- | --- | --- | --- |
| `file` | `data` | Project-relative or `../` canonical key (`authority = ""`); workspace-owned | Model/client `EDIT` (with `textEditScopes` & `lineAnchors`), `COPY`, `MOVE`, `KILL` (reviewed via `202` proposals) |
| `workspace` | `data` | `workspace:///<path>`; workspace-owned scratchpad | Model/client `EDIT` (`textEditScopes` & `lineAnchors`), `COPY`, `MOVE`, `KILL` |
| `session` | `data` / `control` | `session://[<handle>]/<path>` (entry) or `session://<handle>` (actor); session-owned | Entry: model/client `EDIT`, `COPY`, `MOVE`, `KILL`; Actor: `SEND`, `WORK`, `FORK`, `KILL` |
| `http`, `https` | `data` | `http(s)://<host>[:<port>]/<path>[?<query>]`; workspace-owned | Acquired on `READ`/exact `FIND`; outbound `SEND` proposes (`202`); `lineAnchors: true` |
| `<runtime>` (`sh`, etc.) | `streaming` | `<runtime>:///<id>`; workspace-owned execution output | Created by runtime invocation; `READ`/`FIND` streams (`lineAnchors: true`), `SEND` stdin, `KILL` process |
| `log` | `data` | `log:///<loop>/<turn>/<seq>/<op>`; session-owned log receipts | `READ`, `FIND`, and context-curation `KILL` |
| `message`, `ops`, `reasoning`, `note` | `data` | `<scheme>://[<session>]/<coordinate>`; session-owned turn sources | Immutable turn-source evidence; `READ` and `FIND` (`lineAnchors: true`) |
| `plurnk` | `control` | `plurnk (<noun>)`; control target | Administers `git`, `members`, `mcp`, or `update` |

### §fs-namespace Filesystem Namespace, Canonical Naming, and Refusals

All `file` operations resolve targets through `Namespace` and `plurnk-uri` before touching SQLite or disk:

| Rule | Contract |
| --- | --- |
| Name resolution & home expansion | Local paths and `file://` URLs (decoded once from percent-encoding; rejecting `%00`, `%2F`, invalid UTF-8, or non-empty hostnames with `400 invalid-file-url`) resolve against `project_root` (or `os.homedir()` for `~` / `~/...`). A literal in-root `~` segment is written `./~`. |
| Canonical key & wire canon | Inside `project_root`, the stored `entries.pathname` and wire address are the normalized relative path (`src/a.ts`); outside `project_root`, the stored key is the relative climb (`../sibling/a.ts`) while model-facing wire/problem rendering spells the absolute path. Model-authored non-canonical spellings (`/abs/in/root` or `~/...`) resolve to the canonical key and emit a `path_normalized` notice. |
| Visibility & directory targets | Only paths granted by `git` or `constraint` (`members` / `create`) exist in `file`. Addressing a directory on `READ` or `KILL` returns `404 path-is-directory` with recovery `FIND (<dir>/)`; on `EDIT` it returns `403 path-is-directory`; on `FIND (<dir>)` (with or without trailing `/` for in-root directories) it surveys member descendants. |
| Read/miss refusals | Inside `project_root`, a missing path returns `404 entry-not-found` naming `FIND`, `EDIT`, and `plurnk (members)`; an on-disk non-member returns `404 entry-not-member` naming either the active exclusion rule, the ignoring Git file and line (`.gitignore`, `.git/info/exclude`, user excludes), or `plurnk (members)`. Outside `project_root`, any miss or non-member returns the identical `404 entry-not-found` naming the absolute address without revealing disk presence. |

### §fs-write-surface Filesystem Write Surface and Creation Incorporation

Existing member writes follow their grantor (in-root members and constraint-granted outside members are read-write; Git-only outside members are read-only). Creating a new file is one producer-neutral transaction across `model`, `client`, and `_plurnk`:

| Stage / Case | Contract |
| --- | --- |
| Creation scope (`PLURNK_SERVICE_FILE_CREATE_SCOPE`) | Effective scope is `min(serviceScope, workspaceSettings.fileCreateScope)` over `none < root < namespace` (default `root`). `none` refuses all new files (`403`); `root` admits absent paths whose lexical and realpath parents stay inside `project_root`; `namespace` also admits absent `../` paths. |
| Exclusions & occupancy | Active member exclusions (`!glob`) always refuse creation (`403`). Git-ignored paths refuse creation (`403`) unless explicitly included by a `members` constraint. An existing non-member file on disk refuses creation with `403 path-occupied-by-nonmember`. |
| Atomic incorporation (`source = "create"`) | On proposal acceptance (re-verifying parent realpath against symlink swaps), core writes the file exclusively (`wx`), materializes the `file` entry, and inserts an exact literal `workspace_constraints` pick (`source = "create"` unless already covered by `members`) without running `git add`. If incorporation fails, disk and DB roll back together (`500 creation-incorporation-failed`). `KILL` or ambient disk deletion removes the `source = "create"` pick while preserving explicit `members` rules. |

### §scheme-manifest Scheme Manifest and Entry CRUD

Every scheme class declares a static `SchemeManifest` (`name`, `channels`, `defaultChannel`, `category`, `writableBy`, `volatile`, `modelVisible`, optional `textEditScopes`, `lineAnchors`, `unmanaged`), validated at registration by `SchemeRegistry`.

| Primitive | Contract |
| --- | --- |
| `EntryCrud` (`entries` & `entry_channels`) | `writeEntry` upserts the `entries` row (stamping `workspace_id` and `session_id` for session-owned schemes) and replaces/upserts `entry_channels` inside one transaction, preserving `deep_hash` when a channel's `(content_hash, mimetype)` is unchanged and clearing `deep_hash` (touching `updated_at`) only when representation changes. `deleteChannel` removes one channel and prunes the `entries` row only when no channels remain. |

### §op-methods-op-dispatch Operation Dispatch, Execution Order, and Bulk Targeting

Core executes admitted statements sequentially in authored order within a turn:

| Mechanism | Contract |
| --- | --- |
| Sequential execution & cancellation | Each statement observes the resource and log state committed by earlier statements in the same turn (except `log` `KILL`, which snapshots pre-program log rows so a turn cannot curate its own in-flight receipts). Runtime `plurnk (mcp)` mutations update parser executor tags for subsequent statements in the same turn. Aborting the loop signal stops dispatch after the current settled effect and marks the turn `499`. |
| `EDIT` batches & anchor continuity | Multiple `EDIT`s to the same resource or a single `EDIT` with multiple regions execute against successive states, carrying forward untouched `@hash` line anchors across numeric splices ({§line-anchors}), tolerating `@hash+N`/`@hash-N` offsets, and merging adjacent rendered prefix echoes when uniquely evidenced. |
| Bulk resource targeting (globs) | A glob target on `READ`, `EDIT`, or `KILL` expands against the full unpaged `FIND` match set in deterministic path order, subject to `maxCommands` (`PLURNK_SERVICE_MAX_COMMANDS`). Empty `EDIT`/`KILL` globs produce one `204` receipt. `COPY` and `MOVE` require each glob operand to match exactly one resource (`400 target-cardinality` otherwise). |
| `BARE` inference & `SEND` attachments | `BARE` resolves its prompt (inline body or single-resource target), selects the loop's child provider policy (`spawn_model_route_id`, `PLURNK_MODEL_CHILD`, or parent route), and runs one toolless, historyless inference call. `SEND` on entry schemes without a `send` handler returns `501`; `SEND` with `[path]` metadata attaches resolved resource snapshots into durable `message_envelopes`. |

### §scheme-surface Universal READ/FIND Composition and Scheme Guards

Core enforces `manifest.writableBy` before invoking mutation handlers (returning `403` on unauthorized producers) and catches unhandled scheme exceptions as `500` Problem rows.

| Composition | Contract |
| --- | --- |
| Universal `READ` | Resolves the target entry and channel (calling optional `prepareRepresentation` first for on-demand schemes like `http`/`https`), slices line/byte ranges or regex/structural matchers against the stored representation, and projects line anchors and sibling channel token weights. `http`/`https` responses honor shared-cache `Cache-Control`, `ETag`/`Last-Modified` `304` revalidation, and `no-store` / mutation-method provenance. |
| Universal `FIND` | Data schemes inherit standard catalog, regex, structural, FTS (`~query`), and symbol-graph (`&query`) `FIND` after optional `prepareFind` / `prepareRepresentation`. Non-data schemes without `find` return `501`. |

---

## §mimetype Mimetype Contract

`Daemon` owns and disposes the `@plurnk/plurnk-mimetypes` instance ([SPEC](../plurnk-mimetypes/SPEC.md)), exposing detection, binary classification, readable projection, and AST/symbol extraction:

| Boundary | Contract |
| --- | --- |
| Write-time detection vs. projection | Scheme writes resolve mimetypes via `PathMimetype` / `mimetypes.detect` and invoke handlers only to derive a sibling `#readable` Markdown channel when eligible ({§channel-selection}) — never invoking structural queries at write time. |
| Binary classification & source projection | `MimetypeBinary` uses `mimetypes.classify` to govern UTF-8 decoding, binary `EDIT` refusals (`415`), raw byte `READ` slicing ({§binary-parity}), and search exclusion. Binary files with a readable handler (e.g., PDF facts) persist derived Unicode and refresh when `projectionIdentity(mimetype)` changes; over-limit or unprojectable binary sources record `sourceProjection.disposition` (`"input-limit"` or `"unavailable"`) and remain byte-readable. |

---

## §persistent-search-index Search indexing

`SearchIndex` maintains workspace-shared, content-addressed derivations (`derivation_artifacts`, `derivation_fts`, `derivation_symbols`, `derivation_references`) keyed by `deep_hash = SHA-256(content_hash, mimetype, binary_classification, projection_identity)`:

| Invariant | Contract |
| --- | --- |
| Exact channel indexing & deduplication | Derivations index the exact stored channel content in its own coordinate space. Identical `deep_hash` inputs across entries or workspaces build once and attach the shared artifact without touching `entries.updated_at`. Concurrent channel mutations reject stale in-flight derivation attachments. |
| Eligibility & size bounds | `_search-exclusion` excludes binary channels (except HTML/readable text), lockfiles, minified/bundled assets, and channels exceeding `PLURNK_SERVICE_SEARCH_MAX_BYTES`, recording `disposition = "unsearchable"` so maintenance stays exhaustive without re-probing excluded content. |
| Exhaustive warming (`warmWorkspaceDerivations`) | Runs at workspace creation and before model turns (joining any in-flight warm before calling the provider), materializing repository members and streaming `search_progress` notices (`preparing` → `indexing` → `complete`, with `loopId: 0` when workspace-scoped). |

---

## §channels Channel Topology

Every entry in `entries` owns one or more named channels in `entry_channels` keyed by `(entry_id, name)`, each with its own `content`, `mimetype`, token `weight`, `content_hash`, `deep_hash`, and `state ∈ {static, active, closed, errored}`:

| Property | Contract |
| --- | --- |
| Per-channel mimetype & state | Mimetype is a `(scheme, channel)` property; cross-mimetype `COPY`/`MOVE` follows {§mimetype-verbatim-transfer}. `state` is lifecycle metadata owned by the scheme (e.g., `exec` transitions `active → closed`/`errored`) and never gates `READ` or `FIND`, which always serve accumulated content. Entries carry no visibility column. |

### §channel-selection Channel Selection and Readable Projections

URL fragments (`#channel`) select channels across `READ`, `FIND`, `EDIT`, `COPY`, `MOVE`, and `KILL`:

| Rule | Contract |
| --- | --- |
| Default vs. named fragment | Fragment-less targets select `manifest.defaultChannel` (`body` for data schemes, `stdout` for `exec`). A `#channel` fragment selects that named channel; `EDIT` with a fragment on a non-existent entry returns `404`, and `KILL (path#channel)` deletes only that channel. Unknown channels return `404 channel-not-found` listing `availableChannels` (and naming the execution stream URI when a `log` execution receipt is addressed with `#stdout`/`#stderr`). |
| `#readable` sibling channel | When an HTML or rich-text source is written or fetched into `body`, core derives its Markdown projection into the sibling `#readable` channel (`text/markdown`), refreshing or removing `#readable` whenever `body` changes. `#readable` is read-only (`400 channel-derived` on `EDIT`, `COPY`/`MOVE` destination, or `MOVE` source; `COPY` from `#readable` is allowed). |
| Decision-time visibility | Catalog `FIND` emits a resource's channel group with the default channel first and non-empty siblings (`#readable`, `#stderr`) beside it; channel-scoped `FIND` matches and ranks in the addressed channel's coordinates (omitting `channel` on match locations only when it is the default channel); and `READ` on a multi-channel entry returns sibling channel token weights in `channels` (e.g., `{"#readable": 420}`). |

---

## Op Surface

Per-op semantics. AST shapes come from `@plurnk/plurnk-contracts`'s `PlurnkStatement`. Engine dispatches by `op`; scheme implements per author contract ({§scheme}).

## §line-anchors Text line anchors

A scheme declaring `lineAnchors: true`, or `textEditScopes: true` with model write authority for the addressed resource, publishes the contracts-owned 5-character base62 anchor token `@xxxxx` on every rendered line (`<line><@xxxxx><content>`) and accepts `<@a>`, `<@a,@b>`, `<@a+N>`, and `<@a-N>` in scope slots ({§language-scopes}). Schemes without write authority render `<line>:<content>` without anchor tokens.

```text
hash_input = canonical_target_NFD + "\0" + prev_trim + "\0" + curr_trim + "\0" + next_trim
token      = base62( sha256(utf8(hash_input))[0..4] )   // 5 base62 chars from first 4 bytes
```

- Boundary lines use `""` for missing neighbors; `\r\n` is normalized to `\n` before splitting and trimming.
- If a token matches one line, it resolves to that 1-indexed line ordinal regardless of vertical shift; if 0 lines match, resolution fails `409` `edit-collision`; if 2+ lines match, resolution fails `409` `anchor-ambiguous` with candidate line numbers unless paired with a unique boundary or narrowed by a prior anchor in a range.
- Anchor offsets (`@a+N`, `@a-N`) resolve line `L ± N` after resolving `@a`; out-of-range offsets fail `416`.

## §edit EDIT

```text
EDIT (<target>) [<scope>] [<pattern>] [<!-- aside -->]
<body>
```

| Form | Behavior |
|---|---|
| Absent resource (no scope or `<0>`/`<1>`/`<-1>`/`<1,-1>`/`<1,M>`/`<1,1,1,1>`) | Creates resource (`201`) with `body`. Scopes beyond line 1 on empty content fail `416`. |
| Existing resource, no scope and no pattern | Refused `400` (`marker-required-on-existing`); full replacement requires `<1,-1>`. |
| `<L>` / `<L,M>` / `<@a>` / `<@a,@b>` | Replaces inclusive line span `L..M` with `body` (`200`, or `304` when unchanged). Empty body removes the selected lines. |
| `<0>` / `<-1>` | Prepends before line 1 (`<0>`) or appends after the last line (`<-1>`). |
| `<L1,C1,L2,C2>` | Splices exact half-open character span `[C1, C2)` across `L1..L2` ({§character-range-splicing}). `<L,1,L,1>` inserts before line `L` using the resource's line separator. |
| Consecutive same-target `EDIT`s in one turn | Validated and applied as one atomic batch against the pre-batch snapshot; overlapping regions fail `409`, and any failure rejects the whole batch. |

### §edit-pattern Pattern EDIT

An `EDIT (<target>) [<scope>] <pattern>` selects matching spans within the canonical source (bounded by `<scope>` when present) and replaces each matched span literally with `body` (no capture-group interpolation):

- **Regex / literal / FTS5 / structural (JSONPath, XPath, `&graph`)**: replaces each matched character region; a glob with metacharacters replaces each matched whole line.
- **Zero matches**: returns `204` with `matched: 0` and leaves the resource unchanged.
- **Unlocated structural match**: fails `422` `pattern-source-unlocated` without partial writes.
- **Binary target**: fails `415` `binary-edit-unsupported`.

## §read READ

```text
READ (<target>) [<scope>] [<pattern>] [<!-- aside -->]
```

| Form | Behavior |
|---|---|
| Exact target, no scope, no pattern | Returns first page (`PLURNK_SERVICE_PREVIEW_LINES` / `PLURNK_SERVICE_PREVIEW_CHARS`, {§context-fit}). |
| Exact target, `<L>` / `<L,M>` / `<1,-1>` / `<L1,C1,L2,C2>` | Returns the requested slice (`200`), clamped to the resource end when `L <= total < M`. Starts past `total` fail `416` (naming the execution stream when reading a bodyless invocation row). Empty resources return `204`. |
| Exact target, `<pattern>` (with optional `<scope>`) | Returns every line touched by a match within `<scope>` at its physical ordinal with line anchors, plus `matched` count and `matches` evidence (`204` when `matched: 0`). |
| Glob / folder target, `<pattern>` (with optional `<scope>`) | Fans out into one exact pattern `READ` receipt per matching resource in `FIND` order (with `attrs.fanout`), or one `204` receipt on the glob when none match. |
| Glob / folder target, no pattern | Fans out into one ordinary preview `READ` receipt per matched resource. |

### §binary-parity Binary parity and byte views

Binary resources participate in `READ`, `FIND`, `COPY`, `MOVE`, and `KILL` without base64 text corruption:

- **Storage & transfer**: DB entries store binary channels as base64 in `content` with their binary `mimetype`; `COPY` and `MOVE` transfer exact bytes (whole, by 1-indexed byte range `<B1,B2>`, by byte- insertion `<B>`, or by regex/glob/FTS byte pattern) across files and entries. Textual anchors (`@xxxxx`) and 4-position character spans on binary targets fail `416`.
- **Byte view (`#bytes` or default binary `READ`)**: projects one lowercase hex octet per line (`1:89\n2:50...`) with `unit: "byte"` while preserving the source `mimetype`.
- **Binary `FIND`**: searches raw decoded bytes for regex/glob byte runs and never indexes or matches base64 text.

## §log-history-projection The Log

The session log (`log:///<L>/<T>/<A>[/<leaf>]`) is an append-only SQLite ledger (`log_entries`) paired 1:1 with mutable active-context state (`log_entry_projection`):

- **Coordinates**: `L` (1-indexed loop sequence), `T` (1-indexed turn sequence within loop), `A` (1-indexed action sequence within turn). The optional `/<leaf>` suffix names the op or kind (`READ`, `EDIT`, `emission`, `reasoning`) and aliases the same row. Foreign session authorities (`log://other/...`) are refused `400`.
- **Immutability & redaction**: Core `log_entries` columns and `log_curation_effects` rows are protected by SQLite triggers and cascade only when containing history is deleted. Before any durable persistence, Packet assembly, fork hydration, or Digest export, URL `username`/`password` and `metadata` slots are replaced with `"__redacted__"` while query strings remain visible.
- **Direct curation**: `KILL (log:///...)` is an active-context meta-operation; a successful `log:///` `KILL` never renders its own receipt in the packet, whereas non-log `KILL` receipts (e.g., workspace/file deletions) render and remain visible.

### §log-kill-scope Scoped curation, distillation & readable projection

- **Row retirement vs. line trimming**: An unscoped `KILL (log:///<target>)` (including globs, folder scopes `log:///1/`, and brace sets `{READ,NOTE}`) retires matched rows (`active = 0`). A scoped `KILL (log:///<L>/<T>/<A>) <range|pattern>` folds the selected 1-indexed body lines into canonical merged intervals in `log_entry_projection.folded`. Scope `<0,-1>` fails `416` with recovery guidance.
- **Distillation**: A `KILL (log:///...)` with a non-whitespace body writes a model `NOTE` row at the next sequence with `attrs.distilled` naming the target as written (even if the `KILL` missed with `404`), retaining the note as a `note://` turn source.
- **Readable projection**: `READ`, `FIND`, `COPY`, and `MOVE` against `log:///` operate on the curated projection in original physical line coordinates—omitting folded lines, pricing only visible lines, invalidating stale search derivations on trim, and decomposing `MOVE` from `log:///` into `COPY` + `KILL`.

### §log-wire-format Wire format, patch, extent & native attachments

- **Packet headings & extents**: Each rendered log row opens with `### log:///<L>/<T>/<A>/<leaf> [(<target>)] · <tokens>`, followed by compact metadata lines (`status`, `range` formatted as `<a,b> of N lines|bytes|resources|match locations`, `trimmed`, `effect`, `change`, `extent`).
- **Mutation patch & rollback**: Every settled text mutation on a workspace file records a unified diff in `log_entries.patch` (readable via `#patch`, `404` on binary/patchless rows, preserved across `FORK`). Rollback reverses patches in reverse sequence order.
- **Native media attachments**: When a `READ` targets a media resource (`image/*`, `audio/*`, `application/pdf`) whose modality the route supports, `NativeContent` snapshots the complete original bytes by SHA-256 and attaches the file part beside the `READ` row on every subsequent turn until that `READ` row is `KILL`ed. Routes without the modality receive the text/hex projection only.

### §turn-source-resources Turn sources, emissions & reasoning

Every turn records immutable source evidence in `turn_sources`, addressable across the workspace by session name:

- `ops://<session>/<L>/<T>`: the turn's admitted operation program (including `_plurnk` initialization surveys). For model turns with admitted content operations, the engine records one born-folded `_plurnk` announcement row (`### log:///<L>/<T>/<A>/emission (ops://<session>/<L>/<T>)`) before the turn's operations; retained content operations replay as `assistant` messages. Rejected emission attempts record an actionless `emissionAttempt` row.
- `reasoning://<session>/<L>/<T>`: the turn's final exposed provider reasoning (`204` when the turn had none, `404` when the turn does not exist). Operations fenced inside reasoning execute once after the stream completes; content operations replay in `assistant` history while reasoning operations leave their receipts in the log. When `PLURNK_SERVICE_REASONING_ROWS=1` and context budget permits after required results, the engine inserts a `_plurnk` `reasoning` preview row (bounded by `PLURNK_SERVICE_REASONING_TRAILING_LINES` or the shared page) immediately before the emission row.
- `note://<session>/<L>/<T>/<A>`: each admitted `NOTE` body, distillation, or interstitial outside-text note. All three schemes (`ops`, `reasoning`, `note`) are read-only (`403` on write/kill), hash-free (`400` on line anchors), indexed for `FIND`, and preserved under local coordinates on `FORK`.

### §edit-result-receipt-projection Mutation receipts & reviewer replacement

Every settled text mutation (`EDIT`, `COPY`, `MOVE`) produces a structured `EditReceipt` showing:

- `effect`: `<requested> -> <landed>` line coordinates (with `last` beside the first on multi-span pattern edits), `change: lines -R +I`, `extent: lines before->after`, and `parseIssues` delta when grammar recovery changes.
- `context`: the landed lines plus bounded surrounding context framed with fresh `<line><@xxxxx>` anchors (or a removal window when lines were deleted).
- **Reviewer replacement**: When a proposal is accepted with a reviewer-modified body that differs from the proposed content, the receipt records `disposition: "superseded"` and projects the reviewer's landed replacement as a single effect.

## §copy COPY (engine-orchestrated)

```text
COPY (<source>) [<source-scope>] [<source-pattern>] (<destination>) [<dest-scope>] [<!-- aside -->]
```

- Reads `source` (sliced by `<source-scope>` and/or filtered by `<source-pattern>`) and writes the selected content or bytes into `destination` at `<dest-scope>` (`201` created, `200` updated, `204` zero pattern matches, `304` no-op, `404` missing source, `403` read-only destination, `409` self-overwrite without scope). Patterns on `destination` fail `400` `pattern-destination-unsupported`.
- **Mimetype & proposal gate**: Cross-scheme and file writes go through the destination scheme's proposal and membership contracts. Copying binary bytes into a known textual destination mimetype fails `415` `mimetype-mismatch`; untyped destinations preserve raw bytes.

## §move MOVE (engine-orchestrated)

```text
MOVE (<source>) [<source-scope>] [<source-pattern>] (<destination>) [<dest-scope>] [<!-- aside -->]
```

- Decomposes into destination write followed by source removal: whole-resource `MOVE` (unscoped or `<1,-1>` onto a new/whole destination) deletes/unlinks the source resource and transfers generated membership picks; scoped or pattern `MOVE` removes only the transferred spans/bytes from `source` (using pre-mutation coordinates when `source` and `destination` are the same channel).
- **Proposal ordering**: When `destination` proposes (e.g., a file write), source deletion is deferred until the destination proposal is accepted; rejecting the destination proposal leaves `source` untouched. When `source` proposes (e.g., moving from a file to `workspace:///`), rejecting the source-delete proposal after destination write returns `409` with `destinationWritten: true`.

## §find FIND

```text
FIND (<target>) [<scope>] [<pattern>] [<!-- aside -->]
```

- **Target scope**: An exact path inspects that single resource; a trailing slash (`folder/`) or single-segment `*` lists immediate children (summarizing subdirectories as `dir/**` with item counts and token weights); `**` traverses recursively. Path globs support `*`, `**`, `?`, `[...]`, `{a,b}`, and extglobs, resolved strictly within workspace membership.
- **Content matchers**: Glob, regex (with `^`/`$` anchoring each line), JSONPath, XPath (over native or universal deep-JSON/deep-XML projections), and `&graph` symbol queries run against channel content, never against the pathname. Catalog rows include a 256-character `aside` summary (or full fenced invocation menu for tool docs).

### §find-result-projection Result projection & full-text search

- **Resource mode vs. match-location mode**: A broad target (glob or folder) pages matched resources (`unit: "resource"`), reporting `matchLocationCount` per resource and promoting `region`/`locator` only when `matchLocationCount === 1`. An exact target with a content matcher pages flat match locations (`unit: "matchLocation"`) with exact `region`, `locator`, and `matched` evidence. Markerless `FIND` returns the first page (`PLURNK_SERVICE_PREVIEW_LINES`); `<1,-1>` returns all; 3- or 4-position scopes fail `416`.
- **Full-text search (`~query`)**: Queries the persistent SQLite FTS5 index ranked by BM25 with deterministic path tie-breaking, isolated by workspace and literal scheme/authority namespace. Words with inner punctuation (e.g., `inherited-members`, `c++`, `a/b`) rewrite as phrase queries while preserving native FTS5 operators (`AND`, `OR`, `NOT`, `NEAR`, `"phrases"`, `prefix*`); malformed FTS5 syntax returns `400` with the parser diagnostic.

## §send Messaging and turn disposition

SEND AST: `{ op: "SEND", target: ParsedPath | null, body: SendBody | null, metadata, lineMarker }`.

- **Message:** SEND delivers to an actor (`session://<name>`), a scheme that implements SEND (`https://` POST), or an exact message address. Targetless SEND selects the oldest published Open Message. A SEND to a non-recipient scheme (e.g., `log://`) is refused `400 send-target-not-a-recipient`; a scheme without SEND returns `501`.
- **Workflow:** WAIT yields. The loop concludes from resolved messages, settled work, and observed results ({§loop-completion}). NOTE retains memory without parking or creating an observation obligation; KILL names something to cancel or curate.

### §message-completion Reply delivery and message completion

| Reply metadata | Delivery | Message obligation |
| --- | --- | --- |
| No completion code | Deliver authored text and attachments | Remains open |
| `[200]` | Deliver final answer | Completed |
| `[499]` | Deliver cancellation explanation | Cancelled (no implicit session/execution cancellation) |

| Aspect | Rule |
| --- | --- |
| Targetless SEND | Selects the oldest published Open Message at dispatch time; progress leaves it open, `[200]`/`[499]` resolves it. With none open, delivers speech to the loop's latest published message without changing outcomes (refused only when the loop has no published message). Never broadcasts or answers unpublished arrivals. |
| Empty & sequential replies | Empty completion replies resolve selected messages without inventing speech or erasing an earlier answer. Replies execute and deliver in authored order; the latest explicit completion reply determines each message's outcome. |
| Receipt & history | A successful reply records `answers` (immutable message addresses answered) and remains recoverable in `message_history`. Actor-addressed SEND, WAIT, NOTE, asides, and ambient observations are not replies. |
| Latest finished reply | The session's newest model-authored delivered SEND (not copied history, {§machine-processes}) recording `completion` `200` or `499`; daemon abandonment `499` replies never count. |
| Loop answer (`ops://<session>/<loop>`) | READ resolves to the latest nonempty reply body to the loop's starting message. A failed terminal takes precedence and retains its exact Problem. Running without a reply returns `425`; concluded without speech returns `200` empty body. |

### §loop-completion Loop completion, obligations, and WAIT disposition

A model loop concludes only when all messages have explicit completion replies, every held child and non-detached stream (`session_obligations` / `loop_obligations`) has settled, and every required result has crossed a packet boundary. Every fired operation except SEND, NOTE, WAIT, and successful KILL requires a subsequent packet before completion. When all messages are resolved but new results require another packet, the engine emits `All Open Messages resolved. Review new results; emit no OPs if finished.` When a loop ends, any message another session sent it without completion is answered `499` by `_plurnk` (`Loop N ended with status S; this message was not answered.`, {§message-reply-delivery}) after re-homing unpublished arrivals ({§message-loop-containment}).

| Condition, in evaluation order | Outcome |
| --- | --- |
| Session/loop already terminal or administrative program | Preserve terminal result, or finish administrative transaction without adjudicating model obligations. |
| New unpublished message | Continue; publish in the next packet. |
| Fresh operation/parser failure or incomplete emission (no WAIT, or after empty WAIT) | Continue before any automatic parking. |
| Authored WAIT and live work | Park the loop; message arrival, child/stream settlement, or wait expiry wakes it ({§session-wait-timing}). |
| Authored WAIT with delivered reply SEND, results observed, no live work | Complete remaining published Open Messages with the turn's latest reply SEND and conclude ({§message-completion}). |
| Any unresolved message, or unobserved results/failures/conclusions | Continue to the next packet (empty turns receive {§outside-text} recovery). |
| All messages resolved and results observed, live work remains | Join live work via the bounded park; replies remain delivered. |
| All messages resolved, results observed, no live work | Conclude with the aggregate message outcome ({§message-completion}). |

External cancellation records `terminated_by = 'cancel'` ({§methods}) and prepends a cancellation marker in COLLECT and termination deltas; engine failure terminals (**500**, **508**, {§engine-rails}) and model terminals keep `terminated_by = NULL`.

### §outside-text Outside text, empty turns, and terminal evidence

| Construct | Rule |
| --- | --- |
| Outside text beside fenced OPs | Each span from {§response-text} becomes one `NOTE` at its position, frozen in the emission ({§turn-source-resources}) and replayed in history ({§emission-history}) with no notice. |
| Outside text with no fenced OP | Stored verbatim as one `outside` turn source ({§turn-source-resources}) and surfaced once via `outside/event` ({§notifications}, {§acp-outside-text}); never enters a packet or delivers a reply. |
| Empty turn (no content or reasoning OP) | When no boundary was lost ({§unparsed-tail-boundary}) and messages remain unresolved or emission is incomplete, counts one progress strike ({§engine-rails}) and records `422 The turn performed no operation.` ({§operation-result-uniform-error-channel}). |
| Terminal evidence (`unconcluded`) | If a failed terminal's last inference turn performed no authored operation and kept text, Problem Details carries `unconcluded: "ops://<session>/<loop>/<turn>"` citing that emission without re-sending or softening the terminal. |
| Ignored scheme metadata | READ, FIND, EDIT, KILL, WORK, or FORK carrying `[metadata]` for a scheme taking none runs without it and emits one `metadata_ignored` warning notice; SEND and executions validate their own metadata ({§op-methods-op-dispatch}). |

## §exec Executions

AST: `{ runtime, target, body: string | null, lineMarker }`. Execution refuses a non-null scope (`400 scope-unsupported`, {§exec-lifetime}).

### §exec-target-routing Target routing, scratch realization, and registry resolution

The engine routes unconditionally to `exec`, resolves `runtime` from the workspace snapshot at dispatch (installed base plus {§module-lifecycle} overlays; unknown tag `400`, unavailable probe `501`, configuration failure `503` {§configuration-repair-path}), validates {§executor-invocation} or {§executor-tool-registry} before effect admission, and prepares metadata under {§executor-metadata} using `project_root` (or daemon cwd when headless) as default `cwd`.

| Target / Condition | Outcome |
| --- | --- |
| `script` target: file / directory + body / directory alone | Runs the file / uses directory as `cwd` for inline body / refused `400 target-not-a-program`. |
| Absent path on `script` target | Refused `400 target-not-found` ({§diagnostic-observation}), naming another executor's tool (`toolRuntimes`), another executor (`` `python3` is its own executor. ``), or requiring an existing program resource. |
| Bare shell command naming another runtime's tool | Exits 127 and records `404 program-is-a-tool` (`exitCode: 127`, `toolRuntimes`, `tool`); unknown programs keep `200` with `exitCode: 127`. |
| `workspace:///_plurnk/*` target | Refused `400 target-is-documentation` before realization. |
| Non-stream path in executor's own scheme (`sh:///daemon-env`) | With body, runs targetless; without body, refuses on source read. Wrong-runtime stream id on KILL/input names actual `<runtime>:///<id>` in recovery. |
| `resource` target realization | Native file from {§scheme-source-bytes} runs in place; any other resource/channel materializes an exclusive `0600` file under `PLURNK_SERVICE_EXEC_SCRATCH` (`0700`, default `$XDG_RUNTIME_DIR/plurnk` or `tmpdir()`; relative value fails boot; uncreatable dir refuses `400 scratch-unavailable`) for the run's lifetime. |

### §exec-lifetime Execution lifetime, effect admission, and concurrency

| Mechanism | Rule |
| --- | --- |
| `lifetime` metadata ({§service-metadata-keys}) | Duration (`30s`, `30m`, `2h`): aborts at deadline (polite signal then SIGKILL after `PLURNK_SERVICE_EXEC_KILL_GRACE_MS`) with `504 execution-timeout`. `loop` (default): reaped on loop terminal except `202` ({§notifications}), or on client operation cancel/shutdown ({§connection-lifecycle}). `turn`: reaped at next pre-turn. `detached`: outlives loop `200`, imposes no obligation, reaped on KILL, session reap, or daemon stop. |
| Effect admission (`EffectPolicy`) | `PLURNK_SERVICE_EFFECT_HOST`, `_READ`, and `_PURE` map each declared effect to `propose` ({§proposal}, {§http-outbound-proposes}) or `auto`; invalid values fail boot. Initiating turns apply {§session-causal-admission} to their started streams. |
| Workspace concurrency | Bounded by `PLURNK_SERVICE_EXEC_CONCURRENCY` (`-1` unbounded; FIFO per workspace). Admitted runs create entry, channels, and subscription immediately, returning `200 { outcome: "started" }` or `202 { outcome: "queued", executionsAhead, concurrency }`. Queue wait excludes timeout; queued KILL cancels via {§stream-control}. |
| Turn-hold (`PLURNK_SERVICE_EXEC_HOLD`) | Holds cycle until stream conclusion up to `PLURNK_SERVICE_EXEC_HOLD_MS` (fail-open) for listed `<runtime>` or `<runtime>:<effect>` selectors. |

### §exec-stream Stream surfacing and page bounds

| State / Aspect | Rule |
| --- | --- |
| `active` stream | No Log row; `## Open Work` reports timing and channel growth ({§child-orientation}). Explicit READs carry `terminal: false`. |
| `terminal` stream | One `origin=_plurnk` markerless READ per non-empty channel (or one bodyless row on the default channel if all channels are empty), carrying `terminal: true`, any `exitCode`, and empty sibling counts (`channels: {"#stderr": 0}`). |
| Page bound & failures | Unrequested delivery is bounded by the first retrieval page ({§body-projection}, {§executor-page-receipt}) with an atomic per-subscription cursor. A failed execution attaches its Problem to the default (or first landed) channel row so Errors gets one pointer ({§operation-results}). Deleted channels owe no observation; KILL on a terminal stream returns `200` with `terminalStatus` ({§stream-control}). |
| Conclusion summary | `stream/concluded` ({§notifications}) formats `<addr> completed (exit N); <ch>=<B> bytes` or the lowercase Problem title for clients. |

### §execution-output-identity Workspace entries, auto-names, and command environment

| Surface | Rule |
| --- | --- |
| Workspace entries & output | Every entry belongs to one workspace `(workspace_id, scheme, authority, pathname)` ({§entry-address-resolution}). Each execution claims an 8-hex path (`sh:///ab3d5678`) in the workspace commons; deleting a producer session keeps its output. Stored output stays readable when an attachment is disabled or removed, while live control/input binds the workspace resource and wakes the initiating session. |
| `entry()` sink ({§executor-entry-sink}) | Publishes textual, binary ({§binary-parity}), or HTTP-materialized ({§web-materialization-contract}, {§html-materialization}, {§http-materializer-extensions}) resources under `<invocation>/resources/` ({§resource-publication-names}) with one runtime `EDIT` row ({§env-delta-entry-materialization}). |
| Session & workspace names | Unnamed sessions allocate 8 random lowercase hex chars (`session://ab3d5678`). Workspace names are unique non-empty strings refusing digit-only (`[0-9]+`), ill-formed Unicode, or `.`/`..` segments (`400 name-invalid`). Default workspace name abbreviates daemon home to `~` (matching `projectLabel` / `project_label`), reusing an existing workspace of that name ({§methods-workspace-create}, {§methods-workspace-create}); headless unnamed workspaces draw 5 alphanumeric chars with at least one letter from {§line-anchors}. |
| Command environment | Layers: filtered ambient host (`PLURNK_SERVICE_EXEC_ENV_INHERIT` / `_EXCLUDE` over HostPaths-projected `HOME`/XDG {§host-path-layout}, {§host-path-layout}, always excluding `PLURNK_*` and provider API key vars) → workspace `env` → session `env` ({§env-functionality}, {§configuration-repair-path}) → invocation `env`. Each spawn records provenance for the digest; MCP launches use {§module-seam-slices} and {§mcp-launch-environment}. |

## §proposal Proposals and client interactions

When a side-effecting op returns `202` (e.g., `host` execution {§exec} or member file EDIT {§membership}), the engine writes `log_entries.state = 'proposed'` (withheld from packets and `log/entry` until resolved), registers a waiter keyed by `logEntryId`, and pauses `dispatch` until resolved ({§methods}, {§acp-proposal-resolve}, {§proposal-disposition}). {§engine-rails} observes the resolved status, never the provisional `202`.

- **Timeout & loop abort:** Empty `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS` waits indefinitely for its reviewer; a positive millisecond value synthesizes `cancel` (`outcome: "timeout"`); any other explicit value fails at the lifecycle owner. Loop abort (timeout, `cancelLoop`, session `KILL`) settles held proposals as `cancel` with the abort reason.
- **Decision evidence:** Each proposal commits at most one immutable decision record (`accept`/`reject`/`cancel`, resolver identity, timestamp, body override, outcome) before application; a second resolution returns `409 proposal-not-pending`. Restart marks interrupted application uncertain without replaying ({§session-causal-admission}).

| Decision | `state` | `status_rx` | Default `outcome` | Effect |
| --- | --- | --- | --- | --- |
| `accept` | `resolved` (or `failed` if apply ≥ 400) | applied status (or `200`) | — (`apply_failed` on unnamed failure) | Runs scheme `applyResolution` (`410 handler-unavailable` if missing). |
| `reject` | `failed` | `400` | `rejected` | None; Problem carries forensic `outcome` and harness settlement recovery when applicable. |
| `cancel` | `cancelled` | `499` | `loop_aborted` | None; loop or deadline abandoned the wait. |

### §proposal-projection Proposal projection and client interactions

| Surface | Contract |
| --- | --- |
| `ProposalProjection` | Derived once from the durable proposed row and loop for both `loop/proposal` and `pendingProposals()` ({§methods}): identity (`id`, `session_id`, `loop_id`, `turn_id`, `op`), `session` ({§session-name}), `coordinate` `L/T/S` ({§methods-invocation}), optional `expiresAt`, `target` (`attrs.proposalTarget` or row target), `body`, `attrs`, `owner` ({§session-ownership}), `disposition`, `selector` ({§capability-policy-matching}), and ACP v2 `subject`. Malformed durable fields terminalize the row `500 policy_failed`. |
| `ClientInteractionRequest` ({§client-interaction-wire}) | Inserts a pending-only `client_interactions` row paired with a live process-local waiter, published via `loop/interaction` and reconnect discovery. Resolution (`accept` with schema-validated `content`, `decline`, or `cancel`) validates against `requestedSchema` (`400 interaction-response-invalid` keeps the request pending) before deleting the row and releasing the waiter once. Owner/execution abort or restart removes unowned rows without replay. |

### §proposal-disposition Proposal disposition, authority, and precedence

| First applicable condition | Disposition |
| --- | --- |
| Runtime bookkeeping (reference publication, audit narration) | `reject`, `runtime_bookkeeping` (never acquires approval authority) |
| Server `PLURNK_SERVICE_PROPOSALS=accept` | `accept` |
| Server `PLURNK_SERVICE_PROPOSALS=reject` | `reject`, `policy_veto` |
| Server `review`, client operation ({§connection-lifecycle}) | `accept`, `client_operation` |
| Server `review`, capability `allow` ({§capability-policy-cascade}) | `accept`, `capability_allow` |
| Server `review`, owner declares `request_approval` | `review` (presented only to matching owner; client YOLO resolves via normal accept) |
| Server `review`, owner has no reviewer | `reject`, `no_review_channel` |

Automatic settlement precedes observational notification; invalid configuration fails at the proposal boundary ({§configuration-repair-path}).

---

## §stream Stream Model

Streams are static content at turn boundaries: chunks accumulate as they arrive into named channels (`content`, `mimetype`, `weight`, `state`, {§channels}) under a **100 MiB char-length cap** (`CHECK (length(content) <= 104857600)` on `contents.content` and `entry_channel_rows.buffer`). The Log records only lifecycle transitions (`102`, `200`, `499`, `5xx`), never per-chunk rows. Channel writes emit `stream/event` notifications ({§notifications}) for client waterfalls.

### §subscriptions Subscriptions and finalization

- **Registration & causal resource:** Streaming `READ` returns `102 Processing` and opens a `StreamSubscription` via `subscriptions.open()`, binding one active subscription per entry in the entry's workspace. SQLite stores durable subscription identity and causal `source`; `LiveSubscriptions` holds the process-local `SubscriptionHandle` for coalesced cancellation, turn-scoped reap, and shutdown. Scoped log curation ({§log-kill-scope}) never cancels a subscription.
- **Finalization:** `close(result, summary?, channelResults?)` atomically closes the subscription row, installs each channel's terminal `producerResult` and derived state, releases the live handle, emits pending stream announcements before `loop/terminated` ({§notifications}), and wakes the session. Concurrent closes coalesce; committed closes are idempotent. Process restart settles orphaned open rows as `500` interruption ({§session-causal-admission}).

### §stream-control Stream control and writes

- **Cancel / Kill:** `KILL (<stream-uri>)` aborts the active subscription or queued execution ({§exec-lifetime}). A stream already terminated returns `200` with `terminalStatus`; an unknown address returns `404` ({§execution-output-identity}). When the holding session itself asks to stop the stream via model `KILL`, the subscription settles `200` (preserving any `exitCode`) rather than `499`, adding nothing to Errors ({§operation-results}). External/peer `KILL`, loop/session teardown, and daemon stop keep `499`; lifetime expiry keeps `504`.
- **Stream writes:** `EDIT` or `SEND` on `wss://` sends a text frame through the active owner; other stream writes (`SEND`, exec stdin) follow the scheme contract ({§op-methods-op-dispatch}).

---

## Storage Model

### §db-durability Connection durability and SqlRite persistence

Every daemon database access goes through package-owned SqlRite statements (`node:sqlite` in WAL mode with `STRICT` tables; direct `node:sqlite` imports are restricted by {§lint-gate} to closed-DB catalog witnesses). `PLURNK_SERVICE_SQLITE_SYNCHRONOUS` (`FULL`, `EXTRA`, `NORMAL`, `OFF`) applies to writer and read pool before migrations or `INIT`; invalid values fail `config check` and database admission. `report:sql <database.db> [specimens.json]` plans `PREP` statements and measures read specimens against a private snapshot ({§share-snapshot}) without migrating or mutating the source DB. SQL owns render queries, path-collision guards, model-call/provider-request lifecycle constraints, 1-based sequence issuance, and entry-vs-log integrity; TypeScript owns status bubbling, tokenization ({§tokenomics}), provider dispatch/accounting, scheme/stream execution, and extension loading ({§extension-discovery}).

### §db-migrations Schema baseline, migrations, and validation topology

| Concern | Rule |
| --- | --- |
| Baseline & migrations | `migrations/001_workspaces`..`008_interactions` form the 4.0.0 baseline. Released migrations are frozen; shape changes add a new versioned file with upgrade coverage from the support floor. Pre-floor or mismatched databases refuse open with remediation guidance. |
| Process triggers (`INIT`) | Row-writing triggers live in `-- INIT: <name>` blocks alongside their statements (`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`), running on the writer after `MIGRATE`. Baseline migrations hold only schema and `RAISE` guard triggers. |
| Validation topology & identity | SQL CHECK constraints and guard triggers enforce storage invariants once, matching JSON Schema gates at `Results` and `Validator`. Every entry has non-null unique identity `(workspace_id, scheme, authority, pathname)` cascading on workspace delete; namespace schemes use `authority = ""`, file members use `scheme = "file"`. |
| Indexes | Every FK column checked by delete/cascade/update is indexed, no `PREP` query scans a growing table unless whole-table by design, and every explicit index has a query-plan, FK, or uniqueness owner. |

### §content-store Content store, retention, and space reclamation

| Mechanism | Rule |
| --- | --- |
| Content interning | `contents` stores each settled body once by SHA-256; `entry_channel_rows` buffers active streams until settlement and exposes channels through the `entry_channels` view and its `INSTEAD OF` triggers. `derivation_fts` indexes `derivation_texts` via `_entry-fts.sql`. |
| Retention policy | `Retention` applies count/age bounds (`PLURNK_SERVICE_RETAIN_PACKET_*`, `_RESPONSE_*`; `-1` disables a bound) to completed turns' `turn_sections` and settled logical calls' response/request payloads while preserving call metadata, accounting, and canonical history. Unreferenced packet items, derivations, text, and native snapshots (held across active operations via {§derivation-in-flight}) are collected per `PLURNK_SERVICE_COLLECT_*`. Invalid policy withholds retention and conversion with a configuration notice ({§configuration-repair-path}). |
| Space reclamation & shutdown | `PLURNK_SERVICE_AUTO_VACUUM` (`incremental` or `none`) converts mismatched files at startup and steps `PRAGMA incremental_vacuum` after retention when free pages reach `PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES`. Shutdown runs retention, WAL truncation, and `PRAGMA optimize` on the writer. |

---

## §core-extension-composition Extension composition

Discovery and pre-import trust follow {§extension-discovery}. Core arbitrates every addressable scheme and runtime name before mutating host registries: reserved core names reject all extension claims, distinct owners reject collisions in either order, rescanning the same kind/package is a no-op, and a module runtime composes its output scheme and optional resource facet under one claim after applying {§executor-policy}.

---

## §bundled-set Bundled Set

`@plurnk/plurnk-service` is the sole manifest owner of the default extension set (`@plurnk/plurnk-schemes-http`, default `@plurnk/plurnk-mimetypes-*` format/image/pdf handlers and non-optional tree-sitter grammars {§mimetype-pdf-facts}, {§mimetype-grammar-packages}, {§mimetype-optional-grammars}, and `@plurnk/plurnk-execs-common` {§executor-default-inventory}, {§executor-policy}), while frameworks remain extension-free and opt-in packages (`@plurnk/plurnk-tavily-plugin`, `tokenizers`) stay outside the default dependency graph. The composed service install owns third-party advisory audits at the moderate floor.

---

## Grammar Dependency

Core consumes the language, schemas, and generated types under {§contract-representations}, admitting provider emissions via {§emission-admission} and executing programs via {§turn-record}.

---

## §operator-config Operator Configuration

### §host-path-layout Host filesystem layout

On XDG-compatible hosts, artifact semantics select the default location. An unset or empty base variable uses the XDG default; a relative value is ignored rather than resolved against the working directory. When the daemon projects an ambient environment for subprocess or module launches ({§execution-output-identity}, {§mcp-launch-environment}), its resolved `HOME` and XDG base directories replace any ambient values they supersede, and an absent `XDG_RUNTIME_DIR` is omitted.

| Class | Base | Plurnk member |
|---|---|---|
| Configuration | `$XDG_CONFIG_HOME` (default `~/.config`) | `plurnk/.env`, `plurnk/AGENTS.md`, `plurnk/mcp.json`, `plurnk/skills/<name>/SKILL.md`, `plurnk/plugins/<plugin>/` |
| Durable user data | `$XDG_DATA_HOME` (default `~/.local/share`) | `plurnk/plurnk.db` and SQLite sidecars; `plurnk/plugins/<plugin>/` (`PLUGIN_DATA`) |
| Persistent operational state | `$XDG_STATE_HOME` (default `~/.local/state`) | On-demand workspace/module directories ({§module-workspace-directory}) |
| Reproducible cache | `$XDG_CACHE_HOME` (default `~/.cache`) | `plurnk/models.json` cached model catalog ({§model-catalog-cache}, {§startup-admission}); created on explicit update |
| Shared global roots | User home | `.agents/skills/<name>/SKILL.md`, `.agents/mcp.json`, `.agents/plugins/<plugin>/` ({§functionality-inspection}) |

`PLURNK_SERVICE_STATE_ROOT` (absolute; `~/` expands; relative fails hard by name) replaces data, state, cache, and runtime homes with `<root>/{data,state,cache,runtime}`, moving the default database with them (`PLURNK_SERVICE_DB_PATH` still overrides explicitly). Newly created config/data directories use `0700` and newly seeded `.env` files use `0600`.

### §operator-config-precedence Environment cascade, defaults floor, and CLI

Higher-priority sources preserve or replace values supplied by lower sources:

| Priority | Source | Ordering |
|---:|---|---|
| 1 | Assembled package `.env.defaults` | Set-if-unset floor; one owner per key (`@plurnk/*`, `package.json#plurnk`, or winning daemon-wide Agent Plugin `ai.plurnk/.env.defaults` under {§extension-trust-boundary}). |
| 2 | `$XDG_CONFIG_HOME/plurnk/.env` | User-level ambient configuration. |
| 3 | `--config=<path>` | Singular service-owned explicit file. |
| 4 | `--env-file*` | Repeatable explicit files; later selected files win; `--env-file-if-exists` skips absent files. |
| 5 | Initial shell environment | Preserved over every file layer. |
| 6 | Derived service CLI flags | Assigned last (`--<kebab-cased-name>` from active `PLURNK_SERVICE_*` and shared keys). |

A working directory's `.env` never configures plurnk (#926). At boot, any `PLURNK_*` key in `$XDG_CONFIG_HOME/plurnk/.env` or `--config` not declared by an assembled panel (or client/bench namespaces) emits one `info` Notice from `engine:configuration` (`configuration_undeclared`) without blocking boot. `scripts/env-surface-policy.mjs` enforces that the cascading environment is the only home for a choice (`undeclared`, `fallback`, `reader-fallback`, `default-constant`, `tunable`, `timer-literal`, `dead-knob`, `duplicate-owner`, `test-floor`), and the flag-parity check binds `PLURNK_SERVICE_*` reads and `.env.defaults` declarations both ways.

`plurnk-service config` inspects the cascade (`config`, `config edit`, `config defaults`, `config check`). Offline `config check` validates core, MCP, schedule, hooks, and discovered module configuration with the same owning readers as runtime, failing nonzero on invalid configuration without creating a database, starting a listener, or contacting endpoints. First-run seeding publishes the private config directory atomically without reseeding existing directories. The package ships example `plurnk.service` and `plurnk.nginx.conf` templates plus generated `dist/man/plurnk-service.1` and `dist/completions/{bash,zsh,fish}`.

Shared keys (`PLURNK_HOST`, `PLURNK_PORT`, `PLURNK_AUTH`, `PLURNK_SECRET`, `PLURNK_PASS`, and optional `PLURNK_ACP_URL`) are owned by `@plurnk/plurnk-contracts`. Shipped `.env.defaults` is tested directly (modelless, no local GBNF, single policy section). `plurnk-core/.env.test` is the committed real-model gate profile (complete catalog orientation, git admitted when allowed, ambient operator notes/skills/plugins/MCP/schedules isolated, server approval set to accept, `PLURNK_SERVICE_POLICY` cleared). Zero-pin (`PLURNK_ZERO_PIN=1`) strips `PLURNK_PROVIDERS_CONTEXT_WINDOW` and alias output/reasoning budgets after env files and before the defaults floor so capacity derives naturally.

### §operator-config-workspace-settings Service ceilings, loop limits, and workspace settings

Each service knob in `plurnk-core/.env.defaults` is enforced at its owning read site:

- **Ceilings** (most-restrictive-wins — operator caps it, no client or call widens it): `PLURNK_SERVICE_GIT_ALLOWED` (`1` admits Git membership/status, else denied), `PLURNK_SERVICE_FILE_CREATE_SCOPE` (`none < root < namespace`), `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` (`none < root < namespace`), `PLURNK_SERVICE_MAX_COMMANDS` (per-emission action ceiling; `-1` uncapped; WAIT is exempt so `0` admits lifecycle-only turns), `PLURNK_SERVICE_MAX_STRIKES`, and `PLURNK_SERVICE_MAX_TURNS` (`-1` uncapped; positive clamps `runLoop({ maxTurns })`).
- **Loop and workspace bounds**: `PLURNK_SERVICE_LOOP_TIMEOUT` (cumulative active execution ms per loop; `504 loop_timeout` on exhaustion), `PLURNK_SERVICE_WORKSPACE_WARM_MS` and `PLURNK_SERVICE_WORKSPACE_WARM_MAX` ({§module-workspace-residency}), `PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES`, `PLURNK_SERVICE_PROVIDER_RECOVERY*`, `PLURNK_SERVICE_EMISSION_ATTEMPTS`, `PLURNK_SERVICE_BUDGET_*`, `PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES`, `PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES`, `PLURNK_SERVICE_MIN_CYCLES`, `PLURNK_SERVICE_MAX_CYCLE_PERIOD`, `PLURNK_SERVICE_FILES_ITEMS`, `PLURNK_SERVICE_EXEC_CONCURRENCY`, `PLURNK_SERVICE_EXEC_SCRATCH`, `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS`.
- **Session-tree turn budget**: owned by the current loop of the topmost non-`_plurnk` ancestor-or-self session; every emission turn and BARE call on the owner's loop and its descendants spends one unit; `LoopDriver` rules `429 max-turns` ({§loop-terminals}) and refuses over-budget BARE calls before any provider request.

`workspace.create({ settings })` validates, normalizes, and persists per-workspace client settings on `workspaces.settings`:

| Field | Admitted value | Composition |
|---|---|---|
| `settings.filesItems` | Integer `>= -1` | Replaces `PLURNK_SERVICE_FILES_ITEMS` (`0` none, `-1` markerless, `N` file-map cap) |
| `settings.maxCommands` | Non-negative integer | `min()`-tightens `PLURNK_SERVICE_MAX_COMMANDS` (bounds actions only; WAIT exempt) |
| `settings.git` | Boolean | `false` denies git for the workspace; never overrides operator lockout |
| `settings.fileCreateScope` | `none \| root \| namespace` | Narrows `PLURNK_SERVICE_FILE_CREATE_SCOPE` in `none < root < namespace` |
| `settings.membersModelScope` | `none \| root \| namespace` | Narrows `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` ({§members-functionality}) |
| `settings.client` | Nonempty string | Stable client self-identification ({§emission-admission}) |
| `settings.capabilities` | `CapabilityPolicy` | Subtractive workspace capability layer ({§capability-admission}) |

---

## §rpc Module seam

Core implements {§application-port} and hosts `@plurnk/plurnk-modules` ({§module-contract}) on its single listener ({§http-host}). Client-interface modules (`plurnk-acp`) own their public wire protocol and event projection.

### §module-lifecycle Module lifecycle, discovery, and setup seam

```mermaid
flowchart LR
    bind["Bind listener unadmitted"] --> register["Register explicit + discovered modules"]
    register --> setup["module.setup(ModuleSetupSeam)"]
    setup --> ready["Process-wide schemes ready"]
    ready --> recovery["Reconcile durable lifecycle"]
    recovery --> start["module.start(ApplicationPort)"]
    start --> admit["Listener admitted"]
```

Every registered module's `setup` runs in registration order before any module's `start` ({§module-phases}). Persisted workspaces with no durable work stay passive until first demand. Modules and `start` return values may implement idempotent `stop()` (reject new ingress, settle producers while keeping observer subscriptions alive) and `close()` (unsubscribe observers and release resources).

Daemon modules are discovered from trusted extension packages (`package.json#plurnk` with `kind: "module"`) and daemon-wide Agent Plugins (`plugin.json#extensions.ai.plurnk` with `kind: "module"`). Standard bundles follow {§functionality-inspection} source order, then package-name order; explicitly registered module owners are not rediscovered; modules declaring HTTP mounts are omitted when no listener is bound ({§module-http-mounts}). Invalid declarations or module config errors are diagnosed under `extensions` or `module:<package>` without breaking healthy siblings.

Core's setup seam also exposes host capabilities for the Functionality coordinator and witnesses: `credentials` ({§credential-authority}), `httpAddress()`, `registerRuntimes(...)`, `registerWorkspaceCapabilityProvider(namespaceOwner, provider)`, `readWorkspaceModuleState(workspaceId, namespaceOwner)` (and `session_module_state`), and atomic `replaceWorkspaceCapabilities({ workspaceId, namespaceOwner, state, runtimes })`. Each {§module-workspace-directory} is lazily allocated with a stable random key in `workspace_module_state` (`0700`) and preserved across cooling and shutdown.

### §module-shutdown-order Module shutdown and deadline

`Daemon.stop()` runs four phases under one shared deadline (`PLURNK_SERVICE_STOP_TIMEOUT_MS`):

1. Reject new capability demand, cancel preparation ({§functionality-preparation-cancellation}), and abort proposals, branches, derivations, and session scopes.
2. Begin module `stop()` calls in reverse registration order concurrently.
3. Settle drains, workspace activation/cooling transitions, capability publications, module producers, streaming producers, derivations, mimetypes, schemes, and session cancellation/wake tasks while observers remain subscribed.
4. Join module `close()` calls in reverse order, then maintain and close the database and listener.

Phase failures join one shutdown aggregate without skipping later phases. Past `PLURNK_SERVICE_STOP_TIMEOUT_MS`, unfinished waits abandon with a named error rather than hanging teardown, and the CLI exits (`0` clean, `1` reported error).

### §module-workspace-residency Workspace sharing, quiescence, and residency

The workspace owns its shared environment (enabled skills, MCP servers, outbound agents, membership definitions, runtime publication, tool outputs, and scratch); sessions own only their logs and session-scoped context. Sessions share workspace Functionality by reference with one effective definition per `(workspace, family, alias)`.

A Functionality snapshot changes only between workspace operations under one exclusive workspace gate:

- Explicit client mutations acquire with `try` (failing `409` while the workspace is held).
- Accepted model operation mutations acquire with `wait` (yielding the turn's shared lease during publication and reacquiring before the next operation).
- Activation and turn-admission refresh run inside their already-held demand boundary.
- Providers reject replacement while active requests, input exchanges, or Tasks depend on the old snapshot.

Model execution, capability-aware operations, residency-requiring module actions, and retained provider work lease workspace Functionality; inspection, listing, attachment, and parked state do not. After the last lease releases, `PLURNK_SERVICE_WORKSPACE_WARM_MS` and `PLURNK_SERVICE_WORKSPACE_WARM_MAX` bound idle residency (`0` immediate cooling, `-1` unbounded). Cooling withdraws live capabilities and process runtimes (MCP servers) at the workspace boundary while preserving durable state in `workspace_module_state`.

## §functionality-coordinator Workspace Functionality

One coordinator owns the common lifecycle across all Functionality families (`list | discover | add | replace | enable | disable | remove`), serialized per scope and family for both client actions (`<scope>.<family>.<verb>`) and the workspace `plurnk` tool.

| Verb | Contract |
|---|---|
| `list` | Project definitions, `origin`, winning `provenance` (`{ kind, source, reference? }`), `enabled`, and published outcome (`disabled`, `dormant`, `active`, `unavailable` with Problem, or `authorization-required`). Never expose secret values. |
| `discover` | Return inert candidates for the family's declared discovery inputs; never install, persist, or execute. |
| `add` | Admit, persist, prepare, and enable a local definition atomically (`201` created/override, `200` identical reapply, `409 alias-exists` on conflicting local definition). |
| `replace` | Whole-definition assignment to an explicit alias (`201` created/override, `200` existing local update; preserves existing enabledness; absent on content-addressed families). |
| `enable` / `disable` | Publish an available definition (retrying preparation if unavailable) or withdraw live capability while retaining the definition (`200`). |
| `remove` | Forget the local definition and enabledness override, restoring any inherited definition and its inherited enabledness (`200`). |

An adapter declares `scopes` (default `["workspace"]`, e.g. Skills, MCP, members; or `["session", "workspace"]` for Environment). Durable state `{ version: 1, definitions: { [alias]: { origin, enabled, definition? } } }` lives in `workspace_module_state` or `session_module_state`. Session-scoped state is copied on WORK/FORK with `inherited` provenance and serializes on the session lane without workspace exclusivity. Publication atomically replaces state and runtimes via {§module-lifecycle}, running the coordinator's and adapter's synchronous `publish` callbacks (with composable undo on rollback) followed by `commit`.

### §functionality-replacement Mutation verbs, addressing, and replacement

- **Replacement**: validates the complete definition without merging omitted fields; disabled candidates persist without preparation; failed admission, preparation, or publication keeps the prior publication and returns the exact Problem; `authorization-required` publishes its handoff (`202`).
- **Content-addressed families (`addressing`)**: `add` admits all definitions in the body or none, returning `definitions` in body order; `replace` is not served; `enable`, `disable`, and `remove` take the family's select input and report the resolved `alias`.
- **Discovery advertisement**: the coordinator builds `discover` schemas strictly from the adapter's declared `FunctionalityDiscoverQuery` inputs (`source` for `skills`/`schedule`, `query` for `mcp`/`members`, `query`+`source` for `env` where empty lists the whole catalog). Unserved or empty inputs fail `400 arguments-invalid`.

### §configuration-repair-path Definition resolution, provenance, and repair path

Named definitions replace whole from the highest-precedence source or scope without field-level inheritance; `ENABLED` controls resolve independently ({§resource-environment}). Provenance reports only the winning definition's source (`environment` key, `SKILL.md` path, or `mcp.json` path + JSON Pointer) and is derived on inspection.

Invalid optional configuration never removes the agent's repair environment:

- Optional startup integrations (hooks, observability), invalid model/child selectors, invalid effect/file-creation/approval policies, invalid retention settings, invalid executor probes, and unresolved family configurations record `engine:configuration` Notices (`configuration_unavailable` naming `key` and `owner`) while keeping the client interface, unaffected families, and repair tools operational.
- Affected operations return `503 daemon:configuration/configuration-invalid` (or the family's exact configuration Problem) without guessing fallbacks.
- Corrected sources resolve immediately on inspection and restore capabilities on the next publication.

### §functionality-inspection Inspection, preparation visibility, and hot-load

- **Inspection is not demand**: `list` and `discover` never acquire residency, join preparation, reconcile docs, or extend warm timers; enabled definitions not yet prepared by a resident publication report `dormant`.
- **Preparation visibility**: `workspacePreparationStatus(workspaceId)` and `workspace/preparation` broadcast `{ workspaceId, preparation: [{ family, phase: "preparing" | "publishing", alias, since }] }` until settlement.
- **Hot-load (`refreshIfChanged`)**: turn admission checks out-of-band sources under the workspace gate before packet assembly and republishes only when enabled definitions or tracked content changed.
- **Agent Plugins and discovery roots**: `PLURNK_SERVICE_ROOTS` (comma list of `project`, `plurnk`, `global`; default all three) selects which `.agents` and `$XDG_CONFIG_HOME/plurnk` roots are read. Plugins resolve in order: `<project>/.agents/plugins/*`, `$XDG_CONFIG_HOME/plurnk/plugins/*`, `~/.agents/plugins/*`, then installed npm plugin bundles (with `PLUGIN_DATA` under `$XDG_DATA_HOME/plurnk/plugins/<name>/<sha256(canonical-root)>`). Adapters may also expose a `scheme` facet (`env://`, `schedule://`) claiming a path subtree.

### §env-functionality Environment family and env scheme

Environment is a session- and workspace-scoped family (`env`). Ambient names admitted by the operator ceiling precede workspace defaults and session overrides. `add` and `replace` bind `{ "value": "…" }` verbatim; `PLURNK_*` and provider credential names are refused at admission. `list` shows effective values and origins. `discover` exposes settable declarations from installed `.env.defaults` panels (`query` matches name/comment; `source` filters by package or fails `400 source-unknown`).

The `env` scheme projects every effective name for the dispatching Session at `env:///NAME`:

- `READ` returns the verbatim value (`404 entry-not-found` if unset/masked); `FIND` lists effective names and matches values; `COPY` copies values out.
- `EDIT` sets the whole value in the Session's layer (or workspace layer for `_plurnk`); `KILL` removes a session-owned entry or disables an inherited one (`400 value-whole` on line scopes; `400 name-invalid` / `target-required` on invalid coordinates).

### §functionality-model-projection Model projection, documents, and mutation settlement

Core registers the in-process `plurnk` runtime at boot (`resourcesPath: "/tools"`, `expandTools: true`), publishing `plurnk (<family>)` tools alongside `plurnk (question)` ({§question-tool}), backed by generated docs at `workspace:///_plurnk/tools/plurnk.md` and `workspace:///_plurnk/tools/plurnk/<family>.json` (incorporating `docs/<family>.md` description body and boot-validated `add` examples). Enabled, active definitions project generated session documents ({§session-scheme}); disabled, unavailable, or capability-denied families project none.

Model invocations of `plurnk (<family>)` settle in authored order before dispatch proceeds (`list`/`discover` are read effects; mutations are host effects using normal proposals and the lease handoff in {§module-workspace-residency}). When a model mutation publishes `authorization-required`, it holds at the workspace boundary until sign-in resolves the alias, then streams the settled outcome.

## §methods Application interface

`ApplicationPort` ({§application-port}) is the in-process interface implemented by `Daemon` and consumed by exterior adapters:

| Area | Methods | Contract |
|---|---|---|
| Events & credentials | `subscribeToEvents(handler) -> unsubscribe`, `credentials` | Subscribe to {§notifications} (subscriber failures are logged and isolated); `credentials` exposes the daemon's {§credential-authority} (`issue`, `verify`, `consume`, `revokeFamily`, `onRevoked`, `sessions`, `registerClient`, `client`, `authenticateClient`). |
| Proposals & interactions | `pendingProposals(workspaceId)`, `resolveProposal(logEntryId, resolution, owner)`, `pendingClientInteractions(workspaceId)`, `resolveClientInteraction(interactionId, resolution, respondent, message?)` | Intersect durable pending rows with live waiters and return validated {§proposal-projection} / `ClientInteractionProjection`; validate workspace-scoped `owner` / `respondent` before delivering one `accept`, `reject`, `cancel`, or interaction payload. |
| Loop admission & cancellation | `runLoop({ workspaceId, sessionId, loopId?, prompt, source?, maxTurns?, openPaths?, selector?, childSelector? })`, `messageAdmission({ workspaceId, address, body })`, `cancelDrain(sessionId, reason?)`, `cancelSession({ workspaceId, sessionId, reason? })`, `cancelLoop({ workspaceId, loopId, reason? })` | `runLoop` validates a model session (`origin="model"`), persists the prompt with the effective turn ceiling, and returns status `100` (`{ loopId, action }`; terminal result arrives via `loop/terminated`). `messageAdmission` checks the message address idempotency key ({§message-source-scheme}: `new`, `accepted` on identical body, or `422 message-address-reused` on different body; `runLoop` refuses repeats with `409 message-already-accepted` or `422`). `cancelDrain` begins durable structured cancellation; `cancelSession` awaits tree cancellation and stream reap ({§cancellation}); `cancelLoop` cancels one client operation loop and its attached executions ({§connection-lifecycle}). |
| Reads, client actions & extension actions | `readInbox`, `readStreams`, `dispatchClientAction`, `readLog`, `readEntry`, `readEntryChannel`, `listProviders`, `listModels`, `listClientDisplayCapabilities`, `listModuleActions`, `invokeModuleAction` | `readInbox` returns unconsumed accepted messages ({§message-arrival}, {§loop-lifecycle-vocabulary}, {§message-loop-containment}). `readStreams` returns open subscriptions (`entryId`, `sessionId`, `target`, `lifetime`, causal coordinates, and channels `{ channel, state, mimetype }`; {§subscriptions}, {§exec-lifetime}, {§channels}). `dispatchClientAction` runs parsed client statements as one client operation of `actor` ({§connection-lifecycle}). `readLog` reads newest-first by ids, recency (`sinceId`/`beforeId`, `PLURNK_SERVICE_LOG_READ_PAGE`/`MAX`), or exact `loopSeq`/`turnSeq`/`sequence`. `readEntry` and `readEntryChannel` return {§entry-read-result} ({§scheme-address}). `listClientDisplayCapabilities` composes sorted scheme ({§manifest-client-display}) and MIME ({§mimetype-client-display}) declarations ({§client-display-capabilities}). `listModuleActions` and `invokeModuleAction` expose setup-registered module actions checked against their registered scope. |

### §methods-workspace-create Workspace and session lifecycle

| Method | Contract |
|---|---|
| `createWorkspace({ name?, projectRoot?, settings? })` | Validate `settings` ({§operator-config-workspace-settings}), create or unhide (`projectRoot` with no `name` under {§execution-output-identity}, {§machine-processes}) the workspace without minting a session or activating Functionality, and emit `workspace/created` when newly created. |
| `attachWorkspace({ workspaceId } \| { name } \| { projectRoot })` | Resolve an existing workspace by exactly one selector (`404 workspace-not-found`, `400 identity-invalid`), minting, activating, and retaining no transport binding state. |
| `activateWorkspace({ workspaceId })` | Ensure a cold workspace activates and publishes its complete capabilities once across concurrent demands ({§acp-owner-activation}), leaving it warm under `PLURNK_SERVICE_WORKSPACE_WARM_MS`. |
| `createSession`, `forkSession`, `registerSessionOwner`, `claimSessionOwner`, `ensureRuntimeSession` | `createSession` creates a model session (`parentSessionId` or `owner`, never both; {§session-ownership}, {§session-scheme}). `forkSession` branches a model session (`409 model-session-required`; {§machine-processes}). `registerSessionOwner` declares an owner's `tools` and `interactive` flag (`_plurnk` reserved); `claimSessionOwner` claims a model session tree; `ensureRuntimeSession` returns `_plurnk`. |
| `renameWorkspace`, `setWorkspaceHidden`, `setSessionHidden`, `rollback`, `listPrompts`, `listWorkspaces`, `workspaceDerivationStatus` | `renameWorkspace` updates the workspace name ({§execution-output-identity}). `setWorkspaceHidden` / `setSessionHidden` hide or show (`409 live-work` over active work, `400 flag-invalid`; {§machine-processes}). `rollback` reverses a session's file mutations after `to` as a client operation ({§log-wire-format}). `listPrompts` returns client loop-seed prompts (`PLURNK_SERVICE_PROMPTS_PAGE`; {§message-arrival}). `listWorkspaces` and `workspaceDerivationStatus` inspect workspace metadata and derivation progress. |
| `readSession`, `listSessions`, `readSessionOverview`, `listSessionLoops`, `sessionAccounting`, `sessionGauge` | Inspect Session projections ({§application-session-observation} with `kind: "root" \| "fork" \| "work"` and `lifecycle`), workspace/daemon overview (`readSessionOverview` with `sessions`, `workspaces`, `omitted` under {§application-session-overview}, {§message-completion}, {§list-excerpt}), loop history (`listSessionLoops` under {§application-loop-observation} with `invocation` under {§methods-invocation} and {§loop-completion}), tree request spend (`sessionAccounting` under {§provider-accounting}, {§tokenomics-provider-usage}), and latest packet gauge (`sessionGauge` under {§tokenomics-client-gauge}). |

- **Fold consistency**: when `runLoop` folds a prompt into an active or `202`-parked loop (`action: "injected_next_turn"`), existing durable provider/model and `maxTurns` remain authoritative; a differing explicit selection fails `409`.
- **Open paths (`openPaths`)**: local paths or scheme URIs ({§path-syntax}) submitted with `runLoop` are persisted with the message (and travel with it on promotion under {§message-loop-containment}) and dispatched as `plurnk`-origin `READ`s on the turn that publishes the message (malformed URIs fail before admission).
- **Stateless binding & session-name admission**: workspace calls return only workspace identity (`workspaceId`, `workspaceName`, `projectRoot`, `projectLabel`); client modules own their own transport binding. Session creation and fork enforce {§session-scheme} so `_plurnk` cannot be forged or resumed as a model session.

### §capability-admission Capability admission and workspace policy

Core derives `CapabilityDescriptor` demands from each statement and evaluates service and workspace policy (`workspaces.settings.capabilities`) before execution or proposal creation:

- **Demands**: `COPY` demands source observation + destination mutation; `MOVE` adds source mutation; resource-backed executions demand runtime + source observation; unknown schemes/runtimes/tools continue to their ordinary resolver; `NOTE`, lifecycle declarations, log `KILL`, targetless/label `SEND`, and runtime mutations of generated entries ({§session-scheme}) are outside external capability selectors. Denials return `403` naming the denied descriptor and policy scope.
- **Live workspace boundary**: every actor (including existing children) evaluates current `workspaces.settings.capabilities` under the service ceiling without snapshotting authority at creation/delegation. Inspection actions return `CapabilityProjection` ({§capability-policy-projection}: service, workspace, and effective intersection), and sessions reconcile generated references against policy changes before their next operation or observation.

### §question-tool Structured owner questions and interaction ring

Core publishes `plurnk (question)` (`workspace:///_plurnk/tools/plurnk/question.json`, `read` effect, `interaction` trait -> access class `interact`, governed by `PLURNK_EXECS_PLURNK` under {§executor-policy}):

- **Form elicitation & lifecycle**: takes MCP2 `2026-07-28` `{ message, requestedSchema }`, submits `ClientInteractionRequest` (`{ toolName: "question", mode: "form", message, requestedSchema }`), pauses on {§proposal-projection}, and writes the settled `ElicitResult` (`{ action: "accept", content? }`, `{ action: "decline" }`, or `{ action: "cancel" }`) verbatim to `results`.
- **Shared tool admission & owner interaction ring**: `FIND`/`READ` of the reserved tool tree, Turn 0 surveys, and operation dispatch share the capability resolver. An asking session adds a live owner ring ({§session-ownership}) that withholds from Turn 0/directory `FIND` and denies at dispatch (`403 capability-denied` with scope `owner`, {§pinned-wording-core}) any interaction tool whose owner does not support it (exact-path `FIND`/`READ` and sessionless workspace projections are unaffected).

### §session-model-selection Model catalog, session model selection, and effort

- **Model catalog (`listModels`)**: bounded local projection of the release-pinned Models.dev snapshot with {§model-catalog-readiness} and {§provider-effort} (`efforts` per route; default configured-only, `availability: "all"` includes unconfigured causes; default page `50`, max `100`; zero provider activity).
- **Session model (`sessions.model_route_id`)**: seeded once for root model sessions from explicit selection or daemon default (modelless daemons stay unset); snapshotted onto each loop at start (immutable across inject, park, wake, retry, reconnect, restart); copied by value on `WORK`/`FORK` and `forkSession`. Bookkeeping sessions (`_plurnk`) have no model and fail `409 model-session-required`. Changing model, spawn override, or effort while a session has any queued, running, or parked loop fails `409 session-loop-active` ({§session-loop-lifecycle}); changing to a model whose calibrated curation budget ({§tokenomics-calibrated-readout}) cannot fit current context fails `413 context-exceeds-model-budget`.
- **Reasoning effort & effort source**: durable `{§effort-wire}` member persisted atomically with model identity (`effort_source: "default"` when seeded from alias/provider config or inherited by a spawned child, `"explicit"` after `setSessionEffort`; projected as `effort` and `effortSource` on `ModelRoute`). Switching models keeps `"explicit"` effort (validated against both session and spawn models) and re-derives `"default"` effort from the new alias.
- **Per-loop `selector` and `childSelector`**: `runLoop({ selector, childSelector })` accepts a declared alias or exact `<provider>/<model>` route (`childSelector: null` means inherit; omitted defaults to `PLURNK_MODEL_CHILD`), persisting explicit selections onto the session before snapshotting onto the loop (`WORK`/`FORK`/`BARE` consume the spawning loop's effective spawn model).

### §methods-invocation Log entry wire, reasoning evidence, and invocation attribution

`readLog` and `log/entry` deliver `LogEntry` rows carrying `loop_seq`, `turn_seq`, `session_id`, `session_name` ({§machine-processes}), causal `source`, lifecycle `state` (`proposed | resolved | failed | cancelled`), and parsed JSON `attrs`:

- **Readable reasoning**: on a turn's first model operation row, nonempty admitted `packet.assistant.reasoning` projects as `reasoning` alongside `reasoning_model_call_id` and `reasoning_request_sequence` (omitted on forked history or turns without readable reasoning).
- **`invocation` and `answering`**: every row that discharges an obligation projects `invocation` (the opener's log address: the execution for a stream observation under {§exec-stream}/{§subscriptions}, the first-message sender for a child conclusion under {§env-delta-child-termination}, or the message-sending operation for a completion reply under {§message-reply-delivery}/{§loop-completion}; {§env-delta-attribution}). Every reply delivered to the session whose operation sent the message projects `answering` naming that operation's log address.

### §notifications Notifications: core events

`subscribeToEvents` delivers `(workspaceId, event, payload)` (`workspaceId` is `null` only for global `workspace/created`):

| Event | Payload & trigger |
|---|---|
| `operation/event` | `ApplicationOperationEvent` (`{ sessionId, loopId, turnId, sequence, origin, projectRoot, statement, phase, result? }`) bracketing each admitted dispatch (`started` before capability/proposal admission, `settled` with `result` after durable receipts; {§op-methods-op-dispatch}). |
| `log/entry` | `{ entry: LogEntry }` when a non-proposed row commits or a proposed row reaches terminal settlement ({§proposal}), before `loop/terminated`. |
| `loop/terminated` | `{ sessionId, loopId, loopSeq, result, hitMaxTurns, turnIds, usage: { accounting, curationWeight, curationBudget, contextTokens, contextCapacity, meta }, attributions, terminatedAt }` once all turn gates and reaped streams ({§exec-lifetime}) have settled ({§application-loop-observation}, {§provider-accounting}, {§tokenomics-client-gauge}, {§emission-admission}). |
| `loop/packet` | `{ sessionId, loopId, loopSeq, packetCount, gauge }` when a provider packet becomes durable with its turn's inference. |
| `loop/proposal`, `loop/interaction` | `ProposalProjection` / `ClientInteractionProjection` when dispatch pauses on a durable `202` proposal or client interaction ({§proposal-projection}). |
| `workspace/created`, `workspace/renamed`, `workspace/hidden`, `session/hidden`, `workspace/preparation`, `session/policy` | Workspace/session lifecycle, `{ workspaceId, preparation }` ({§functionality-inspection}), and `{ sessionId, model, spawnModel }` generation policy changes. |
| `stream/event`, `stream/concluded` | Channel write/state change (`{ entryId, sessionId, target, channel, state, contentLength, mimetype?, loop_seq?, turn_seq?, sequence? }`; {§channels}, {§entry-read-result}; `NotifyCaps.streamEvent()` isolates missing entries and listener errors) and subscription close (`{ entryId, sessionId, target, subscriptionId, scheme, result, summary, wakeAction, ... }`; {§exec-stream}). |
| `notice/event`, `outside/event`, `reasoning/event` | Transient `Notice` (`{ sessionId, loopId, notice }`), outside text (`{ sessionId, loopId, turnId, coordinate, text, tokens }`; {§outside-text}), and balanced `start/content/end` reasoning deltas (`{ sessionId, loopId, turnId, loopSeq, turnSeq, modelCallId, requestSequence, phase, delta? }`; {§turn-source-resources}). |

### §session-external-reference External session references

An adapter's `(namespace, reference)` identifies one durable model session (`readSessionReference` inspects without creating; `ensureSessionReference` atomically allocates a folderless workspace and root model session under {§execution-output-identity} if absent; `listSessionReferences` lists references in a workspace). The association is immutable while the session exists and removed on session deletion.

### §connection-lifecycle Client operations and their connection lifetime

Client operations (`dispatchClientAction`, executions, typed statements, `rollback`) journal in the workspace's `_plurnk` session (`origin: "client"`, `source: null`) in the workspace's Functionality ({§actor-boundary}), each in its own administrative loop (`promptSource` set to the acting person's canonical address under {§message-causal-source}) and isolated cancellation scope (`cancelLoop` cancels only that operation and its attached executions; {§session-causal-admission}):

| Frame | Model session | Client operation in `_plurnk` |
|---|---|---|
| Proposals & clarifications | Reviewed/answered by the session's owner ({§session-ownership}) | Proposals need no self-review ({§proposal-disposition}); client interactions fail at once as unsupported |
| Workspace resources & `env:///` | Session's `env:///` layer above workspace | Workspace's `env:///` layer directly (`_plurnk` keeps none; {§env-functionality}) |
| Voice (`SEND`, `WORK`) | Session's own voice; `WORK` spawns a child session | Acting person's voice; `WORK` to a new session starts a root model session owned by that person |
| Context session (`log:///`, `FORK`) | Session's own log | Reads (`READ`/`FIND`) and branches (`FORK`) `contextSessionId`'s log; client writes (`KILL`/`MOVE`) fail `403` ({§scheme-surface}); without `contextSessionId`, `log:///` is `404 log-unaddressed` and `FORK` is `404 fork-unaddressed` |

---

## §packet-assembly Packet assembly

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§packet-wire-envelope} | The wire envelope |
| {§emission-history} | Emission history: a turn's operations, then its results |
| {§paired-receipt} | A paired receipt names its operand and reports execution information, not a second copy of its request. |
| {§packet-cache-monotone} | Default order and cache locality |
| {§packet-extension-transform} | Trusted whole-list extension seam |
| {§tokenomics} | Tokenomics: one room, one gauge, one rule |
| {§tokenomics-context-envelope-admission} | Context envelope admission: provider input capacity — Provider model limits, the configured output… |
| {§context-admission} | Context admission fits one request through the room: estimated, then measured. |
| {§context-budget} | The context budget is one room for the whole packet. |
| {§context-gauge} | One gauge. |
| {§context-fit} | One rule: whole if it fits, otherwise as much as fits, then its size and address. |
| {§context-verbs} | The verbs are the curation. |
| {§context-over-budget-row} | Over budget is a row and a request, not an ending. |
| {§context-wall} | The context wall is the provider's window, and only it ends a loop. |
| {§context-wall-measure} | The wall measures the request that will be sent. |
| {§tokenomics-weight-stored-at-write} | Curation weight, stored at write. |
| {§tokenomics-render-weight-budget} | Packet curation budget. |
| {§tokenomics-calibrated-readout} | The calibrated readout translates capacity by measured evidence, never extrapolating unmeasured content. |
| {§tokenomics-window-partition} | The window partition: one capacity derivation, no service-side token budget. |
| {§tokenomics-window-unpollable-deliberate} | An unpollable window is deliberate: unknown provider capacity stays unknown. |
| {§tokenomics-client-gauge} | Clients receive curation and physical occupancy as separate pairs. |
| {§membership-binary-sniff} | Binary truth beats a text label. |
| {§tokenomics-agnostic-ruler} | One model-agnostic curation ruler. |
| {§tokenomics-content-hash-identity} | Content identity, not per-tokenizer counts. |
| {§tokenomics-provider-usage} | Provider accounting is physical-request evidence, not curation state. |
| {§loop-terminals} | A loop's terminal status is an HTTP status, exact to its outcome. |
| {§env-delta} | The environment delta: what changed since the model last looked |
| {§env-delta-log-pull} | Pull the event record, never a workspace snapshot. |
| {§env-delta-session-entry-visibility} | Session-entry visibility: the commons is global; every other resource follows lineage. |
| {§env-delta-child-activity} | Direct-child activity — Child-authored final EDIT, COPY, MOVE, SEND, executor invocation, WORK, FORK, and… |
| {§env-delta-child-termination} | Direct-child termination — The child's exact terminal loop result, except loops containing only `_plurnk`… |
| {§env-delta-commons-mutation} | Commons mutation — One successful resolved operation whose landed effects touch `workspace:///...`. |
| {§env-delta-filesystem-narration} | Filesystem narration: project-file divergence — Runtime-owned reconciliation evidence remains in the runtime… |
| {§env-delta-entry-materialization} | Executor `entry()` sink — The runtime records typed materialization evidence under its owning actor. |
| {§env-delta-attribution} | Attribution: ownership, authorship, and cause are independent. |
| {§env-delta-no-coalescing} | No coalescing: activity is never coalesced. |
| {§env-delta-passive} | Passive observation never forces a turn. |
<!-- /map -->

`PacketBuilder.buildRequestPacket` owns the engine's default ordered section
list. Trusted scheme extensions may transform that first-class list before it is
rendered or measured; {§context-fit} remains an engine-owned post-build rail.

```mermaid
flowchart LR
    defaults[Engine sections<br/>log records interleaved with complete programs] --> transforms[Trusted scheme transforms<br/>and boundary validation]
    transforms --> render[Render ordered message roles]
    render --> measure[Budget substitution and<br/>core-owned measurement]
    measure --> rail[Engine budget admission and dispatch]
```

### §packet-wire-envelope The wire envelope

Sections retain their message roles and order. System sections form the leading system message;
adjacent nonempty sections of the same remaining role form one message. With an eligible
{§emission-history}, the default envelope is:

| Message | Role | Content |
|:--|:--|:--|
| 1 | `system` | the system slot, as rendered |
| 2 | `user` | initial retained log records, up to the first replayed turn's first surviving receipt |
| 3… | alternating `assistant`, `user` | a replayed turn's operations, then that turn's receipts and the records that follow, up to the next replayed turn; native parts remain beside their READ records ({§log-wire-format}) |
| last | `user` | remaining log records and the current-status footer, from Session through Open Messages and optional Recap |

Without selected programs, the log and footer coalesce into one user message: system + user.
Each turn's operations precede its first surviving receipt.
Log records retain their order; interpolation never groups or relocates their bodies.
Stored sections retain their original roles and order: reading evidence
never converts an earlier request into a different envelope.

The digest's packet artifacts record the sections, and `.wire.json` reconstructs their text-message
envelope ({§share-packet-names}); it is not a serialized HTTP capture.

### §emission-history Emission history: a turn's operations, then its results

| Concern | Contract |
|---|---|
| Choice | `PLURNK_SERVICE_EMISSION_HISTORY`: `none`, `latest`, or `all` (default). Reasoning return is independent ({§turn-source-resources}). |
| Selection | `latest` considers only the immediately preceding completed model inference turn in this loop, never falling back to an older eligible program. `all` considers every completed model inference turn in this loop, in ascending turn order. |
| Eligibility | An admitted content program with no syntax errors and an active emission row. Rejected attempts, syntactically partial emissions, empty or reasoning-only turns, initialization and other loops supply none. Runtime failures do not disqualify an admitted program. |
| Vocabulary | Executor identities come from that turn's admitted operation evidence ({§packet-stored-shape}), not the current registry. Disabling or removing a runtime never changes its admitted history. |
| Association | Each dispatched content operation records its ordinal in the turn's frozen canonical program. Resource fan-out retains that ordinal on every concrete receipt. Reasoning operations, arrivals and runtime observations have no content ordinal. Never infer association from matching bodies, paths, or row proximity; older rows without this provenance remain self-describing. |
| Content | Replay each associated canonical operation, including its complete body, in its own closed fence; a turn's fences are separated by one blank line. No placeholders, body redaction, preview, or inspection of body text for nested operations. A log-curation KILL's distilled body belongs to its independent NOTE, not to its replay. Reasoning operations remain in their own source and receipts. |
| Placement | Put one assistant message holding the turn's surviving operations, in program order, immediately before the turn's first surviving receipt; that turn's receipts, fan-out included, and the records between them follow together in the user role, so the model sees each past response as the batch it wrote. Preserve receipt chronology and concrete fan-out targets. No history is collected at the end. `none` adds no assistant section; filtering never makes `latest` fall back. |
| Curation | A retired operation row loses its replay; retiring one fan-out receipt leaves the operation with its surviving receipts. A body-trimmed authored row is not replayed: its ordinary receipt shows the remaining body. Retiring the emission row removes that turn's replay, not its operation results or immutable source. No legend or separate NOTE-curation path exists. |
| Authority | Core assembles these chronological sections before the trusted whole-list transform ({§packet-extension-transform}); this is presentation of admitted work, not additional execution or inference. |
| Accounting | The first paired receipt's displayed curation weight includes its assistant operation once. Packet accounting measures each actual message once. The emission row charges only its own record. |

§paired-receipt A paired receipt names its operand and reports execution information, not a second copy of its request.

| Information | Paired receipt | Unpaired receipt / explicit log READ |
|---|---|---|
| Authored body | Lives in the complete assistant operation only | Ordinary body projection |
| Authored aside, scope, metadata and pattern | Supplied by the operation | Self-describing request facts |
| Operand: the concrete addressed path, each COPY/MOVE operand and each fan-out target | On its H3 (`→ path`) | On its H3, with the pattern |
| Retrieval and tool output, landed edit windows, errors, result extents, stream/resource identities and statuses | Retained | Retained |

Suppression is packet-local. Durable requests, results, exact source and recorded historical packets remain complete.

The initial user segment is `log`; later segments are `log/<first-record-coordinate>`.
Operations are `emission-history/<first-surviving-receipt-coordinate>`. These are durable, unique section
names, not model-facing headings. Only the initial segment has the `Log` header. Section-family
inspection joins segments in recorded order; wire projection uses their individual roles and
positions. Stored packets retain the sections actually sent, including older packet layouts.

### §packet-cache-monotone Default order and cache locality

Conditional absence never reorders the surviving default sections.

| Order | Slot   | Section               | Wire contract |
|------:|:-------|:----------------------|:--------------|
|     1 | system | `definition`          | Framework definition; leads the most stable prefix. |
|     2 | system | `system-policy`       | Operator policy; empty content is omitted on the wire. |
|     3 | system | `inject`              | Present only when operator notes are configured. |
|   4–5 | user / assistant | `log` and `emission-history` segments | Append-mostly chronological history: each replayed turn's operations immediately precede that turn's results ({§emission-history}). |
|     6 | user   | `git`                 | Per-turn workspace status; empty content is omitted. |
|     7 | user   | `budget`              | `Context Curation`; omitted when capacity is unknown. |
|     8 | user   | `session`              | `Session`: `{"path": "session://alice", "parent": <address or null>, "loop": L, "turn": T}`, the actor and the coordinate this packet's response becomes ({§child-orientation}). |
|     9 | user   | `work`                | `Open Work`: per-turn `{sessions, streams, messages}` pointers; always present, each list `[]` when empty ({§child-orientation}). |
|    10 | user   | `messages`            | `Open Messages`: immutable message addresses and causal sources ({§message-arrival}). |
|    11 | user   | `notices`             | Per-turn observations; empty content is omitted. |
|    12 | user   | `errors`              | Per-turn failure pointers; empty content is omitted. |
|    13 | user   | `recap`               | Optional authored operational recap. |

The order favors prefix-cache locality where semantics permit: the definition and privileged policy lead operator notes, while the append-mostly log and interpolated programs lead the volatile user-status clump. Trust is a separate admission rule: the system slot contains trusted control-plane material, observations stay in the user role, and only the model's admitted content program is replayed under assistant authorship.

| Fact | Rule |
| --- | --- |
| The status clump | never cached across turns, since the next turn's log grows into its place, so its order serves attention alone: it runs from ambient state (Git Status, Context, Session, Open Work) to what the turn owes (Open Messages) to feedback on the last turn (Notices, then Errors), and closes with the Recap; the nearer the end, the more a section asks of this turn |
| With `all` | appending new observations and programs preserves the existing history's roles and text prefix; no old program moves past newly appended observations; changing selection or curating a row may invalidate the prefix at the affected position |
| Not claimed | that every system byte is immutable or that the complete packet is globally monotone in volatility: operator notes and policies can change |

### §packet-extension-transform Trusted whole-list extension seam

`SchemeRegistry.transformSections` pipes the complete default list through
every registered scheme implementing `transformSections(sections) -> sections`,
in registration order, before rendering and measurement. The schemes-owned
`PacketSectionDraft` contains only `name`, `slot`, `header`, and `content`.
Each initial or returned list passes the schemes-owned validator, including
unique-name enforcement, before the next transformer or renderer. Each
transformer may inspect the section content and add, remove, or reorder
sections. It receives no separate engine, database, actor, or request context.
The complete default list already includes the interpolated programs ({§emission-history}) and
native READ boundaries. Transforms own section drafts, not the session's immutable source evidence.
Removing a section removes its native deliveries too; a retained native delivery requires its
named section to remain user-authored. Core measures the transformed composition.

This is strictly a trusted in-process seam, admitted through the common extension
trust gate; an external client action cannot invoke it. Whole-list transformation is
the fork-avoidance valve for alternate packet shapes, while
overflow recovery and packet projection remain closed engine concerns.

### §tokenomics Tokenomics: one room, one gauge, one rule

Token accounting distinguishes the artifact being measured, the unit, and the
time of measurement.

| Fact | Owner and unit | Time | Contract |
|:-----|:---------------|:-----|:---------|
| Core curation weight | `contentWeight = ceil(chars/2)` over channel content, canonical log bodies, and each rendered message (including the optional emission history) | Write/build | Stable, model-independent measure; never a tokenizer claim. The model meets it as `tokens`. |
| §tokenomics-context-envelope-admission Context envelope admission: provider input capacity | Provider model limits, the configured output reservation and the output floor, in provider tokens | Before every logical request | The reservation `min(maxInputTokens, contextWindow − outputBudget)` sizes the room; the wall `min(maxInputTokens, contextWindow − outputFloor)` decides admission ({§provider-capacity-admission}). The provider alone measures the complete request and admits it — with the grant flexed when the prompt is over the reservation — defers it, or rejects it at the wall. |
| Provider generation envelope | Provider response grant and optional reasoning subset, in provider tokens | Before every logical request | The reservation includes hidden reasoning; its strict reasoning subset is never additive. The response grant follows {§provider-flexed-allowance}. |
| Provider usage and cost | Provider-reported input/output/cache/reasoning tokens and monetary evidence | After every physical request | Durable physical-request forensics under {§provider-usage}; never curation state or a preflight estimate. |

§context-admission **Context admission fits one request through the room: estimated, then measured.** Core checks the packet against the wall on its calibrated estimate, marks an over-budget packet with one error row, then has the provider assess the exact request before it is sent. The daemon never hides, folds, or strips stored rows or emission history to make a packet smaller; a packet over the wall by either measure ends its loop.

```mermaid
flowchart TD
    build["Build the packet at the budget"] --> wall{"Estimate over the wall?"}
    wall -- yes --> overflow["window-overflow 413, no inference request"]
    wall -- no --> over{"Over budget, no row yet?"}
    over -- yes --> row["One over-budget row at the head of the turn"]
    row --> wall
    over -- no --> assess{"The provider assesses the exact request"}
    assess -- "admit or defer" --> send["Send"]
    assess -- "exact refusal" --> overflow
```

- §context-budget **The context budget is one room for the whole packet.** The budget is the provider's input capacity translated by the loop's calibration offset, `max(0, inputCapacity + offset)` ({§tokenomics-calibrated-readout}), and it bounds the whole packet — teaching, catalog, log and gauge together. Nothing on the service panel sizes a part of it: no projection share or preview page. When a settled emission updates the offset, the budget follows it either way; a room that shrinks under the model is announced by the over-budget row ({§context-over-budget-row}), never hidden by keeping a larger figure.
- §context-gauge **One gauge.** Every packet carries one `## Context` section holding one JSON object: `tokens`, the packet's weight as rendered, `budget`, the known room, and `percent`, `floor(100 × tokens / budget)` over the gauge's own final figures, so the share never disagrees with the counts beside it; a zero budget states no share. Only when the packet without an inventory strictly exceeds `PLURNK_SERVICE_BUDGET_PRESSURE` of its budget does `largest` name the `PLURNK_SERVICE_BUDGET_LARGEST_ITEMS` heaviest retained log rows as `{path, tokens}`, ranked by weight then path. Unknown budget omits `budget`, `percent` and `largest`. The final `tokens` includes the inventory; over budget, its full configured count remains available for curation ({§context-over-budget-row}). Each log row heading carries its own `tokens`. The gauge is state: it never presents `budget − tokens` as response allowance and carries no mandate.
- §context-fit **One rule: whole if it fits, otherwise as much as fits, then its size and address.** A result the model asked for — a READ without a scope, a FIND, an exec result delivered on close — arrives complete when its weight fits within `budget − tokens` as of that turn, less the room the turn still owes — one receipt's measured weight for each result still to land in it and the emission record that answers it, so that the receipts of a batch and the answer always fit. Otherwise the complete result stays where it was read from and the row is a `413` receipt naming the result's size, its weight, the remaining budget, and the two verbs: `READ` a range, or `KILL` first. Result cuts are named where they happen: the first page of what came back unasked in size ({§markerless-first-page}) and the cut at the room in the receipt.

  | Result | When it does not fit |
  | --- | --- |
  | A READ of lines | carries, above its receipt, the longest prefix of those lines whose row fits that room — the lines with their anchors, the returned range closed on the last line delivered, and the receipt naming the lines delivered |
  | A result whose first line does not fit, a FIND, a stream page, a byte view | a bodiless receipt |
  | An arrival the model did not ask for — an inbound `SEND`, a child's conclusion | the same bodiless receipt as a fact, not an error: its size and its address |
  | Explicit scopes (`<a,b>`, a pattern, `<1,-1>`) | exact, and take the same test |
  | The optional emission history | whole or absent ({§emission-history}), never a cut |

- §context-verbs **The verbs are the curation.** `READ` with a range takes a piece of what did not fit ({§read}); `NOTE` keeps what the model learned; `KILL` retires rows, ranges and bodies ({§log-kill-scope}) and may carry what it keeps of them as its own NOTE ({§log-kill-scope}). The daemon adds no other mechanism.
- §context-over-budget-row **Over budget is a row and a request, not an ending.** A packet whose weight exceeds `budget` is still submitted when it fits the window ({§context-wall}), and it carries one `_plurnk` error row at the head of its turn, `engine/context/packet-exceeds-budget` 413: "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn." The limit protects a loop; it never ends one.

  | The row | Rule |
  | --- | --- |
  | Carries no figure | the row is the mandate: the gauge is the one home for `tokens` and `budget` ({§context-gauge}), and it shows the packet over with the row in it |
  | Shown once | in the packet it describes, then retired from the projection as a no-match KILL receipt is ({§log-history-projection}): it stays durable and readable at its coordinate, and a later packet that is over carries its own row |
  | Hides nothing | nothing is hidden to make the packet smaller; the response grant is the window's remainder above the provider's output floor ({§provider-output-floor}) |

- §context-wall **The context wall is the provider's window, and only it ends a loop.** The wall is the provider's physical input limit: `maxInputTokens`, and the context window less the output floor ({§provider-output-floor}). A packet that exceeds the wall by either measure ({§context-wall-measure}) ends its loop with the exact `engine/context/window-overflow` 413 Problem, and no inference request is made. An unknown window has no wall ({§tokenomics-window-unpollable-deliberate}).
- §context-wall-measure **The wall measures the request that will be sent.** The estimate is the packet's weight translated by its calibration offset, `max(0, weight − offset)` ({§tokenomics-calibrated-readout}), and is never assumed to overestimate. A packet that fits by the estimate is assessed by the provider as the exact wire request ({§provider-capacity-admission}): an admission sends it; an exact refusal is the wall's verdict and ends the loop. A provider that can only estimate defers, and the upstream provider is then the capacity oracle: its refusal ends the loop with the provider's own 413.
- §tokenomics-weight-stored-at-write **Curation weight, stored at write.** `entry_channels.weight` weighs the complete channel content. `log_entries.weight` weighs the complete canonical `LogBody` content before coordinate and packet presentation; persistence `tx`/`rx` envelopes contribute nothing merely by existing, and proposal settlement recomputes the value when the canonical result changes. Bodyless rows therefore weigh zero. The stored number is a stable content-depth measurement, not a provider-token prediction. `entry_channels.lines` is the channel's line count beside it, a stored generated column SQLite keeps on every write as the persisted mirror of {§logical-line-count} (a trailing newline terminates the last line; empty content has none), so a catalog lists extent without reading bodies.
- §tokenomics-render-weight-budget **Packet curation budget.** `tokens` measures the *complete assembled packet* after section transforms and readout substitution, each rendered message (including {§emission-history}) and native attachments; it is not a sum of stored row weights ({§tokenomics-weight-stored-at-write}). Core measures minimum-width probes, monotonically expands fields that do not fit, then right-aligns final values into those widths; final substitution is length-invariant and the displayed total equals the stored request weight. Receipt, FIND-item, pressure-inventory, total, and ceiling figures all use the same curation ruler. A `SUM` of stored content weights measures a different artifact and cannot substitute for packet render weight.
- §tokenomics-calibrated-readout **The calibrated readout translates capacity by measured evidence, never extrapolating unmeasured content.** A sample is a settled emission response pairing its request's measured packet weight with the provider-reported prompt count, both positive. Calibration never changes stored weights, rendered receipt costs, or the immutable request history ({§tokenomics-agnostic-ruler}).

  | Fact | Rule |
  | --- | --- |
  | The offset | a loop's latest settled sample from the answering model fixes the additive offset `weight − reported` for its next packet; until the loop settles one of its own, its packets use that model's most recent sample from any loop or session, and a model that has none uses `0` |
  | The conversion | `max(0, inputCapacity + offset)` converts provider capacity into curation units, the budget ({§context-budget}), crediting only the tokens saved on the measured packet while budgeting unmeasured growth 1:1; `max(0, weight − offset)` converts the packet's weight into the wall's estimate ({§context-wall-measure}); zero means no room fits, and unknown input capacity remains `null` |
  | The packet | captures this allowance and its offset once for its readout, pressure inventory, wall estimate, and persisted client gauge; later responses cannot change that packet's allowance |

- §tokenomics-window-partition **The window partition: one capacity derivation, no service-side token budget.** The provider owns model limits, the configured output reservation, and each call's response grant. Its resolved `inputCapacity` supplies the physical denominator exposed to clients and the boundary conversion into curation units ({§tokenomics-calibrated-readout}). Core shapes context in curation units; provider request-shaped evidence alone admits or rejects physical I/O. Local and custom deployments tune context window, total output budget and optional reasoning subset at their owning layers.
- §tokenomics-window-unpollable-deliberate **An unpollable window is deliberate: unknown provider capacity stays unknown.** When the provider cannot derive `inputCapacity`, there is no budget: the gauge carries `tokens` alone, every result arrives whole, and the provider remains the capacity oracle ({§provider-capacity-admission}). Core never invents a stand-in.

§tokenomics-client-gauge **Clients receive curation and physical occupancy as separate pairs.** `loop/packet.gauge`, after each packet-bearing model turn, and `loop/terminated.usage`, at the Loop's end, carry latest packet-bearing model-turn `curationWeight`/`curationBudget` and latest-emission-call `contextTokens`/`contextCapacity`; each unknown fact is `null`. The curation pair is the packet's measured weight and captured allowance, exactly as displayed to the model, not a recalculation using newer usage evidence. Packetless chronology cannot erase an assembled-request gauge. Both physical facts bind to that same call: a preflight rejection may report capacity while its absent physical request leaves `contextTokens=null`, never borrowed from an earlier call. Clients never divide provider-reported physical tokens by Core curation weight. `providers.list` exposes each instantiated alias's `inputCapacity`. A model switch replaces the latest-turn facts together; aggregate provider accounting remains cardinal monetary evidence, not a gauge input.

- **Derivation is exhaustive and demand-led.** Explicit searchable-resource changes may start one coalesced warm. Passive creation and attachment do not. The first model turn starts or joins that warm; later turns derive intervening changes before dispatch. No model operation observes partial graph or full-text coverage. Progress notices make the wait visible. {§persistent-search-index}
- §membership-binary-sniff **Binary truth beats a text label.** Filesystem source acquisition, including tracked members and installed skill resources, inspects up to the first 8192 bytes when extension detection does not identify a binary type. NUL marks `application/octet-stream`; existing binary types retain their declared type. Member projections follow {§derivation-dedup-parallel}; installed skill projections follow {§skills-resources}.
- §tokenomics-agnostic-ruler **One model-agnostic curation ruler.** The daemon runs sessions on different models in one workspace concurrently, while catalog and log accounting are workspace-wide. `contentWeight = ceil(chars/2)` therefore gives one content one stable number without per-model workspace state or recount passes. It controls curation only; every provider call independently measures the complete request as well as it can.
- §tokenomics-content-hash-identity **Content identity, not per-tokenizer counts.** A settled channel's `content_hash` (SHA-256) is its body's identity in the content store ({§content-store}); a writer may bind it, a bound hash must match the content, and an active stream has none until it settles. `weight` is stored beside that content and is never keyed or recomputed by model.
- §tokenomics-provider-usage **Provider accounting is physical-request evidence, not curation state.** Every issued physical request has one durable pre-I/O `provider_requests` identity beneath the normalized {§provider-surface} and settles once as response or error. This is operational request accounting, not invoice reconciliation. Output and reasoning are quantities the model cannot KILL, so they never alter the model-facing Budget ledger.

  | Fact | Rule |
  | --- | --- |
  | Each record | preserves conventional {§provider-usage} quantities and required {§provider-cost} evidence; an unreported quantity remains absent, including on response-less failures, and is never replaced by zero |
  | Ownership | `model_calls` own response/failure evidence, `turn_attempts` specialize emission admission, and `provider_requests` are the sole durable accounting representation, so emissions, BARE calls, rejected responses, retries, failovers, and errors remain cardinal and ordered |
  | Derivation | turn, loop, session, workspace, digest, and protocol accounting are derived from those records through the shared {§provider-accounting} projection; only emission calls contribute the latest-packet context gauge; the baseline stores no floating-point money, denormalized totals, or rollup triggers |
  | Cost | a documented direct charge becomes `charged`; otherwise the provider may compute an exact-decimal USD `estimated` amount from complete usage and the exact model's Models.dev rates; insufficient evidence becomes `unknown`; complete totals and known subtotals remain distinct under {§provider-accounting}, unknown requests cannot impersonate free requests, and missing usage never becomes zero |

Each physical request also retains {§provider-request-evidence}, atomically
with its accounting settlement. Failure does not discard received fragments.
The digest emits one linked `requests/<id>.json` artifact per physical request,
including unavailable evidence as `null`, reading heavy records one at a time.
Failed partial operations and reasoning remain forensic data only; they never
execute, enter model history, or become a later request's successful output.

- §loop-terminals **A loop's terminal status is an HTTP status, exact to its outcome.**

  | Status | Outcome |
  |---|---|
  | 100 / 102 | Queued / running |
  | 202 | WAIT or an eligible final response joining a live obligation ({§loop-completion}, {§session-wait-timing}) |
  | 200 | Messages answered, results observed, held work settled |
  | 499 | Session-scope or client cancellation |
  | 429 | Turn allowance exhausted |
  | 413 | A result that does not fit ({§context-fit}), a packet over the budget ({§context-over-budget-row}: a row; the request still goes), a packet that exceeds the window ({§context-wall}), or an upstream provider's own refusal ({§context-wall-measure}) |
  | 500 / 508 | Strike threshold or invalid-emission exhaustion / crossing strike caused by a cycle |
  | 504 | Loop timeout or exec-timeout restamp |

  An empty WAIT continues at 102. The exact terminal result retains its Problem;
  status classes are not catch-all replacements for that evidence. No failing status
  here is ever softened because the model wrote something the harness could not read;
  every one of them cites it instead ({§outside-text}).

### §env-delta The environment delta: what changed since the model last looked

Catalog FIND results ({§packet-catalog}) state what existed when observed. The
environment delta supplies structurally addressed activity without copying the
workspace into every session's private state.

```mermaid
flowchart LR
    child["Child commits activity"] --> event["One durable occurrence"]
    commons["Any session mutates workspace:///"] --> event
    event --> parent["Direct-parent audience"]
    event -->|"commons only"| global["Workspace audience"]
    parent --> pull["Pre-turn lossless pull<br/>(cursor, captured high-water]"]
    global --> pull
    pull --> log["Observer's self-contained log<br/>origin=_plurnk"]
    log --> packet["Packet lists coordinate;<br/>READ recalls exact body"]
```

§env-delta-log-pull **Pull the event record, never a workspace snapshot.** At
pre-turn, a session materializes only occurrences whose structural audience
includes that session. The set is exhaustive, unranked, and exactly once; the
engine makes no relevance decision. Each copied event retains the operation,
result, and typed attributes.
Every producer appends to one workspace-scoped occurrence journal with a
monotonic identity. A pull captures one closed `(session cursor, high-water]`
interval, materializes each addressed identity idempotently, then advances the
cursor only after the whole interval is durable. An event racing the capture is
therefore in this interval or a later one, never neither or both. Source-log
curation cannot erase the occurrence record.

The cursor is observation progress, not a private copy of resource contents. A
fresh session captures the current high-water when its session row is created, so
pre-existing broadcast history stays out while later occurrences remain
deliverable even before its first packet. A fork instead copies the parent's
cursor and captures its own fork high-water atomically with session creation
({§machine-processes}). Observer rows retain the source
identity and never publish another occurrence. Newly materialized ambient and
terminal-stream rows emit the ordinary client notification
({§notifications}) before the next inference; an idempotent
pull does not emit an existing row again.

§env-delta-session-entry-visibility **Session-entry visibility: the commons is global; every other
resource follows lineage.** A successful state-changing `EDIT`, `COPY`, `MOVE`,
entry-path `KILL` whose landed effects touch `workspace:///...` acquires the workspace
audience and retains the commons address in its observer row. Mutations to
`session://<session>/...`, named session spaces, project files, and remote resources do
not broadcast. When authored by a child, their
ordinary operation evidence still reaches that child's direct parent.

| Producer / event                                      | Durable occurrence                                                                                     | Observer projection                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| §env-delta-child-activity Direct-child activity       | Child-authored final EDIT, COPY, MOVE, SEND, executor invocation, WORK, FORK, and targeted non-log KILL receipts, including failures. `_plurnk` initialization, maintenance, and operation turns stay with the session. A reply already delivered to the parent uses its reply occurrence instead ({§message-reply-delivery}). | Direct parent only; one exact attributed row born body-suppressed. Incoming message projections ({§message-arrival}), NOTE, READ (including executor-output READs), FIND, BARE, WAIT, and log KILL never create activity occurrences. Provider reasoning, calls, rejected emissions, and turn sources do not cross automatically. |
| §env-delta-child-termination Direct-child termination | The child's exact terminal loop result, except loops containing only `_plurnk` operation or maintenance turns. A conclusion before the first turn still reports, including failed spawns. `source` names the actor; the READ selects the exact loop ({§message-completion}). | Direct parent only; bounded, initially visible READ under {§session-scheme}, never the child's potentially newer loop. Excluded administrative loops create no pending child-result edge. |
| §env-delta-commons-mutation Commons mutation          | One successful resolved operation whose landed effects touch `workspace:///...`.                         | Every existing session; one body-suppressed row per observer, deduplicated with any lineage audience.                               |
| §env-delta-filesystem-narration Filesystem narration: project-file divergence | Runtime-owned reconciliation evidence remains in the runtime actor's own log.                        | No ambient observer row. Current content remains addressable and stale hash edits reject at their owned boundary.                 |
| §env-delta-entry-materialization Executor `entry()` sink | The runtime records typed materialization evidence under its owning actor.                           | No ambient observer row unless the resulting operation itself is direct-child activity or a commons mutation ({§execution-output-identity}). |

§env-delta-attribution **Attribution: ownership, authorship, and cause are independent.**

| Field       | Meaning                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_id` | The session whose self-contained log owns the materialized row.                                                                                                                          |
| `origin`    | The actor tier that wrote the row; a materialized delta is `_plurnk`.                                                                                                                   |
| `source`    | The attributed actor or subsystem: a lineage or commons observation uses canonical `session://<producer>`; a subsystem observation may use its stable token (for example `file`). Self-authored rows omit it. Stream invocation correlation belongs to the subscription/publication relationship, not this field. |

§env-delta-no-coalescing **No coalescing: activity is never coalesced.** Each eligible child
action and each commons mutation has one occurrence identity. Combining
them would destroy causal order and conflate event replay with a state
comparison.

§env-delta-passive **Passive observation never forces a turn.** Deltas materialize only
while a packet is already assembling. Intermediate child activity and commons
broadcasts therefore cannot wake an idle session. Urgent directed communication
uses the voice door ({§actor-boundary}); child conclusions and addressed
replies use {§session-causal-admission} and {§message-reply-delivery}.
Stream progress remains owned by {§exec-stream}.

---

## §packet Packet shape

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§packet-markdown} | The packet's Markdown projection (#626). |
| {§packet-stored-shape} | A model packet preserves the rendered request and, only when an emission is admitted, its response. |
| {§packet-items} | Sections are rows over content-addressed items; the bag never holds them. |
| {§definition-table-projection} | The definition's tables are projected, not authored. |
| {§body-projection} | One full body, one readable view, one packet projection. |
| {§markerless-first-page} | What the model did not ask for in size arrives as its first page. |
| {§message-arrival} | A message source, its log observations and its reply state are distinct. |
| {§message-reply-delivery} | A reply is delivered once, not re-enqueued as a request. |
| {§message-short-identity} | The model addresses a message by its short name. |
| {§message-causal-source} | Message authorship and delivery are distinct facts. |
| {§message-projection} | Message storage is unbounded by model context; its arrival in the packet is not. |
| {§message-loop-containment} | A loop contains every message that arrives before it concludes; the next turn boundary publishes every inbox… |
| {§completion-defers-to-messages} | Completion defers to messages: a conclusion does not cross an unobserved arrival. |
| {§packet-catalog} | Catalogs are query results, not packet state. |
| {§operation-results} | Operation results: model-facing failures and notices |
| {§operation-result-uniform-error-channel} | One uniform error channel within an accepted turn. |
| {§log-row-self-explains} | A log row self-explains: every ≥400 pointer names a record that states its why. |
| {§notice-drain-on-read} | Notices |
| {§rail-accounting-private} | Rail accounting is private. |
| {§continued-without-note} | A continuing turn that carried no NOTE is told so, in the card's own words. |
| {§notice-callout} | A notice speaks in the card's callout form. |
| {§notice-level} | Severity on the wire (`level`, required). |
| {§operation-result-no-error-scheme} | There is no error scheme. |
| {§notice-event-notify} | Notices notify the client surface. |
| {§loop-status-notice} | The loop status notice carries lifecycle and its observation deadline together. |
| {§share} | A share is the database's record, ready to send. |
| {§share-scope} | A share is unredacted. |
| {§share-folder} | Shares land in one place. |
| {§candidate-pinned-runtime} | Candidate runtime stays pinned. |
| {§output-allowance-notice} | The output allowance is not disclosed; a ceiling cut names its cause. |
| {§turn-lifecycle} | Turn-lifecycle liveness. |
| {§turn-accounting-notice} | The turn accounting notice: the completion beat carries the spend. |
| {§notice-content-offset-pointer} | Content-offset position. |
| {§tools-resource-discovery} | Executable capability discovery uses ordinary Plurnk resources. |
| {§tools-resource-materialization} | Tool resources materialize from one workspace snapshot. |
| {§tool-document-header-only} | A header-only tool document: |
| {§tools-summary-invocation} | A summary featuring one exact enabled tool invocation includes its compact input signature after literal `\n`… |
| {§members-functionality} | File membership is one workspace Functionality family. |
| {§members-configuration} | *Available definitions.* `PLURNK_MEMBERS_<alias>=<glob>` declares one service-origin rule (`!glob` excludes),… |
| {§members-model-scope} | *The model's authority.* A model's `add` is admitted against `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` in the… |
| {§members-projection} | The members projection is one overlay of the workspace's enabled definitions. |
| {§plurnk-skill} | Plurnk's own reference is an ordinary service-provided skill. |
| {§schemes-directory} | Scheme references are ordinary workspace entries at `workspace:///_plurnk/plurnk/<scheme>.md`. |
| {§inject} | system.inject — the operator injection |
| {§packet-inject} | When `PLURNK_SERVICE_PACKET_INJECT` names a readable markdown file, its content renders as an `## Operator… |
| {§card-read-per-wake} | The card is read from disk at every loop start and wake, never held. |
| {§policy} | system.policy — the client's policy injection |
| {§policy-sections} | One section rides the system slot **after the definition**: the contents of `PLURNK_SERVICE_POLICY` (unset… |
| {§schemes-self-doc-materialization} | Self-documentation materializes one generated reference tree per workspace. |
| {§packet-git-status} | The Git status section — compact repository state |
| {§recap} | Optional Recap footer |
| {§recap-lines} | The operator's recap lines lead the footer: every non-empty `PLURNK_SERVICE_RECAP_LINE_<alias>`, in alias… |
<!-- /map -->

§packet-markdown **The packet's Markdown projection (#626).** Core renders the transformed section list into the ordered messages of {§packet-wire-envelope}; within each message, section order is preserved. Core owns the order at {§packet-cache-monotone}; a trusted extension may transform the section list before rendering ({§packet-extension-transform}).

| Section | Renders as |
| --- | --- |
| Nonempty, with a header | an H2 immediately followed by its JSON object/array content; non-JSON content has one blank line after the header |
| A null header | only its content |
| Empty content | omitted: any node whose content is empty is absent from the wire, except the child-orientation sections, which state emptiness as `[]` ({§child-orientation}) |
| Between sections | trailing newlines are removed from each section, and rendered sections are separated by one blank line |

The projection preserves the evidence section owners supply: paths, URI fragments, log coordinates, scopes and coordinate-prefixed body lines remain usable without translation; curation and log-row measurements stay attached to what they measure ({§tokenomics-agnostic-ruler}); statuses, Problems, body visibility and bodyless rows render as produced, never upgraded or suppressed; operation examples remain typed fences and log records keep their boundaries ({§log-wire-format}).

| Default section | Slot   | Wire form                                                                                     | Semantic owner                  |
| --------------- | ------ | --------------------------------------------------------------------------------------------- | ------------------------------- |
| `definition`    | system | Bare `plurnk.md`; no wrapper heading                                                          | {§definition-table-projection}  |
| `system-policy` | system | Authored Markdown                                                                             | {§policy-sections}              |
| `inject`        | system | Authored Markdown                                                                             | {§packet-inject}                |
| `log`, `log/<coordinate>` | user | Chronological Markdown H3 records with JSON metadata | {§log-wire-format} |
| `session`        | user   | JSON `path` with the literal Session address, `parent` (address or `null`), `loop`, `turn`     | {§child-orientation}          |
| `delegation`    | user   | JSON `{sessions, streams}`                                                                    | {§child-orientation}            |
| `errors`        | user   | JSON status/log-path pointers                                                                 | {§operation-results}            |
| `notices`       | user   | One alert callout per notice, directive first                                                 | {§notice-callout}               |
| `git`           | user   | Working-tree state in a NOTE blockquote                                                       | {§packet-cache-monotone}        |
| `budget`        | user   | JSON curation usage and ceiling                                                               | {§context-gauge} |
| `messages`      | user   | JSON pointers to the loop's unanswered immutable messages, path and source                    | {§message-arrival}              |
| `recap`         | user   | Optional authored operational recap                                                           | {§recap}                        |
| `emission-history/<coordinate>` | assistant | Complete retained operations at their emission records; replay omitted whole at capacity | {§emission-history} |

§packet-stored-shape **A model packet preserves the rendered request and, only
when an emission is admitted, its response.** Core assembles and measures the
request under {§packet-assembly}. An admitted response extends that same record
before the turn closes; a failed provider call or exhausted invalid emission
leaves the request-only record, while rejected exchanges remain in their
`inference_calls`/`model_calls` evidence with classification in
`turn_attempts`.

| Turn state                    | `turns.packet` (the bag) + `turn_sections` rows  |
| ----------------------------- | ----------------------------------------------- |
| No admitted model request (including initialization and local capacity rejection) | SQL `NULL`, no rows |
| Request assembled             | `{ weight, attributions }` + the ordered sections as items; each selected program is stored at its emission boundary, with no empty placeholder ({§emission-history}) |
| Response admitted             | `{ weight, attributions, assistant, assistantRaw }` + the sections as items |

§packet-items **Sections are rows over content-addressed items; the bag never holds them.** Every rendered block — one log row's record, one non-log section's content — is stored once in `packet_items` under the SHA-256 of its text (`sha256`, a registered function), and a turn stores its composition in `turn_sections` and `turn_section_items`: the ordered sections and, per section, the ordered item hashes.

- A section's content is its items joined by one blank line, so a log row whose rendering did not change between turns hashes to the same item and a turn's durable cost is its new and changed items — the copied prefix of the previous packet is transient data and is never written. A packet transformed by an extension, or any non-log section, is one item.
- The write is one statement: an INSERT into the `turn_inference_evidence` view, whose INSTEAD OF trigger refuses a turn that is not an open model inference turn and lands the items, the composition, the bag, and the provider metadata together.
- Readers of a whole packet select from `turn_packets`, which assembles `sections` back into the bag byte for byte (the digest, and every test that inspects a stored packet); statements that need one field read the bag directly with `json_extract`.
- Items no composition references are transient data: `retention_collect_packet_items` collects them under the retention policy ({§content-store}), which is how a deleted session's or workspace's packets release their space while shared items survive. A fork copies the composition and shares the items ({§machine-processes}).

| Field                   | Presence                         | Contract                                                                                                                                                                      |
| ----------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weight`                | Every assembled model request    | Curation weight of both rendered request slots. Admission does not change its meaning; it is never response weight or provider usage.                                          |
| `sections`              | Every assembled model request, as rows ({§packet-items}); assembled back into the bag by `turn_packets` | Ordered post-transform request sections. `PacketWire.renderSlot` groups them into system and user messages, and the digest re-renders those stored sections byte-for-byte.     |
| `sections[].weight`     | Every stored section             | Independently measured curation weight of that section. Their sum is not the rendered request weight because slot separators and independent rounding remain outside each row. |
| `assistant.content`     | Admitted response only           | Accepted model content from which operations were parsed.                                                                                                                     |
| `assistant.ops`         | Admitted response only           | Parsed operations admitted from that content.                                                                                                                                |
| `assistant.reasoning`   | Admitted response only           | Normalized readable reasoning text, or `null`.                                                                                                                               |
| `assistantRaw`          | Admitted response only           | Opaque provider-owned transport record retained for forensics; `null` when the provider supplies no raw record.                                                               |

`StoredPacket` is the one core type and validation path for this algebra. The
flat schema enforces its root states; typed reads additionally validate every
section and parsed operation. A hard budget stop remains request-only. Client,
setup, filesystem-narration, and executor-materialization turns are ordinary
operation turns and therefore store `NULL`. Digest projects exact operation
source independently from this optional model-exchange record; a request-only
turn receives a note instead of a fabricated response.

he external tokenless draft and transformation boundary is owned by
{§scheme-packet-transform}. Core alone extends each validated draft with its
measured `weight` field for storage. #74 tracks coverage that mistakes the sum
of section weights for the rendered request weight.

§definition-table-projection **The definition's tables are projected, not authored.** The authored `plurnk.md` remains human-aligned. Its `definition` section deterministically removes Markdown table-cell padding and shortens separator cells to three dashes before extension transforms, measurement, storage, and wire rendering; alignment colons survive, while fenced blocks and all non-table whitespace remain exact.

§body-projection **One full body, one readable view, one packet projection.** Every durable log row has one canonical full body resolved from its stored tx/rx envelope by `LogBody`. READ and FIND over `log:///`, persistent search derivation, and packet rendering apply the same deliberate trimming under {§log-kill-scope}. Packet rendering additionally applies initial suppression and these presentation bounds:

| row producer | ordinary visible projection |
|---|---|
| any `READ` or `FIND` | the result as its own page ({§markerless-first-page}), complete when it fit; otherwise the `413` receipt, above the longest prefix of a READ's lines that fit ({§context-fit}) |
| `NOTE`, `WAIT` | complete literal authored text |
| inbound `SEND` from outside the workspace | the operator's: complete when it fit, otherwise its size and address ({§context-fit}, {§message-projection}); a peer session's: its first page ({§markerless-first-page}) |
| structured `EDIT` receipt or textual `COPY`/`MOVE` effects | complete receipt-owned join context |
| every other nonempty body | the model's own: complete; what it did not author: its first page ({§markerless-first-page}); then {§context-fit} |
| the `reasoning` row | the optional reasoning preview under {§turn-source-resources} |
| bodyless row | heading and any facts; no coordinate lines; `tokens` includes any selected native part |

§markerless-first-page **What the model did not ask for in size arrives as its first page.** A READ or FIND without a scope, a stream delivered when a command closes, a peer session's message, an environment delta, an extension's body and a rejected emission shown back all arrive as their first page: `PLURNK_SERVICE_PREVIEW_LINES` lines and at most `PLURNK_SERVICE_PREVIEW_CHARS` characters, in the projection's own units — lines of text, bytes of a byte view ({§binary-parity}), results of a FIND — with one fact in one notation stating the page and the whole, `<1,100> of 4812 lines` (`range` on a retrieval, `preview` on a stored body, {§log-wire-format}). No operation carries a page size of its own.

| Rule | What |
| --- | --- |
| stands whole | what the model authored — a NOTE, a WAIT, the body of its SEND, the prompt of its WORK or FORK, and the command it handed an executor — and what it asked for exactly: an explicit scope (`<a,b>`, `<1,-1>`, a pattern) and an EDIT receipt, bounded by its own rule ({§edit-result-receipt-projection}) |
| takes its page | what it did not ask for in size, as above; its own reasoning, when it lands as a row, stands whole only when it fits the row's page and otherwise takes its last page ({§turn-source-resources}) |
| the only exceptions | the operator's message keeps its own rule ({§message-projection}) and emission rows remain folded ({§turn-source-resources}), so the model can reason about every page the same way |

A page lands under {§context-fit} like any result: whole when it fits the remaining budget, otherwise the prefix and receipt. Retrievals take their page at the source, before storage, and the packet applies no second cut to a stored result; a stored body takes its page in the packet, and the rest stays readable at the row's address.

READ and FIND own their range or pagination before packet rendering; the packet never applies a second hidden substring bound to their selected result. Reasoning arrives through ordinary scoped READs ({§turn-source-resources}). When a visible projection differs from its canonical body, metadata carries `preview` under {§log-wire-format}; complete and fully suppressed bodies omit it. ```` ```READ (log:///<coordinate>/<OP>) ```` selects untrimmed lines in original coordinates under {§log-kill-scope}; the unsuffixed exact shorthand and authoritative suffix behavior are defined by {§log-history-projection}. ```` ```FIND (log:///...) ```` and search match that same readable view. System/policy sections are not log bodies. Notices are transient non-log observations; they share the ordinary line/character bounds but have no durable body or recovery URI.

§message-arrival **A message source, its log observations and its reply state are distinct.**

| Fact | Owner | Curation effect |
|---|---|---|
| Accepted body, attachments, address and causal source | Durable inbox message | None; ordinary READ/FIND/COPY can recover the source. |
| Arrival seen at a turn boundary | One inbound SEND log row, `origin="_plurnk"`, `attrs.kind="message"` | Ordinary KILL can trim or remove this observation. |
| Answered messages | Successful executed reply, {§message-completion} | None; curation cannot retract delivery. |

Every accepted message enters its recipient loop's inbox in arrival order, with its selected
paths, and publishes exactly once at the next turn boundary. **Open Messages** lists the
unanswered messages by their immutable source address (`path`) and their sender — a causal
`source`, or `"origin": "user"` for the operator's own ({§message-causal-source}) — not a log coordinate. Each arrival receipt's `resource` names that same retained source.
Trusted protocol modules supply message addresses in their own scheme;
native arrivals use `message://<recipient>/<opaque-id>`, separate from the session's
actor and scratch addresses. Ordinary session scratch remains writable. Source bodies
are not edited or deleted through resource operations; independently curatable READs and
arrival rows obey {§log-kill-scope}. No curation operation answers a message.
Within a workspace an address identifies exactly one accepted message. Reusing it for
another admission is a 409 conflict, not a second message or an implicit content update.

§message-reply-delivery **A reply is delivered once, not re-enqueued as a request.**

| Audience | Delivery | Effect |
|---|---|---|
| Assigned session | Its own log, even when another actor answered | Visible reply; wakes eligible parked work without a new Open Message or loop. |
| Original native sender | That session, if distinct from the assigned session; original delegated-task answers use {§session-scheme} instead | Other replies use the same wake and observation path. |
| Exterior sender | The assigned session's protocol adapter | The adapter delivers the answer through its standard message channel. |
| Replying actor | Its own executed SEND | No duplicate ambient occurrence. |

The successful SEND and its addressed occurrences commit together. Reply occurrences use
the ordinary durable ambient cursor and wake revision; curation cannot revoke delivery or
replay it. An addressed reply replaces the same parent's generic activity observation.
The child's reply to its original parent-delegated message reaches that parent once,
through the conclusion READ under {§session-scheme}; it is not a separate reply
occurrence. Other replies remain ordinary messages. The exact loop remains addressable
under {§message-completion}.
Unobserved replies prevent conclusion just as unobserved child results do. All operation
producers notify the same settlement path after durable execution; reply wake-up shares
{§session-causal-admission}, without delaying the replying program.

§message-short-identity **The model addresses a message by its short name.** Every message carries
`message://<session>/<key>` (`key_path`), the form the session docs teach, and that is what the packet
shows in Open Messages and in an arrival row's `resource`. A client's own identity for the same
message — an ACP message UUID — stays the durable `path` that correlation,
delivery and reply accounting use, and remains addressable in its own scheme; the short form is an
additional alias. Answering either reaches the same message.

§message-causal-source **Message authorship and delivery are distinct facts.** The harness publishes every arrival row; the row's `source` carries the canonical address of the causal actor. Attribution persists with the message through the inbox, parking, orphan recovery, restart, and later log projection; model syntax cannot author it. The Open Messages pointer carries the same attribution ({§message-arrival}).

| Arrival | `source` |
| --- | --- |
| Native WORK, FORK, and directed session SEND | `session://<sender>`, derived from the authenticated sender session ID |
| A trusted exterior adapter | its own canonical actor address through {§methods}: the ACP module names the client's message under `acp://` ({§acp-run-source}) |
| Absent | the operator |

The wire renders the row's `source` in place of its `origin`, which is constant for every arrival, except where the source is the transport that minted this very message, which says nothing the address does not ({§message-short-identity}). The operator's message is then the one arrival with no sender to show, so it renders `"origin": "user"`; a bare arrival would read as the model's own SEND and hide the request it answers.

§message-projection **Message storage is unbounded by model context; its arrival in the packet is not.** Core persists every accepted message completely before packet assembly. An arrival renders complete when it fits the remaining budget ({§context-fit}) and otherwise as its size and address, where a READ of the message's log body, scoped or whole, retrieves it. A peer session's message is received text and arrives as its first page ({§markerless-first-page}). No share of the capacity is set aside for arrivals, and no knob sizes one.

§message-loop-containment A loop contains every message that arrives before it
concludes; the next turn boundary publishes every inbox row the loop has not yet
published, oldest first, and stamps each with the row it became. Ordinal 1 is the loop's
own assignment and shares the loop's fate: a loop that fails before its first turn does
not replay it. Every other still-unpublished message at conclusion moves into one
source-keyed recovery loop, renumbered from its first, whose headline it becomes; that loop's first turn publishes the complete
ordered set exactly once. The recovery loop retains the source loop's model routes,
effort, and call ceiling; message bodies and attribution are preserved directly from
their durable rows. Recovery retries complete the same queued loop and never
mint duplicate work. Output withholding preserves readable arrival rows; explicit
KILL follows the ordinary log contract.

§completion-defers-to-messages **Completion defers to messages: a conclusion does not cross an unobserved arrival.** The end-of-program check includes messages that arrived during inference. The final database transition atomically requires every inbox message to be published and the loop's observed wake revision to equal its session's current revision. Answer delivery is not this barrier. An arrival that wins the race continues the current loop; one admitted after conclusion belongs to a new loop. Orphan recovery preserves messages accepted before an independently forced termination.

§packet-catalog **Catalogs are query results, not packet state.** The packet
stores no materialized manifest. Complete and one-level entry directories,
their row shape, and their ordering are ordinary FIND projections owned by
{§find-result-projection}; persistent search derivation is a separate index.

### §operation-results Operation results: model-facing failures and notices

The model's runtime alert surface has two distinct kinds of information:

- **Turn failures are log items.** A failed action and an engine-rail failure are durable `log_entries` rows whose `rx` is an RFC 9457 operation result. They can be scoped-KILLed, retired, and budgeted like every other row. The `errors` section is a derived pointer index over recent `status_rx ≥ 400` rows; it owns no bodies or failure state. Rejected emissions never become accepted turn content; their private response and admission evidence remains in `model_calls` and `turn_attempts`, apart from the bounded recovery `emissionAttempt` under {§emission-admission}.
- **Notices are transient observations.** Progress and non-fatal diagnostics such as `turn_awaiting_model`, `search_progress`, and `output_unaccounted` may appear once in the packet and broadcast live. They neither substitute for a failure result nor influence scheduling or recovery.

The `log` is durable product truth. The `errors` section points at its failures
while the separate `notices` section displays transient observations. The two
retain distinct contracts and lifetimes.

- §operation-result-uniform-error-channel **One uniform error channel within an
  accepted turn.** Every operation or engine-rail failure — including
  max-commands and premature completion — is a `log_entries` row with
  `status_rx ≥ 400` and an RFC 9457 Problem Details operation result in `rx`.
  There is no per-category handling or bespoke ephemeral relationship. The
  `errors` section is a derived index over those rows from the current and
  immediately prior turn: one `{status, path}` JSON object per row,
  nothing else. The Problem lives on the curatable row and is READ via the path.
  Withheld output preserves its original result ({§context-fit});
  a packet past the window fails before inference ({§context-wall}).
- §log-row-self-explains **A log row self-explains: every ≥400 pointer names a record that states its why.** A model-operation failure is the model's own operation result; its
  Problem Details `instance` retains the originating occurrence URI; when absent,
  persistence assigns that row's `log:///` URI. Packet wire renders
  the contracts-owned compact `{§problem-projection}` on its meta line whether
  its body is visible or suppressed. The enclosing row owns status, model-facing path, source, and target;
  an identical extension is not repeated inside the projection. No
  separate item is minted for operation failures. Actionless engine rails mint
  `op='error'` items because no authored operation row exists. Invalid provider
  emissions are outside this channel because they are not turns. A bare
  failure status or mismatched result/problem
  statuses violate the producer contract and fail hard. Genuine
  engine-internal faults crash and never mint model-facing rows.
- **Asynchronous work does not weaken the contract.** A stream-producing operation returns its initial `102` after acquisition. At conclusion the subscription stores the exact universal terminal result; `stream/concluded` carries it unchanged; the next ambient terminal READ merges it with the stream payload and preserves its Problem instance, assigning the committed `log:///.../READ` URI only when absent. Timeouts and service cancellations replace the complete terminal result with a new valid 504/499 Problem—they never mutate a status while retaining a contradictory Problem.
- **Self-explaining rows.** A problem `title` names the stable class and `detail` states the occurrence-specific cause. Producer-known operands belong in factual extensions. `stage` appears only when neighboring stages imply different recovery; `recovery` states one generally valid next action; `retryable` is true only when the producer recommends automatically retrying the identical request. Unknown recovery or retryability is omitted rather than guessed. General workflow teaching stays in the packet rather than being duplicated into every failure. The runtime-neutral writing contract is owned by `@plurnk/plurnk-contracts`.
- **Exact Problems cross durable and external boundaries.** Scheme capabilities, proposal application, subscription conclusion, loop settlement, ACP, clients, digests, and benchmark records preserve the originating Problem object. The model packet alone derives `{§problem-projection}` without mutating that object. An adapter may add a missing durable `instance`, never replace an existing one; it must not rebuild failure truth from `status`, `detail`, a transport error envelope, or a scheduler projection. A failed boundary without a valid Problem is a contract violation and fails hard.
- **Caught diagnostics are bounded.** Core-owned Problems may include a bounded preview of a caught runtime diagnostic when it states the occurrence-specific cause. `PLURNK_SERVICE_ERROR_DETAIL_LIMIT` owns that model-facing character bound; complete errors remain in daemon diagnostics. Input validation and stable contract failures do not spend this allowance on implementation text.
- §notice-drain-on-read **Notices** - the few observations that are not log rows render one callout each under their distinct `## Notices` section ({§notice-callout}), never a JSON dump. Packet rendering normalizes whitespace, bounds the producer message with the shared preview limits, and appends any typed position. The notice buffer drains on read; event Notices appear on at most one packet. Parking preserves pending notices for that loop's next packet; another loop cannot consume them. Terminal cleanup, including cancellation while parked, discards undelivered notices. This buffer is process-local, not restart-persistent. Stateful derivation progress and provider availability coalesce in the buffer, so clients observe every checkpoint live while a later model packet receives only the current state under ordinary level filtering.
- §rail-accounting-private **Rail accounting is private.** Visibility is owned by {§engine-rails}: the model sees concrete failures from admitted turns, never rejected emissions, attempt counts, the strike streak, or cycle detection. Surfacing internal state creates a gamification surface where the model optimizes for engine metrics instead of the task.

**The error rows (one channel) + the only non-log notices:**

| failure | row | status |
|---|---|---|
| action failure | the failed op's own row; the owning scheme supplies Problem Details | 4xx/5xx |
| provider input capacity | `op='error'`, origin `_plurnk`, source `provider`; exact provider-owned `capacity-exceeded` Problem Details | 413 |
| max commands exceeded | `op='error'`, origin `_plurnk`, source `rail`; `engine/rail/max-commands-exceeded` Problem Details | 429 |

| notice `kind` | Source | Directive ({§notice-directive}) | Position |
|---|---|---|---|
| `output_unaccounted` | a provider whose billed output tokens exceed those its content and reasoning hold | none | content-offset at the end of the content |
| `parse_advisory` | grammar parser — recoverable near-miss which did not invalidate the parsed statements | YOU SHOULD write the canonical form. | content-offset into the model's emission |
| `search_progress` | repository materialization/indexing lifecycle ({§persistent-search-index}); structured phase, count, and percent; `level: info`, `warn` when a completed pass carries failed members ({§derivation-dedup-parallel}), `error` on terminal failure | none | none |
| `git_inspection_refused` | engine membership — automatic Git inspection refused a supplied repository whose config declares a `filter.*` program ({§membership}); names the key; `level: warn`, once per workspace until the key changes or clears | none | none |
| `continued_without_note` | engine turn — a continuing or parked model turn that admitted no NOTE ({§continued-without-note}); `level: warn` | YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn. | none |
| `outside_text` | engine turn — text the emission carried outside its operations, discarded ({§outside-text}); `level: warn` | YOU MUST NOT emit anything except whitespace between fenced operations. | none |
| `invalid_emission` | engine grammar — a response rejected before dispatch; `level: error` | YOU MUST ONLY emit fenced operation batches; with the parameters, pattern, and terse aside on the fenced operation line. | content-offset of the parser diagnostic, when it has one |
| `output_truncated` | engine capacity or turn — an emission cut at the output allowance ({§output-allowance-notice}); `level: error` when the cut response was rejected, otherwise `warn` | YOU SHOULD emit fewer or shorter operations per turn. | none |
| `provider_warning` | a provider warning: an SDK compatibility note, or native tool calls in a response that declared none; `level: warn` | YOU MUST NOT emit native tool calls. on the native tool calls; none on a compatibility note | none |
| `provider_retry` | a provider stream that failed after output began and was answered by a complete retry; `level: warn` | none | none |
| `provider_unavailable` | engine provider — a provider failure retried within its recovery budget | none | none |
| `path_normalized` | file scheme — a path resolved to its canonical spelling; `level: warn` | YOU SHOULD address the resolved path. | none |
| `member_added` | file scheme — an untracked file the model's READ or FIND reached was admitted as its own member definition ({§membership-auto-add}); `level: warn` | none | none |
| `read_fanout_bounded` | engine dispatcher — a READ whose glob matched more paths than its resource page selected; `level: warn` | YOU SHOULD narrow the glob, or FIND first. | none |
| `parse_issues_unavailable` | engine mimetype — parser recovery evidence unavailable for a mimetype; `level: warn` | none | none |
| `metadata_ignored` | engine dispatcher — `[metadata]` on an operation whose scheme takes none, run without it; `level: warn` | YOU SHOULD NOT write [metadata] on an operation that takes none. | none |
| `scope_normalized` | engine slicer — a scope normalized to its canonical form; `level: warn` | YOU SHOULD write the normalized scope. | none |
| `edit_merged` | engine slicer — an EDIT resolution rule applied to a batch ({§op-methods-op-dispatch}); `level: warn` | YOU SHOULD verify the merged EDIT before building on it. | none |

§continued-without-note **A continuing turn that carried no NOTE is told so, in the card's own words.** The card states its rule as one important callout, `YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn.`, and that command is the notice's directive. When a model turn settles at 102 or 202, so the loop continues past it or parks on it, and it admitted no NOTE in its program or from its reasoning ({§reasoning-operations}), the next packet carries one `engine:turn` notice, `continued_without_note`, `level: warn`, with that directive and the message `The turn continued without a NOTE.` It is a notice, never a failure: it mints no row, never counts toward the strike rail, and never ends or alters a loop. A turn that concludes its loop, an empty turn, which carries its own no-operation row, and every non-model turn take none.

§notice-callout **A notice speaks in the card's callout form.** Each renders as one alert callout, its level choosing the callout: `> [!CAUTION]` for `error`, `> [!WARNING]` for `warn`, and `> [!NOTE]` for `info`, which no model packet carries. Inside it stand the directive ({§notice-directive}), then the message, any typed position as `@ line:column`, and the kind in brackets; a blank line separates consecutive callouts:

```text
> [!WARNING]
> YOU SHOULD write the normalized scope. Scope <0,120> was normalized to <1,120>. [scope_normalized]
```

§notice-level **Severity on the wire (`level`, required).** Every `Notice` carries `level: "error" | "warn" | "info"`, set by the **producer** at the emit site. The level is client presentation, not operation status: even an `error` notice cannot terminalize work or substitute for a durable Problem. A forwarded `output_unaccounted` is `warn`; ordinary lifecycle and progress notices are `info`. Clients color straight off `level` without interpreting the open `kind` vocabulary.

§operation-result-no-error-scheme **There is no error scheme.** Private strike and cycle accounting stays engine-internal ({§rail-accounting-private}). Every failure within an accepted turn - a bounded parse error, failed action, or engine rail - is a LOG ITEM (`log:///<coord>`, `status_rx ≥ 400`) with Problem Details, independently curatable and exactly READable while active. The `errors` section surfaces a derived pointer to each. Rejected emissions stay in the forensic model-call and admission relations. There is **no bespoke `error://` scheme** and no ephemeral per-category failure buffer.

§notice-event-notify **Notices notify the client surface.** Engine Notices broadcast live via the `notice/event` notification — `{ sessionId, loopId, notice: { source, kind, level, message?, position?, …kind-specific } }` per the grammar's `Notice` schema — the moment they land. A loop Notice names its owning Session; workspace derivation progress alone carries `sessionId=null, loopId=0`. ACP projects the same observation as the custom `plurnk.notice` event. Failures do not broadcast on this surface: they are log rows, and the client reads them through `log.read` / the `log/entry` notification, the durable log.

§loop-status-notice **The loop status notice carries lifecycle and its observation deadline together.**
`notice/event` carries `{ sessionId, loopId, notice: { source: "engine:lifecycle", kind: "loop_status", level: "info", status, loopSeq, waitUntil, packetCount, claimedAt } }`:
with its status, every beat carries its loop's number (`loopSeq`, as `loop/terminated` carries it), packet
count and claim stamp (Unix milliseconds, `null` before the first claim), the ones a projection reads
({§application-loop-observation}), so a client updates the loop's identity, number, count and stamp together.

| Edge | `status` | `waitUntil` |
|---|---|---|
| Claimed to run | 102 | `null` |
| Parked | 202 | Persisted Unix-millisecond observation deadline, or `null` for an untimed park |
| Woken, awaiting dispatch | 100 | `null` |

Park observations and wakes use the session's existing drain serialization, so
an earlier park cannot overwrite a later wake's cleared countdown.
The beat is transient: broadcast to the workspace ({§notice-event-notify}), never
a log row or packet. Terminals remain `loop/terminated`'s. Reattachment obtains
the same deadline through {§application-loop-observation}, not a restarted clock.

§share **A share is the database's record, ready to send.** `plurnk-service share [<file.db>] [<folder>]`, and `npm run share` from a checkout, take a consistent copy of the database (`VACUUM INTO`; a live database is never read in place), and write its digest into `<folder>`, an ordinary folder the user archives or attaches however they like. Without a database the service's own is shared. Nothing is overwritten: a folder that exists and is not empty is refused, and a caller reusing a place removes it first. The share is the user's bug report and our dogfood, benchmark and forensics artifact alike.

§share-scope **A share is unredacted.** `--workspace=<id>` limits a share to one workspace; without it the whole database is shared. Nothing is filtered, redacted or scanned: a share holds what the models saw and wrote in scope, including prompts, file contents read, command output and reasoning, and the command says so. `--requiem` adds the forensic interview ({§digest-requiem}), which calls a model; `plurnk-service requiem <file.db> <folder>` adds it later to a digest already written.

§share-folder **Shares land in one place.** With no folder named, a share is a stamped child, `share-<UTC stamp>`, of `PLURNK_SERVICE_SHARE_FOLDER` (a leading `~/` expands, as for every explicit Plurnk path) or of `$XDG_STATE_HOME/plurnk/shares`.

§candidate-pinned-runtime **Candidate runtime stays pinned.** At launch, after its optional build, the candidate copies every workspace's package projection (`files`) into `<state>/runtime`, links third-party dependencies, and resolves `@plurnk/*` to those copies. Its daemon and its digest export both run from that copy, never the shared checkout, so neither source edits nor a concurrent candidate's or developer's rebuild after launch changes the code a run finishes on. The copy is removed once the digest is written.

§output-allowance-notice **The output allowance is not disclosed; a ceiling cut names its cause.** The packet's budget section carries the curation state and no response allowance: a model does not plan in tokens and no harness tells it its output ceiling, so the number is a fact without a use (#826). Overflow tolerance (#482) is likewise never advertised; a cut's notice names the true per-call grant from the response's own capacity record.

| On a provider finish of `length` | Rule |
| --- | --- |
| The notice | the engine emits an `output_truncated` notice (source `engine:capacity`) naming the allowance — the fact alone, never advice on what to do about it — on every path, railed or not |
| The rails | the verdict never blames the model for a cut the engine's own ceiling made: a cut turn is no repetition evidence ({§engine-rails}), and a strike threshold crossed on one names the allowance ({§engine-rails}) |
| A cut so deep no operation parses | the rejection notice names the truncation as the cause, not the parser's symptom, overriding {§emission-admission}'s parser diagnostic for `length` finishes |

§turn-lifecycle **Turn-lifecycle liveness.** Provider generation is the long, opaque window in a turn — one or more same-packet emission attempts may occur before the first committed op. A static client screen there is indistinguishable from a hang. The engine brackets the complete attempt window with two `notice/event` notices (`source: "engine:turn"`, `level: "info"`): `turn_awaiting_model` before the first call and `turn_generated` when an emission is accepted or the attempt budget is exhausted. The completion beat carries the spend ({§turn-accounting-notice}). Rejected content never rides the notice channel. Both are suppressed on an aborted loop and broadcast to the workspace like any notice ({§notice-event-notify}).

§turn-accounting-notice **The turn accounting notice: the completion beat carries the spend.** `turn_generated`
carries the turn's exact settled wire accounting — request count, exact nullable
USD and token totals with separately named known subtotals across every physical exchange the turn paid for, failed
calls included. It is the shared exact derivation from the ledger, never a second
stored fact, so a live watcher accrues running loop cost per turn (#465).

§notice-content-offset-pointer **Content-offset position.** A non-fatal diagnosis on an accepted emission (for example `output_unaccounted` or `parse_advisory`) carries `position: { type: "content-offset", line, column }` into the model's exact `ops://<session>/<loop>/<turn>` source; the optional emission-history section shows a canonical program ({§emission-history}), so the position names a line of the source, which READ of its address shows. A bounded hard parse error becomes a durable failed operation whose Problem Details preserve its line, column, source, and parser-owned diagnostic. Hard errors that make the frame untrustworthy remain only with their rejected forensic attempt.
Reasoning normalization notices use source `grammar:reasoning` and omit the
content-offset position: reasoning coordinates do not address the content source.

### Executable tool resources

§tools-resource-discovery **Executable capability discovery uses ordinary Plurnk resources.** No generated tool table rides the system packet. Every runtime enabled for the current session with an admitted invocation materializes one runtime document at `workspace:///_plurnk/plurnk/<runtime>.md`; nested paths beneath it do not contribute extra Turn0 rows. Tool-result/output schemas remain ordinary evidence, not teaching. Unknown-target recovery names the published runtime document through the same path owner as materialization, including a runtime's declared `resourcesPath`.

| Document | Contents |
| --- | --- |
| A general runtime's | its {§executor-tool-document} |
| A runtime's with an exact {§executor-tool-registry} | a compact catalog at the same address |
| Every runtime document | summarizes the server or runtime and lists every enabled target as a directly copyable executable fence named for the runtime, with its input preview ({§operation-aside} carries the target one-liner; no invocation dispatch would reject is ever advertised) |
| `<runtime>/<percent-encoded-target>.md` beneath the same root | linked from that aside by a schema-backed target: the full tool description and raw input schema under {§executor-input-schema-preview}; a schema-backed general runtime uses `<runtime>/input.md`; non-schema targets retain supplemental details after the framework-owned sections |

```mermaid
flowchart LR
    Survey["Turn 0 FIND<br/>tools/*.md"] --> Runtimes["runtime paths + summaries"]
    Runtimes --> Read["READ selected runtime<br/>only when needed"]
    Read --> Exec["execution with an aside"]
    Read --> Schema["READ linked input schema<br/>when the preview is insufficient"]
    Schema --> Exec
```

§tools-resource-materialization **Tool resources materialize from one workspace snapshot.** The runtime registry, workspace capability policy, tool resources, and dispatch use one effective workspace snapshot; attached tools are capabilities like every other runtime, and the model never learns an origin.

- A disabled, unavailable, detached, replaced, or removed runtime has no tool resource; an exact registry's empty set publishes no runtime and admits no invocation. Reconciliation deletes stale documents before upserting the current set. `PLURNK_SERVICE_DOCS_EXCLUDE` does not hide an enabled executable; executor enablement is the sole user-configured filter shared by discovery and dispatch.
- A runtime declaration may carry `resourcesPath`, its generated-doc root relative to the workspace's generated subtree ({§session-scheme}). Absent, its docs live in the internal `_plurnk/plurnk` namespace; present (`plurnk` and attached MCP servers: `/tools`), the runtime document materializes at `_plurnk` + that root in the shared scratch.
- Turn 0 surveys the runtimes (`FIND (workspace:///_plurnk/tools/*.md)`, one row per runtime carrying its summary) and, for each runtime with `expandTools` (`plurnk` by default, plus each MCP server named in `PLURNK_MCP_EXPANDED`), adds one FIND over its runtime document matching the complete executable blocks (`FIND (workspace:///_plurnk/tools/<runtime>.md)` with a multiline regex over matching fences), so turn 0 names every tool with its aside and signature — one row per tool, paged like every survey. Capability attenuation restricts that matcher to the admitted exact tools. No document is delivered unasked.
- When the registry supplies {§executor-tool-catalog} definitions, the runtime document links to its sibling `<runtime>.json`. The catalog contains exactly the effective tools and is an ordinary `application/json` resource for READ, FIND, and JSONPath selection. It follows the same reconciliation as the runtime document and per-tool schemas; neither the catalog nor its definitions are automatically included in turn 0 or expanded-tool surveys.

§tool-document-header-only **A header-only tool document:** a registry-less runtime whose declaration carries no
supplemental details (no `docs/<tag>.md`, no inline `details`) is a
header-only document: its summary aside ends with `(invocation only)`, so
the catalog row that advertises it says so and the model is not invited to
READ an empty room. Every runtime and family plurnk ships carries a body.

§tools-summary-invocation A summary featuring one exact enabled tool invocation
includes its compact input signature after literal `\n` when no example body is
already present. Required schema fields use {§executor-input-schema-preview};
authored examples take precedence. Family alternatives and descriptive summaries
remain one compact orientation line, not an expansion of every tool's signature.

§members-functionality **File membership is one workspace Functionality family.** Core registers the `members` family with the coordinator ({§functionality-coordinator}): the model, the client, and the operator learn one surface — `list | discover | add | enable | disable | remove`, `workspace.members.<verb>` for the client, ```` ```plurnk (members) ```` for the model — for what the model may see, exactly as they do for skills and MCP servers. A definition is one shell-path glob ({§find}) relative to the project root, or absolute: it is matched against member keys, so its spelling is canonicalized as a path's is ({§fs-namespace}) and an absolute glob admits exactly what its root-relative spelling does; a leading `!` excludes matching members, and an exclusion wins over every inclusion. The glob is the definition's identity ({§functionality-replacement}). Admission provenance (`service-configuration`, `client-action`, `model-proposal`) rides the persisted definition, `{ glob, provenance }`, to enforce {§members-model-scope}; configuration-source provenance belongs to the shared inspection projection ({§configuration-repair-path}).

| Verb | Input | Effect |
| --- | --- | --- |
| `add` | `{"files": ["<glob>", …]}` | admits each glob, trimmed, as one definition, a glob named twice being one; a bare `!` is 400 `definition-invalid` |
| `enable`, `disable`, `remove` | `{"file": "<glob>"}`, the glob as `list` shows it | the definition's state |
| `list` | — | each definition with what it resolved to — `include` or `exclude`, the pattern, the members it admits or removes (count and a bounded sample), and for a model's inclusion the matches the repository's ignore rules refused — so the model sees what its glob did and adapts |
| `discover` | `query`, a path or a glob | introspection, never a catalog: a path answers why it is or is not visible (tracked, included by which pattern, a creation record, excluded by which `!glob`, ignored, untracked, absent); a glob previews what `add` would include or exclude; a query that names neither, blank or a bare `!`, is 400 `query-invalid`; names only, never content, and nothing is added |

§members-configuration *Available definitions.* `PLURNK_MEMBERS_<alias>=<glob>`
declares one service-origin rule (`!glob` excludes), named by its glob like every definition; the
key is its configuration provenance, which `list` shows, and two keys declaring one glob fail by
name. The shared naming and
enabledness dialect is {§resource-environment}; `PLURNK_MEMBERS_ENABLED` supplies
the panel default and `PLURNK_MEMBERS_<alias>_ENABLED` overrides one rule.
An empty glob or a bare `!` fails validation. Controls may precede their rule;
they are validated without creating a definition ({§resource-environment}).

§members-model-scope *The model's authority.* A model's `add` is admitted against
`PLURNK_SERVICE_MEMBERS_MODEL_SCOPE` in the file-creation lattice `none < root <
namespace`, narrowed by `settings.membersModelScope` (most restrictive wins). `none`
refuses every model definition — inclusion or exclusion — as `403
members/functionality/model-scope`, whose recovery is the one path that remains, a client or
operator definition, the user's to give; `root` admits patterns inside the root, however spelled; `namespace` admits `../` too.
`auto` loops self-approve proposals, so the ceiling — not the proposal — is the guard
({§membership}). The coordinator hands `admit` the caller (`action` | `operation`)
so the family bounds the model without a second grammar; an admission a read earns
({§membership-auto-add}) is that same `operation` add and meets the same ceiling.

§members-projection **The members projection is one overlay of the workspace's enabled definitions.** Definitions are desired state per workspace ({§functionality-coordinator}); the workspace overlay (`workspace_constraints`) combines its enabled definitions: inclusions union and an exclusion wins. There is no other membership path: the client's `/members` verbs are these verbs.

| Fact | Rule |
| --- | --- |
| Sessions | session creation copies no membership state; accepted changes reach every session |
| Source | human-authored definitions project with source `members`, model-proposed ones with source `model`; the same pattern from both keeps `members`; a `model` inclusion is a pattern scan like a human one but never admits a path the repository ignores ({§membership}) |
| Creation records | the engine's (`source: "create"`, {§fs-write-surface}) are not definitions: the projection never overwrites or retires them |
| When | at the family's publication commit, re-resolving membership; workspace cooling changes nothing, because desired state is durable |
| Documents | each enabled definition is one generated document at `workspace:///_plurnk/members/<glob>.md` ({§functionality-model-projection}), the glob percent-encoded as one path segment (RFC 3986 unreserved characters and parentheses stay literal) — its glob, origin, provenance, and what it resolved to — surveyed at turn 0 like every family's enabled definitions ({§session-initialization-entry}), so the model sees why a file is or is not a member before it asks |

The skills module owns the Agent Skills family ({§skills-functionality}) and its resource trees
({§skills-resources}); core supplies the Plurnk reference through {§provided-skills-module-slice}.

§plurnk-skill **Plurnk's own reference is an ordinary service-provided skill.** `skill://plurnk/SKILL.md` is the standard frontmatter entry point, catalogued with other enabled skills. No chapter, contract or defaults body is injected merely because the skill is enabled. Disable/enable, shared workspace visibility, and project/global shadowing use the ordinary Skills lifecycle; service-provided skills are host-provided trees, never fetched, and removal follows {§skills-remove}.

| It links | Where from |
| --- | --- |
| Package-owned configuration, model, COPY/MOVE and extensibility chapters | native chapter files, which retain their owners and locations |
| The complete `.env.defaults` aggregate at `skill://plurnk/.env.defaults` | the same {§operator-config-precedence} renderer as the operator command, never the effective environment; runtime-generated bytes have no invented disk location |
| The installed contracts at `skill://plurnk/packages/<package name>/SPEC.md` | the service's own `SPEC.md` and each installed ecosystem package's that ships one, the same membership as the defaults aggregate, with that package's published type declarations beside it at `packages/<package name>/dist/**/*.d.ts`; the service's declarations are its internals and are not served; contracts are listed when the tree is listed and read where each package installed them, never through a symbolic link |
| The Session's existing tool/resource references | their own owners |

The catalog and Turn0 describe Functionality under the current workspace
capability policy and service ceiling. A direct denied attempt receives the
same exact 403 from dispatch rather than a second documentation policy.
Optional non-execution operations remain a separate `## Enabled Optional Operations`
section because they are language extensions rather than executable tools.

### Scheme-reference discovery

§schemes-directory Scheme references are ordinary workspace entries at `workspace:///_plurnk/plurnk/<scheme>.md`. Turn0's FIND survey projects their summaries ({§session-initialization-entry}); the model READs details on demand. No Resources section or separate example catalog is injected into the system packet.

| Reference decision | Owning rule |
|---|---|
| Registered and model-visible scheme | Its reference is eligible when at least one supported resource capability is admitted by the effective policy ({§capability-admission}). Illustrative operations never determine admission. |
| Runtime output scheme | Its runtime's reference owns discovery; no duplicate scheme reference. |
| Family manager and its generated documents | Eligible while the family's manager runtime is admitted by the effective policy ({§capability-admission}), by name or by trait: a denied family has no page, no generated document and no runnable verb, so a masked family never stands in the survey empty (#842). |
| Excluded scheme | `PLURNK_SERVICE_DOCS_EXCLUDE` omits its reference, not its functionality. |
| Reference content | Required meta-owned content follows {§teaching-corpus}; other schemes may supply optional `manifest.documentation`. Absent optional content contributes nothing; a failed required source read surfaces its cause. |
| Policy layers | Materialization, Turn0, and direct operations use the same current workspace policy and service ceiling. |

### §inject system.inject — the operator injection

§packet-inject When `PLURNK_SERVICE_PACKET_INJECT` names a readable markdown file, its content renders as an `## Operator Notes` section in the system slot (definition → policy → inject). Read per-turn so the operator's edits take effect live; a set-but-unreadable path fails the turn hard as {§policy-sections} rules. `~/` expands to home. It's the operator-side complement to the extension packet transform — a pressure valve so reshaping the packet edits operator content, never the core. Unset → no section.

§card-read-per-wake **The card is read from disk at every loop start and wake, never held.** `plurnk-contracts/plurnk.md` is read when a loop runs, is injected, is woken by a completion or a reply, or is recovered at daemon start; the daemon keeps no copy between those reads, so an edit to the card reaches the next loop or wake without a restart.

### §policy system.policy — the client's policy injection

§policy-sections One section rides the system slot **after the definition**: the contents of `PLURNK_SERVICE_POLICY` (unset resolves to the policy member in {§host-path-layout}), with no engine-generated heading. The policy document owns its Markdown structure. Policy is the client's authoritative rules promoted into the privileged zone — NOT a log entry; the model cannot READ or KILL it. A default-absent path is silent (the section is omitted); an explicit override (env set) that fails to read fails the turn hard — a deliberate setting with a broken path is a misconfig, surfaced not hidden. Read per-turn so edits take effect live. The PROJECT `AGENTS.md` is local guidance, not policy: it rides turn 0 as the foisted `workspace:///_plurnk/AGENTS.md` entry ({§session-initialization-entry}); references and skills use native discovery ({§skills-functionality}).

On first run, and only when `$XDG_CONFIG_HOME/plurnk` itself is absent, the service seeds
`AGENTS.md` from `@plurnk/plurnk-meta/POLICY.md` ({§teaching-corpus}).
It reads that required source before creating the service home; a failed read
surfaces with its cause and leaves no apparently initialized home.
After that bootstrap the file is user-owned: edits and deletion persist, and a
later boot never refreshes or recreates it.

§schemes-self-doc-materialization **Self-documentation materializes one generated reference tree per workspace.** `@plurnk/plurnk-schemes` owns `SchemeManifest.documentation` ({§manifest-self-doc}). Each reference carries an H2 `Summary` for ordinary catalog projection. `SchemeRegistry.docs(workspaceId)` resolves corpus-or-manifest documentation, and `referenceEntries` applies workspace capabilities to that source. One workspace materializer deletes vanished contributions and upserts current documents. Concurrent readers share the same reconciliation and outcome; independent workspaces do not serialize together. Ordinary runtime turns maintain {§session-scheme}, including under read-only workspace policy.

### §packet-git-status The Git status section — compact repository state

When Git is admitted for the workspace, `## Git Status` contains a Markdown `> [!NOTE]` block. The section never contradicts the catalog: an untracked file a definition admits is named as the member it is. The section never carries an unbounded path list.

| Fact | Rule |
| --- | --- |
| The quoted lines | the current branch, upstream ahead/behind counts, and staged/unstaged/untracked totals, then one bounded line per non-empty class (at most `PLURNK_SERVICE_GIT_STATUS_PATHS` paths, `+K more`): staged, unstaged, `untracked members` — each path with the inclusion pattern that admits it or `created` for a creation record — and `untracked (not members)`, named because such a file is not a member ({§membership}) and a human must `git add` it or add a members definition before the model can read it |
| Per-path state | belongs to the runtime actor's durable causal evidence: its `source=file` row carries the exact two-character porcelain `XY` value as `git` metadata when the status snapshot names that path |
| The snapshot | the engine takes one after membership reconciliation and uses it for both projections; no per-file Git process exists |
| Porcelain v2 NUL-delimited records | supply these facts: an unborn branch retains its actual name with `no commits`; detached HEAD is identified as detached, never as a branch named `HEAD`; pathnames and rename sources retain their exact bytes; the internal two-character status uses spaces for unchanged coordinates |

### §recap Optional Recap footer

The user slot may end with `## Recap`, a compact recency-biased reminder of
selected operational law already owned by `plurnk.md`. A non-empty `runLoop` /
`runTurn` `recap` value overrides the default; otherwise core reads
`PLURNK_SERVICE_RECAP` or the required meta-owned `recap.md` source for every
packet. Empty content intentionally omits the rendered section while retaining
one dormant authored source. A failed read fails packet assembly with its cause.
The footer is one projection path and one authored source, not a second language
contract.

§recap-lines The operator's recap lines lead the footer: every non-empty
`PLURNK_SERVICE_RECAP_LINE_<alias>`, in alias order, renders as one callout ahead of the recap
source, `> [!IMPORTANT]` for a `YOU MUST` line and `> [!TIP]` for `YOU SHOULD` and `YOU MAY`. A line
that does not open with `YOU MUST`, `YOU MUST NOT`, `YOU MUST ONLY`, `YOU SHOULD`, `YOU SHOULD NOT` or
`YOU MAY` is a configuration error naming its key, and an empty value turns a shipped line off. The
shipped `recap.md` stays empty: it is the extension contract's source, not a home for core's lines.

## Matcher selection and text regions

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§matcher-dispatch} | Matcher dispatch |
| {§relation-indexed-dialects} | `~full-text` and `&graph` are indexed relation dialects and never route through the content matcher. |
| {§graph-relations} | Graph matching is one-hop, kind-agnostic name matching. |
| {§matcher-invalid-expression} | A malformed matcher Problem identifies the dialect and includes the bounded native parser cause as… |
| {§matcher-dispatch-203-soft-fallback} | On parse failure, 203 returns raw content as the text primitive with `reason` so the model can use ordinary… |
| {§derivation-in-flight} | In-flight derivation and query are live uses. |
| {§matcher-selection-signal} | The matcher selection signal: matching carries navigation evidence |
| {§matcher-index-readiness} | Indexed patterns require complete evidence. |
| {§matcher-result-resource-selection} | A matcher selects resources; it never extracts a value or chooses a retrieval window. |
| {§text-scope-runtime} | Text-scope runtime projection |
| {§zero-width-column-one-insert} | An authored zero-width column-1 scope inserts whole lines. |
| {§slice-semantics-compose-pattern} | A composed pattern is one selection, independent of operation. |
| {§ext-mimetype} | Path-extension declares mimetype |
| {§ext-mimetype-extension-mimetype} | A channel's mimetype by extension: |
| {§render-rule-line-navigable-prefix} | Every textual content body with a source `startLine` renders with a coordinate prefix on each physical line,… |
| {§render-rule-find-renders-result} | A log row's canonical full body is resolved once by `LogBody`: READ/FIND, actionless source artifacts,… |
| {§markdown-primitive} | Mimetype primitive: text/markdown |
| {§markdown-primitive-text-markdown-normalize} | Any scoped text projection -> `text/markdown` |
| {§op-invariants} | Op-level invariants and resolved ambiguities |
| {§copy-l-source-range} | COPY/MOVE source scope |
| {§kill-scope-entry} | Scoped KILL on an entry |
| {§kill-pattern} | A pattern on a textual entry KILL removes exactly its matches. |
<!-- /map -->

Matchers select resources and report evidence; text scopes independently
address the exact readable text, regardless of mimetype. Syntax belongs to
{§naked-pattern}, {§matcher-prefix-claims}, and {§scope-slot}.

### §matcher-dispatch Matcher dispatch

One parsed content matcher crosses three ownership layers:

| Layer                            | Responsibility                                                                                                          |
|----------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| `@plurnk/plurnk-mimetypes`       | Resolve the handler and execute glob, regex, JSONPath, or XPath with honest evidence.                                   |
| `@plurnk/plurnk-schemes/Matcher` | Map framework results and typed failures to the universal scheme-result contract.                                       |
| Core `Matcher.matchCandidates`   | Apply that operation adapter across caller-supplied `{key, content, mimetype}` candidates and preserve source identity. |

§relation-indexed-dialects `~full-text` and `&graph` are indexed relation dialects and never route through
the content matcher. Language admission accepts exactly one graph symbol (`&sym`, `&<sym`, `&>sym`);
runtime validation is only a defensive boundary for typed callers. When the candidates' persistent index is still
deriving, the engine settles the workspace's derivations once and re-runs the selection; a still-incomplete
index is a 503 that is retryable — never a refusal to wait paired with an instruction to wait. Candidate composition has no dependency on the table that
stored a resource.

§graph-relations **Graph matching is one-hop, kind-agnostic name matching.**
Source definitions resolve over the complete relationship universe (the
workspace for entry FIND; the session's complete log for log FIND), while the
authored target still constrains every resource returned. Outgoing
references belong to a definition through the handler-reported fully qualified
container identity.

| Matcher      | Selected resources                                                               | Match evidence                                                            |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `&<symbol`   | In-scope resources that reference `symbol`                                       | Each matching reference's source span                                     |
| `&>symbol`   | In-scope resources defining names referenced by each definition of `symbol`      | Each referenced symbol's definition span                                  |
| `&symbol`    | In-scope resources defining `symbol` | Each definition's source span |

Graph storage preserves the handler's complete text coordinates, including
reference columns and end positions. Match evidence and source text come from
the same immutable derivation. A definition without handler-supplied columns
selects its declared whole-line extent; a reference always retains its exact
region. Matches are deduplicated by resource and complete region, not line.
READ presents whole lines with that evidence ({§read}); EDIT
replaces the selected region literally, not a semantic rename of the symbol.
Upgrades invalidate obsolete derived indexes, never their source content or
retained history ({§db-migrations}).

| Result | HTTP status |
|---|---|
| Match array | 200 |
| Empty match array | 204 |
| Malformed matcher expression | 400 |
| Source unparseable for its mimetype | 203 (soft fallback: raw content as text with `reason`) |
| Dialect unsupported by the resource | 415 |

§matcher-invalid-expression A malformed matcher Problem identifies the dialect
and includes the bounded native parser cause as `diagnostic` when available. Core applies
`PLURNK_SERVICE_ERROR_DETAIL_LIMIT` before the cause crosses into the schemes
adapter; the Problem offers only the deterministic recovery to revise the
expression, never a guess about the intended pattern.

§matcher-dispatch-203-soft-fallback On parse failure, 203 returns raw content as the text primitive with `reason`
so the model can use ordinary text retrieval or repair the source.

`Matcher.matchCandidates` searches heterogeneous resource sets. A candidate
whose handler returns 415 is omitted when another candidate supports the
dialect; if every candidate is unsupported, the first exact 415 Problem is the
operation result. This preserves exact-resource diagnostics without allowing
one binary marker to fail a repository-wide text search.

Glob anchoring (`TODO*` starts-with, `*TODO*` contains, `*.log` ends-with,
`[Tt]odo*` character class) lives in the mimetypes framework.

§derivation-in-flight **In-flight derivation and query are live uses.** An exact
indexed operation holds its content-addressed artifact from derivation through
the completed query. Producers hold artifacts while building and attaching
them. Derivation and content collection share one per-database exclusion boundary:
parallel uses remain parallel, a collection pass skips these two collectors
while a use is active, and a new use waits for an already-running collection.
Successful, failed, and cancelled uses release in `finally`; no durable pin or
additional retention setting is introduced. The ordinary later pass or drained
shutdown collects unattached artifacts under {§content-store}.

### Matcher selection and evidence

- §matcher-selection-signal **The matcher selection signal: matching carries navigation evidence** - each selected resource carries `matches: MatchEvidence[]`, where `MatchEvidence` is `{channel?,locator?,region?,enclosingRegion?}`. `channel` identifies the entry channel and is absent for channel-less resources such as log rows ({§channel-selection}); `locator` preserves the structural address. `region` is the exact selection; `enclosingRegion` is presentation context only. Both use complete four-coordinate `TextRegion`s in the readable source. Exact duplicate evidence deduplicates. FIND projects this evidence as resource rows or flat locations ({§find-result-projection}); consumers never invent missing precision. An operation requiring exact source fragments refuses a selection containing unlocated or enclosing-only findings with 422 `pattern-source-unlocated`, before any mutation.

§matcher-index-readiness **Indexed patterns require complete evidence.** A held
resource snapshot whose search derivation is excluded or failed answers 422
`search-unavailable`, preserving the reason. Graph selection requiring an
unsettled relationship universe answers retryable 503 `search-index-incomplete`.
Neither condition is a successful empty match.

§matcher-result-resource-selection **A matcher selects resources; it never extracts a value or chooses a retrieval
window.** Every dialect answers whether a resource matches and may return
`MatchEvidence { locator?, region?, enclosingRegion? }` ({§matcher-selection-signal}).
`locator` is a canonical structural locator. `region` is an exact selected
`TextRegion`; `enclosingRegion` identifies presentation context, not a selection.
Both address the physical text the model can READ. A matcher miss is 204. FIND's target shape projects the selected
resources according to {§find-result-projection}.

| Dialect | Selects | Natural use |
|---|---|---|
| regex `/pat/` | resources whose readable text matches | exact text region, or the smallest enclosing region when a match bisects an indivisible text unit |
| glob `pat` | resources with matching readable lines | exact text region |
| jsonpath `$.path` | resources whose deep JSON resolves the path | canonical locator plus exact/enclosing text region when honest |
| xpath `//sel` | resources whose deep XML resolves the selector | canonical locator plus exact/enclosing text region when honest |
| `~` full-text `~q` | resources ranked by FTS5 BM25 | matched text regions |
| `&`graph `&<sym` | resources with matching symbol relations | symbol text region when available |

Match evidence is navigation evidence, never an implicit body projection. The
model uses broad FIND to select and page resources, exact FIND to page that
resource's locations, then explicit exact READs—parallel in one turn when
useful—to retrieve chosen bodies or regions. A locator-only or coordinate-less
valid result still selects the resource; the service never fabricates
coordinates. {§read-exact-target} {§read}

### §text-scope-runtime Text-scope runtime projection

Core realizes the authored scope contract ({§text-scope-semantics}) as the
contracts-owned `TextRegion` wire shape ({§text-region}). All textual
READ/EDIT/COPY/MOVE scopes use the same physical text:

| Scope           | Retrieval                  | Mutation                                     |
|-----------------|----------------------------|----------------------------------------------|
| `<N>`           | whole line `N`             | replace/delete whole line `N`                |
| `<N,M>`         | inclusive whole lines      | replace/delete inclusive whole lines         |
| `<SL,SC,EL,EC>` | exact exclusive-end region | delete that region, then insert at its start |
| `<0>` / `<-1>`  | empty selection            | prepend / append anchor                      |

One/two-coordinate line shorthand is newline-aware so deleting a line does not
leave an empty line. A terminal position after a final newline is an exact
insertion anchor, not an additional whole line. `<1,-1>` selects all content.

§zero-width-column-one-insert **An authored zero-width column-1 scope inserts whole lines.** Core prepares that fenced EDIT body once, using `wholeLineBody`, before handing literal replacements to the scheme; mutation, receipt, and anchor-continuity calculation all consume that same prepared body.

| Scope | Effect |
| --- | --- |
| `<L,1,L,1>`, an anchored `<@hash,1,@hash,1>`, or `L` = final line + 1 when the content ends with a newline | a non-empty body that does not end in a newline is inserted with the content's line separator appended, so `X` at `<2,1,2,1>` into `a\nb` yields `a\nX\nb`; an empty body inserts nothing |
| A zero-width region at any other column | a byte-exact insert with nothing appended |
| A pattern's generated coordinates | exact matches, not authored line-insertion syntax: `/^/` inserts a literal prefix without adding a newline |
| COPY and MOVE | transfer source bytes and are likewise untouched |
| An authored three-coordinate `<startLine,startColumn,endLine>` scope | tolerated: immediately lowered to the complete four-coordinate region ending after the final code point of `endLine`, that exact normalization reported only in a use-triggered Notice; not canonical producer syntax |
| Other negative values, decimal text coordinates, inverted regions, out-of-range coordinates, and other arities | 416 |

Every successful scoped READ carries its complete resolved `region` in the
operation result and packet metadata. The body remains coordinate-prefixed from
`startLine`; the region preserves columns that line numbering cannot express.

Every same-resource mutation resolves its replacement offsets against one
unmodified snapshot. Disjoint replacements apply from the highest source offset
down; overlaps and duplicate insertion boundaries are 409. This is the adopted
SARIF region/replacement algebra for exact spans and same-snapshot ordering, not
adoption of the SARIF interchange envelope.

§slice-semantics-compose-pattern **A composed pattern is one selection, independent of operation.**
A pattern runs over the canonical source channel, never a READ receipt's
line-ending normalization, preview, coordinate prefixes, or other presentation.
A match region uses the four-coordinate source scope. FIND reports it, READ
shows its lines with that evidence, EDIT replaces it, COPY transfers it, MOVE
transfers then removes it, and a textual KILL removes it. Enclosing display
context never enlarges the selected span. Multiple fragments retain source
order and literal text; COPY/MOVE insert no separators between them. Scope
composition admits complete matches, never clipped fragments or other matches
on the same line. Mutation batches retain {§op-methods-op-dispatch} and collision
handling; a pattern does not create another overlap-recovery algorithm.

FIND retains locators even without source coordinates. READ may display
`enclosingRegion` as context, but a selected value with neither kind of location
returns `422 pattern-source-unlocated`. EDIT, COPY, MOVE,
and textual KILL require exact `region` evidence for every selected match;
enclosing or unlocated values return that same Problem without changing any
source or destination. Absence of matches remains an ordinary empty selection.

A follow-up ```` ```READ (resource) <SL,SC,EL,EC> ```` retrieves the exact
region. JSONPath/XPath remain locators and matchers, not a structural update
language: `//item` selects the element, `//item/text()` its direct text nodes,
and `$.host` the JSON value including its lexical quotes/escapes, never the
property name or colon. Literal replacement does not serialize a value or
repair neighboring punctuation. Readable projections have their own coordinates.

### §ext-mimetype Path-extension declares mimetype

`PathMimetype.resolve` (exported from `@plurnk/plurnk-schemes`): pathname extension → `Mimetypes.detect({ ext })` (with `text/plain` normalized to `text/markdown` per {§markdown-primitive}); an unrecognized or absent extension uses the caller's supplied type. Text EDIT creation supplies the scheme's declared channel type or the Markdown primitive for a dynamically typed channel. Transfers follow {§copy}.

- `workspace:///users.json` → `application/json` (extension wins)
- `workspace:///notes.md` → `text/markdown` (extension; matches default)
- `workspace:///config.yaml` → `application/yaml`
- Text EDIT of `workspace:///users` (no suffix) → `text/markdown` (text primitive)

§ext-mimetype-extension-mimetype **A channel's mimetype by extension:** the same rule applies to every entry-bearing scheme when
creating a channel without a per-call type declaration. EDIT and COPY/MOVE into
an existing channel retain its stored type. Effective mimetype is stored in
`entry_channels.mimetype` and drives matcher, projection, and binary handling.
Text scope meaning does not vary by mimetype.

### Render rule

§render-rule-line-navigable-prefix Every textual content body with a source
`startLine` renders with a coordinate prefix on each physical line, independent
of mimetype. A successful exact READ whose active scheme declares
`lineAnchors: true`, or `textEditScopes: true` with addressed-resource model write authority
under {§line-anchors}, supplies `@hash N:` with one
or more ASCII spaces before `N` under
{§line-anchors}; generated FIND rows render a result ordinal left-padded to the
complete result total's width; every other body renders `N:` left-padded to its own largest line number's width, so every body keeps one stable content column. JSON, XML, and HTML are therefore just as
line-addressable as markdown and source code. The prefix is a packet
presentation aid, never part of canonical content; matchers and mutations
consume canonical bytes before rendering. A producer may set `startLine: null`
only when its content is already source-numbered, such as an effect receipt.

§render-rule-find-renders-result A log row's canonical full body is resolved once by `LogBody`: READ/FIND, actionless source artifacts, prompt, and extension result content comes from `rx.content`; EDIT and scoped entry KILL use their structured receipt, while environment-delta EDIT uses its resulting span; COPY/MOVE concatenate the textual receipt contexts in their ordered `effects`; NOTE and lifecycle operations retain their literal `text/plain` bodies; executions and SEND/WORK/FORK use their statement body. Whole-channel COPY/MOVE effects are bodyless rather than fabricating a text projection. Packet rendering applies {§body-projection} and the coordinate projection in {§render-rule-line-navigable-prefix}. READ/FIND over `log:///` and search use the same body with deliberate trims applied under {§log-kill-scope}, without packet-only suppression or preview limits. Status and content are orthogonal: a failed terminal stream READ retains its Problem Details and failure status while rendering captured diagnostic output; failure never erases evidence.

An EDIT or scoped entry KILL log row renders its bounded effect receipt (`rx.receipt`) as row
metadata and join context, not its input statement. Proposal-gated file EDITs
compute the accepted receipt from what actually lands. Environment-delta EDITs
render their resulting `rx.span`. COPY/MOVE rows write both operand
selections ({§log-wire-format}), render compact ordered `effects` metadata, and
any scoped textual receipt contexts under their `log:///` address, never under
one operand's resource address. All generated bodies remain under
{§body-projection}. {§edit-result-receipt-projection}

Numeric and anchored coordinate prefixes are presentation/reference per
plurnk.md ("not part of the source"); matchers operate on canonical content.

### §markdown-primitive Mimetype primitive: text/markdown

Auto-derived text mimetypes anywhere in plurnk-service normalize to `text/markdown`:

- §markdown-primitive-text-markdown-normalize Any scoped text projection -> `text/markdown`
- File scheme extension fallback → `text/markdown`
- `Mimetypes.detect()` returning `text/plain` → normalized via `normalizeAutoTextMimetype`

`text/plain` survives only where a scheme explicitly declares it (exec stdout/stderr — subprocess byte-streams aren't markdown). The model never auto-encounters `text/plain` from defaults.

### §op-invariants Op-level invariants and resolved ambiguities

Carried from the contract walk; durable.

- **Dialect/mimetype mismatch** → 415 (xpath on text/plain → 415; jsonpath on JSON-shapeless mimetypes → 204 because outline is empty, not 415).
- **Binary coordinates** are numeric byte positions for READ and transfer; text EDIT does not author native bytes ({§binary-parity}). Readable projections retain their own textual coordinates ({§derivation-dedup-parallel}).
- **EDIT `<L>` on non-existent entry** → body becomes content; `<L>` is positional-only on existing content.
- §copy-l-source-range **COPY/MOVE source scope** selects only the addressed source channel and
  first resolves and, when required, prepares the same canonical
  owner-addressed representation as exact READ/FIND. It transfers canonical
  text without the packet's coordinate prefix; log sources omit deliberate
  trimming under {§log-kill-scope}. A MOVE removes
  that same selected region; an unscoped MOVE removes only the selected
  channel, deleting the entry only when no channels remain. Binary sources
  transfer bytes under {§binary-parity}. A selected producer failure aborts before destination mutation;
  successful non-`200` content remains transferable.

- **COPY/MOVE destination scope** is independent of the source scope and lowers
  through the destination scheme's `editBatch`.
- **COPY/MOVE result effects** are engine-owned and describe only mutations that
  landed. COPY orders destination only; MOVE orders destination then source.
  Any scoped textual transfer materializes create/update receipts; whole-channel
  changes do not. Operand selections remain independently visible per
  {§copy-move-observation}.
- **READ rx** prefixes every textual line under {§render-rule-line-navigable-prefix}; eligible
  editable resources carry `@hash N:`, and all others carry `N:`.
- **Pattern selection** applies to the addressed source channel under {§slice-semantics-compose-pattern}. The path and channel select resources; FIND reports matches and READ displays their lines. EDIT, textual KILL, COPY, and MOVE act on exact selected spans, not their enclosing lines ({§read}, {§edit-pattern}, {§kill-pattern}, {§copy}).
- **Scoped KILL** on the **log** (`log:///`) removes a body span from its readable projection ({§log-kill-scope}); on an entry it deletes that span through the EDIT path ({§kill-scope-entry}). A whole-entry KILL deletes the entry, or one `#fragment` channel.
- **File scheme** detects with `Mimetypes.detect({ path })` and classifies with the same configured service ({§mimetype}). Handler-declared binary sources materialize through {§derivation-dedup-parallel}; projected bodies are READ-able, while source-aware EDIT remains 415.

### §kill-scope-entry Scoped KILL on an entry

A KILL with a text-coordinate scope aimed at an entry-bearing scheme deletes exactly that span: core prepares and dispatches it as an EDIT with an empty body over the same marker, so anchors resolve, proposals gate it, and the merge facts and receipt are the EDIT path's — while the log row records the model's KILL. Its packet metadata and canonical log body use {§edit-result-receipt-projection}. ```` ```EDIT (path) <scope> ```` with an empty body remains the same act spelled the other way; the teaching names KILL.

§kill-pattern **A pattern on a textual entry KILL removes exactly its matches.**
It is the same empty-body EDIT under {§edit-pattern}, including exact column
and multiline regions, scope, preconditions, proposals, and receipt. It has no
separate line-deletion mode. Zero matches leave the resource unchanged (204,
`matched: 0`); a pattern never becomes whole-resource deletion. The receipt
counts selected spans and retains the first and last applied effects.
Log KILL still selects retirement rows ({§log-history-projection}); stream
KILL controls a process and refuses a content pattern (`kill-pattern-unsupported`).

---

## Testing and evidence

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§live-harness-deadline} | The live harness uses `PLURNK_SERVICE_LIVE_TIMEOUT` as one whole-specimen deadline, including multi-prompt… |
| {§tier-specimen-selection} | One invocation runs the live tier or one of its specimens. |
| {§provider-conformance-matrix} | The provider conformance matrix: every configured model alias is exercised through a real PLURNK loop: the… |
| {§test-artifact-retention} | Test artifact retention: every harness writes its run into one home. |
| {§tier-census} | A real-model tier run is one directory with its census. |
| {§fs-resource-state} | The resource-state harness — coverage that closes the class. |
<!-- /map -->

| Tier | Location | LLM | Substrate |
|---|---|---|---|
| **unit** | `src/**/*.test.ts` | No | Isolated logic, mocked boundaries |
| **intg** | `test/intg/` | No (mock provider) | Real file-backed SqlRite (per-test DB under `test/intg/.tmp/`), real engine |
| **live** | `test/live/` | Real | Thin real-model smoke and digest witness; the full `live` and `demo` specimen corpus lives in `plurnk-bench/tiers/` (#1236) |

§live-harness-deadline The live harness uses `PLURNK_SERVICE_LIVE_TIMEOUT`
as one whole-specimen deadline, including multi-prompt stories. The test's abort
signal reaches the loop wait and invokes ordinary scope cancellation before
teardown. The runner joins the test body's cleanup before starting the next
specimen. The shared workspace and story helpers (`test/harness.ts`) cover setup,
inference and oracle failures, preserve the primary failure when their cleanup
also fails, and attempt every registered disposal.
The provider whole-call deadline and recovery policy remain independent; a harness cancellation is
not evidence that the provider's own deadline expired.

§tier-specimen-selection **One invocation runs the live tier or one of its specimens.** The live catalog is every specimen under `test/live/`, registered in one place; `npm run test:live` runs the tier, and `-- --specimen "<name>"` the one specimen, through the same invocation, which places the name pattern before the file list. A selector must match at least one registered specimen before any provider call: a zero-match selector exits non-zero and runs nothing.

§provider-conformance-matrix **The provider conformance matrix: every configured model alias is exercised through a
real PLURNK loop: the production packet, a model-selected operation, its
materialized result, and completion.** Transport-only completions are not
conformance evidence. Provider-exposed reasoning must survive in the durable
assistant packet and digest; a provider with no private reasoning is valid when
the observable operation cycle succeeds. One package-owned runner executes the
live smoke (`npm run test:live -- --specimen
"<exact test name>"` in plurnk-core), rejecting absent and duplicate names before
execution, while `plurnk-bench` runs the full `live` and `demo` corpora. The ledger and classification taxonomy live in
`plurnk-providers/README.md` and report authorization/credential failures
distinct from model failures and repeated stochastic failures separately from
stable ones, never with weakened assertions.

§test-artifact-retention **Test artifact retention: every harness writes its run into one home.** A file-backed test database is a benchmark artifact like any other: the lane's run directory lives under `PLURNK_BENCHMARKS` (`~/benchmarks` by default) beside live, demo and benchlet runs, and the checkout holds source only — never run output.

| Fact | Rule |
| --- | --- |
| The stamp | `test:intg` stamps `PLURNK_TEST_RUN` once and every test process inherits it, so one suite's databases land in one directory without a pretest step, a marker file or a sweep; an unstamped invocation is not a special case with its own rules, it is simply an unstamped run with its own directory |
| The lane | a lane whose suite boots Core through Core's test harness also exports `PLURNK_TEST_LANE`, its own lane name, so the daemon it boots writes into that lane's run directory and the lane's reclaim takes all of it; an unnamed run is Core's |
| Reclaim | a stamped run that passes is reclaimed when it exits; a failed suite's evidence is never touched and stays exactly where the run reported it |
| Fixture reuse | a cross-package test may reuse Core's migration fixture only by passing a path inside the caller's own run directory |

§tier-census **A real-model tier run is one directory with its census.** The live driver stamps `PLURNK_TIER_RUN` as `<kind>-<UTC stamp>`; every session the run claims lands inside `PLURNK_BENCHMARKS/tier-<kind>-<stamp>/`, each in its own `<label>-XXXXXX/` with its database, its own host, its digest and a `census.json` naming the specimen that drove it, its loops, turns, requests, tokens and cost. The run's `census.md` and `census.json`, written by the tier's node:test reporter when the run ends, carry one row per specimen: verdict, skip reason or first failure line, the sessions it claimed, turns, requests and cost; a run never deletes or moves any of it. `npm run digest:missing` re-digests only a run's interrupted specimens, replacing a partial digest with a complete one and touching no other.

A specimen declares what it requires of the route and the host; an unmet requirement is a skip, before anything boots or is spent, whose reason names the requirement and what was observed, and the census answers each unmet route-bound requirement with the declared aliases whose catalog entry satisfies it. A route the harness cannot resolve is a failure, never a skip. No test surface is an opt-in flag or a script of its own: the third-party MCP composition, the llama-server rails and the client's real-model TUI tier are live specimens that run wherever their requirements hold.

| Requirement | Form |
| --- | --- |
| an input modality | `input:<image\|pdf\|audio\|video>` |
| reasoning | `reasoning` |
| an output budget | `output-budget` |
| an environment variable | `env:<NAME>` |
| a URL | `url:<http(s) URL>` |
| a binary on PATH | `bin:<name>` |
| a checkout | `checkout:<client>`, at `PLURNK_CLIENT_CHECKOUT`, else beside the repository |

§fs-resource-state **The resource-state harness — coverage that closes the class.** Op-outcome tests check what an op returned; the harness checks the resulting resource state. `ResourceState.check(db)` asserts, pure-db and read-only: identity uniqueness in practice (no tuple holds two rows), the canonical fixpoint on every file-class key, channel orphan-freedom, the closed admission set (every file row's origin is Git or constraint), and sig-coherence. Generated-pick incorporation and lifecycle require filesystem/Git evidence and are covered by the composed creation matrix rather than a false pure-database proxy. The harness runs as a lifecycle-test epilogue and at every soak turn boundary, where the delta half applies: an idle turn grows the entries table by ZERO. A violation names its law and its row.

## Problem codes and pinned wording

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§problems-dispatch} | Dispatch Problems. |
| {§problems-loop} | Loop and context Problems. |
| {§unregistered-scheme-recovery} | An unregistered scheme's refusal names what does exist. |
| {§problems-content} | Content and transfer Problems. |
| {§problems-file} | File scheme Problems. |
| {§problems-exec} | Execution Problems. |
| {§problems-entries} | Entry scheme Problems (log, session, workspace, entries). |
| {§problems-client} | Client interactions and message admission Problems. |
| {§problems-functionality} | Server and Functionality Problems. |
| {§pinned-wording-core} | Pinned wording. |
<!-- /map -->

Every Problem code core mints is named here under its family ({§problem-error-carrier} carries it); the root lint (`scripts/problem-codes.mjs`) refuses a code no owning SPEC names.

§problems-dispatch **Dispatch Problems.** Every code minted here, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `target-required` | 400 | *OP* requires a target path. Recovery: Write the target in parentheses on the opening fence line: `OP (path)`. |
| `target-cardinality` | 400 | *OP* *operand* matched *n* resources; expected one. Recovery: Name one source and one destination per pair. |
| `scheme-not-found` | 501 | Scheme '*name*' is not registered. Recovery: ({§unregistered-scheme-recovery}) `Registered schemes: *names*.` |
| `scheme-metadata-unsupported` | 400 | *OP* on '*scheme*' does not accept the [metadata] modifier. |
| `operation-not-implemented` | 501 | Scheme '*name*' does not implement *OP* (or exec). |
| `entry-read-not-implemented` | 501 | The '*scheme*' scheme does not provide entry reads. |
| `entry-write-not-implemented` | 501 | The '*scheme*' scheme does not provide entry writes. |
| `entry-delete-not-implemented` | 501 | The '*scheme*' scheme does not provide entry deletion. |
| `channel-delete-not-implemented` | 501 | The '*scheme*' scheme does not provide channel deletion. |
| `scheme-handler-threw` | 500 | The '*scheme*' scheme did not produce a result for *OP*. |
| `exec-source-not-data` | 501 | Scheme '*name*' is not a data source for an execution. |
| `writer-forbidden` | 403 | Writer '*origin*' cannot modify scheme '*name*'. |
| `capability-denied` | 403 | Capability '*route*' is denied by *scope* policy. |
| `spawn-prompt-empty` | 422 | *OP* has no prompt text. Recovery: Write the prompt on the lines beneath the *OP* fence line. A prompt resource that is empty with no body says so: *OP* has no prompt text: the resource is empty and there is no body. Recovery: Write the prompt on the lines beneath the *OP* fence line, or name a resource that holds it. |
| `message-not-found` | 404 | No accepted message exists at *address*. |
| `send-target-required` | 400 | SEND has no recipient and its loop has no published message. Recovery: Name a recipient address. |
| `edit-collision` | 409 | EDIT collided with the current resource state ({§edit}). Recovery: *n* of *m* edits applied. READ the target for current coordinates. |
| `edit-target-required` | 400 | A line-anchored EDIT requires a target resource. Recovery: Provide the target that rendered the line anchor. |
| `kill-target-required` | 400 | KILL requires a target path. |
| `kill-target-scheme-required` | 400 | KILL target requires a scheme. |
| `session-not-found` | 404 | Session '*name*' does not exist in this workspace. |
| `entry-operation-unsupported` | 400 | KILL requires an entry-bearing target; '*scheme*' does not provide one. |
| `coordinate-invalid` | 400 | '*to*' is not a log coordinate ({§log-wire-format}). Recovery: Name the coordinate as `<loop>/<turn>/<item>`, as the log shows it. |
| `coordinate-not-found` | 404 | No log entry exists at log:///*coordinate* ({§log-wire-format}). |
| `project-root-required` | 400 | Rollback restores files, and this workspace has no project root ({§log-wire-format}). |
| `resource-scheme-required` | 400 | Resource selection requires an address. |
| `channel-required` | 400 | The '*scheme*' scheme has no default channel. Recovery: Address a named channel with a URI fragment. |
| `binary-source-unsupported` | 415 | Channel #*name* is binary and its scheme keeps no bytes to transfer. |
| `fork-unaddressed` | 404 | This client operation acts for no session, so FORK has no log to branch ({§connection-lifecycle}). |
| `session-name-conflict` | 409 | Session '*name*' already exists in this workspace. Recovery: WORK or SEND (session://*name*) delivers a message to the live session; FORK with a name no session holds. ({§session-scheme}) |
| `no-operation` | 422 | The turn performed no operation ({§outside-text}). |
| `send-target-not-a-recipient` | 400 | The addressed scheme is not a SEND recipient. Recovery: Name a message address or a recipient that implements SEND. |
| `invalid-operation-syntax` | 400 | The parser's diagnostic for an invalid operation in an admitted turn. |
| `unreadable-pattern` | 400 | The pattern reader's diagnostic for an unreadable matcher. |
| `completion-invalid` | 400 | A reply accepts one completion code: 200 or 499. |
| `attachment-address-invalid` | 400 | An attachment selects one exact resource address. |

§problems-loop **Loop and context Problems.** These codes identify the failed boundary; lifecycle and recovery remain governed by their owning contracts.

| code | status | condition |
|---|---:|---|
| `result-exceeds-budget` | 413 | A result exceeds the remaining log budget; detail names its size, delivered portion, and a smaller selection or curation ({§context-fit}). |
| `window-overflow` | 413 | The packet exceeds the model's window ({§context-wall}). |
| `packet-exceeds-budget` | 413 | Context exceeds budget; the curation mandate is the pinned sentence below ({§context-over-budget-row}). |
| `loop-timeout` | 504 | The loop exhausted its active execution allowance. |
| `strike-threshold` | 508 / 500 | Repetition crossed the strike threshold (508), or another strike source crossed it (500), under {§engine-rails}. |
| `loop-running` | 425 | The addressed execution has not concluded. |
| `loop-cancelled` | 499 | The loop was cancelled; detail preserves the cancellation reason. |
| `loop-threw` | 500 | The loop failed outside its operation result contract. |
| `narration-failed` | 500 | Filesystem divergence narration failed before its operation turn settled. |
| `provider-contract-violation` | 502 | The provider failed without returning its required Problem Details. |
| `active-session-limit-reached` | 508 | The workspace's active sessions reach its configured limit. |

§unregistered-scheme-recovery **An unregistered scheme's refusal names what does exist.** Its recovery
lists the schemes the workspace registers, and rebuilds the address into nothing else
({§diagnostic-observation}). READ, FIND, KILL and resource selection share the sentence.

§problems-content **Content and transfer Problems.** Every code minted here, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `handler-crashed` | 415 | The *mimetype* content handler failed on *key*: *cause*. |
| `line-anchor-unsupported` | 400 | The byte view of *target* publishes no anchors. Recovery: Use byte coordinates: `<first,last>`. |
| `line-anchor-invalid` | 400 | A line anchor in the marker is malformed or names no current line ({§line-anchors}). |
| `channel-not-found` | 404 | The addressed channel does not exist at *target*. Recovery: Use one of the available channels: #*a*, #*b*. |
| `binary-read-unsupported` | 415 | The representation at *target* is binary and cannot be rendered. |
| `pattern-unapplicable` | 422 | The pattern could not be applied to *target*. |
| `move-region-overlap` | 409 | MOVE cannot insert a whole channel into itself and then remove that channel. |
| `mimetype-mismatch` | 415 | COPY or MOVE cannot write '*source-mimetype*' into a '*destination-mimetype*' channel. |
| `binary-region-unsupported` | 415 | Channel #*name* is binary and cannot receive a textual region. |
| `copy-destination-exists` | 409 | COPY or MOVE destination *address* already contains different content. |
| `proposal-apply-missing` | 500 | The source scheme accepted its MOVE proposal without applying the source mutation. |
| `line-anchor-collision` | 409 | READ coordinates collided with current content at *target*. |

§problems-file **File scheme Problems.** Every code minted here, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `invalid-file-url` | 400 | The native file-URL diagnostic, or `File URL path must not include NUL characters.` ({§fs-namespace}). |
| `edit-empty` | 400 | EDIT requires at least one statement. Recovery: Provide an EDIT statement. |
| `edit-batch-mismatch` | 400 | The EDIT batch spans multiple resources. Recovery: Submit a separate EDIT batch for each resource. |
| `line-marker-required` | 400 | EDIT of an existing file requires a line marker ({§edit}). Recovery: Name the lines to replace with `<@hash>` or `<@start,@end>` from a READ of the file; `<L,1,L,1>` inserts before line L, and `<1,-1>` replaces the whole file. |
| `creation-batch-conflict` | 409 | Multiple EDIT operations attempted to create the same file. Recovery: Create the file with one EDIT before applying additional edits. |
| `member-read-only` | 403 | The mounted member '*path*' is read-only. |
| `project-root-required` | 400 | The workspace has no project root, so it cannot write files. |
| `path-names-no-file` | 403 | The spelling '*path*' does not name a file: it is empty, or it names a directory. |
| `path-occupied-by-nonmember` | 403 | A non-member file already occupies '*path*'. Recovery: Choose an unoccupied member path. |
| `path-outside-workspace` | 403 | A symlink on '*path*' resolves outside the namespace. |
| `binary-write-unsupported` | 415 | A text EDIT cannot author binary '*mimetype*'. |
| `file-create-excluded` | 403 | A members exclusion (`!_glob_`) covers '*path*'. Recovery: Remove or disable the excluding members definition, or choose another path. |
| `file-create-gitignored` | 403 | Active Git policy ignores '*path*', and no members definition includes it. Recovery: Choose a Git-admitted path or add a members definition that includes it. |
| `file-materialization-limit` | 413 | The file exceeds the materialization byte limit and is not read into the workspace. |
| `entry-not-found` | 404 | No member of this workspace is at '*path*'. Recovery: FIND lists paths. EDIT creates files; `plurnk (members)` admits existing files with a `{"verb": "add", "files": ["<path>"]}` body. A path beyond the root recovers instead to: '*path*' is outside the project root: only a members definition under the operator's namespace scope admits it. |
| `body-channel-required` | 400 | A file write requires a body channel. |
| `write-failed` | 500 | Publication or its settlement failed; the result distinguishes an unpublished write from an already-published one. |
| `creation-rollback-failed` | 500 | Incorporating a newly created file failed, and rollback was incomplete. |
| `creation-incorporation-failed` | 500 | Incorporating a newly created file failed; its exclusive creation was rolled back. |
| `materialization-failed` | 500 | The file was written to disk but could not be registered. |
| `delete-failed` | 500 | Deletion or projection settlement failed; the result distinguishes an undeleted file from an already-deleted one. |

§problems-exec **Execution Problems.** Every code minted here, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `stream-not-found` | 404 | No execution exists at the requested address. Recovery, when the id holds an execution under another runtime ({§exec-target-routing}): The execution at /*id* is `*runtime*:///*id*`. |
| `executor-not-registered` | 400 | No executor or MCP service named '*runtime*' is registered for this session. |
| `runtime-unavailable` | 501 | Executable tool '*runtime*' is unavailable; detail includes the availability diagnostic. |
| `lifetime-invalid` | 400 | The execution lifetime directive is invalid; detail identifies the invalid form. |
| `metadata-unsupported` | 400 | Executable tool '*runtime*' does not accept metadata, or stored execution output does not accept READ or FIND metadata. |
| `target-classification-failed` | 500 | The execution target could not be inspected; detail includes a bounded cause. |
| `source-content-unavailable` | 422 | The source scheme did not supply execution content. |
| `stream-entry-write-failed` | 500 | The execution's stream entry could not be created. |
| `program-is-a-tool` | 404 | The command exited 127 and names a registered tool of another runtime ({§exec-target-routing}). |
| `executor-did-not-conclude` | 500 | The executor did not produce a terminal result. |
| `execution-cancelled` | 499 | Execution was cancelled by the service. |
| `executor-invalid-result` | 500 | The executor returned an invalid operation result. |
| `executor-threw` | 500 | The executor failed outside its operation result contract. |
| `entry-narration-failed` | 500 | An executor entry could not be materialized or narrated. |

§problems-entries **Entry scheme Problems (log, session, workspace, entries).** Every code minted here, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `read-target-required` | 400 | READ requires a log coordinate. Recovery: Provide one exact log coordinate. |
| `coordinate-malformed` | 400 | The log coordinate '*path*' is malformed. Recovery: Use one exact loop/turn/sequence coordinate. |
| `log-unaddressed` | 404 | This client operation acts for no session, so `log:///` names no log ({§connection-lifecycle}). |
| `kill-failed` | 400 | The log target '*path*' is malformed. (A glob the matcher cannot read: The log glob '*glob*' is malformed.) Recovery: the {§log-kill-scope} sentence. |
| `curation-failed` | 400 | A scoped KILL's selection could not be read: the same sentences and recovery as `kill-failed`. |
| `session-target-required` | 400 | EDIT requires a session:// target. Recovery: Provide the session target. |
| `workspace-target-required` | 400 | EDIT requires a workspace:/// target. Recovery: Provide the workspace target. |
| `workspace-authority-unsupported` | 400 | A workspace:/// address takes no authority. Recovery: Use `workspace:///path` for shared workspace entries or `session://<name>/path` for session scratch. |
| `binary-edit-unsupported` | 415 | The #*channel* channel is binary and cannot be edited. |
| `message-not-implemented` | 501 | SEND does not deliver messages to *scheme* entries. Recovery: To reply, SEND to an Open Message address or omit the target. `SEND (session://<name>)` sends a new message. |
| `session-entity-not-editable` | 400 | A session entity is not an editable entry. Recovery: EDIT requires an entry path, such as workspace:///example.md. |
| `workspace-entity-not-editable` | 400 | A workspace entity is not an editable entry. Recovery: EDIT requires an entry path, such as workspace:///example.md. |
| `message-empty` | 400 | SEND has no message text or attachments. |
| `scope-unsupported` | 400 | A session SEND takes no scope. |
| `control-address-invalid` | 400 | The operation requires an authority-only session control address. |
| `named-session-required` | 400 | A session deliverable READ requires a named session. |
| `emission-curated-whole` | 422 | An emission source announcement must be curated whole, without a line scope. |
| `entry-exists` | 409 | An entry already exists at the addressed resource. |
| `invalid-expression` | 400 | The full-text or graph matcher expression is invalid. |
| `delete-target-required` | 400 | KILL requires a target path. |

§problems-client **Client interactions and message admission Problems.** Refused admission creates no replacement message or interaction.

| code | status | condition |
|---|---:|---|
| `interaction-not-pending` | 409 | The requested client interaction is not pending. |
| `interaction-unsupported` | 501 | No recipient implements the requested tool for this session. |
| `recipient-mismatch` | 403 | Only the interaction's recipient may answer it. |
| `interaction-response-invalid` | 400 | The response does not satisfy the pending interaction's schema. |
| `invalid-body` | 400 | A question body is not JSON, or lacks its nonempty message or requested schema. |
| `offset-invalid` | 400 | An entry offset is not a nonnegative safe integer. |
| `userinfo-not-allowed` | 400 | An entry target URL contains userinfo. |
| `action-threw` | 500 | The client action failed outside its operation result contract. |
| `operation-cancelled` | 499 | The client operation was cancelled: *reason*. Its loop settles with this result ({§connection-lifecycle}). |
| `message-already-accepted` | 409 | The message address was already accepted in this workspace. |
| `message-address-reused` | 422 | The message address was already accepted in this workspace with other words. |
| `source-not-running` | 409 | The originating task is not running; no message was admitted. |
| `loop-not-open` | 409 | The named loop is not an unfinished recipient of the session; no message was admitted. |

§problems-functionality **Server and Functionality Problems.** Every code minted here, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `service-starting` | 503 | The PLURNK service owns this listener but has not admitted its client interface yet. |
| `route-not-found` | 404 | The requested HTTP route does not exist. |
| `request-target-invalid` | 400 | The request target is not a URL the listener can route. |
| `route-failed` | 500 | The mounted route failed while answering the request. |
| `configuration-invalid` | 503 | The owning configuration reader's diagnostic, naming the invalid key. Recovery: Correct the named configuration input. Other capabilities remain available. |
| `name-reserved` | 400 | '*alias*' is reserved in env entries. Recovery: READ workspace:///_plurnk/tools/plurnk/env.json for supported configuration paths. |
| `value-invalid` | 400 | '*alias*' needs a string value. |
| `source-unknown` | 400 | '*source*' is not a package in the configuration catalog. Recovery: Omit source to list the catalog. READ files; set variables with add. |
| `query-invalid` | 400 | '*query*' names no path or pattern. Recovery: Supply a path such as `docs/guide.md` or a pattern such as `docs/**`. |
| `headless` | 409 | The workspace has no project root, so there are no file members. Recovery: Open the workspace on a project root. |
| `definition-invalid` | 400 | A members definition is { glob }: a shell-path pattern, `!glob` to exclude. |
| `model-scope` | 403 | The model may not change membership here: the members scope is none. Recovery: A client or operator definition can admit it; that is the user's to give: ask them. |
| `workspace-not-found` | 404 | Workspace *id* does not exist. |
| `state-not-json` | 400 | Session module state is not JSON-serializable. |
| `workspace-busy` | 409 | Workspace *id* is running an operation or another capability change. Recovery: Settle the current operation and retry the capability change. |
| `not-configured` | 501 | No provider is configured for this session. Recovery: Select a model for this session, or set `PLURNK_MODEL=<provider/model>` as the service default; that provider's API key must be in the service's environment. |
| `provider-unavailable` | 503 | *route* is unavailable, followed by the provider's instantiation failure when present. |
| `effort-unsupported` | 409 | *route* does not support effort '*effort*'. Recovery: Select one of the provider's supported efforts: *supported*. ({§session-model-selection}) |
| `effort-invalid` | 400 | The effort is invalid. Recovery: Select a valid effort: off, adaptive, low, medium, high, xhigh, max. ({§session-model-selection}) |
| `context-exceeds-model-budget` | 413 | Current context (*tokens* tokens) does not fit in *route* (budget: *budget* tokens). Recovery: Curate context below *budget* tokens or select a larger model. ({§session-model-selection}) |
| `model-session-required` | 404 | No model session exists for prompt injection (or to fork). |
| `name-conflict` | 409 | The session name is taken. Recovery: Choose another session name. |
| `offset-channel-required` | 400 | Recovery: Select the channel to read from the offset. |
| `target-invalid` | 400 | Recovery: Use a scheme://path target. |
| `proposal-not-pending` | 409 | Recovery: Refresh pending proposals before resolving one. |
| `proposal-decision-unrecorded` | 500 | The approval decision could not be saved; the operation was not applied. |
| `scope-cancelled` | 499 | The session scope was cancelled: *reason*. |
| `range-not-satisfiable` | 416 | `Range <0,-1>` starts at 0, which is not a line; lines are numbered from 1. Recovery: Trim one line with `<L>` or lines L through M with `<L,M>`; `KILL (log:///…/READ)` with no scope retires the whole row. |
| `runtime-owner-reserved` | 409 | The runtime owner cannot be registered by a client. |
| `owner-not-found` | 404 | The owner address is not registered in the workspace. |
| `proposal-policy-failed` | 500 | Core could not establish the proposal's settlement policy. |
| `handler-unavailable` | 410 | The proposed scheme handler is no longer available. |
| `proposal-apply-threw` | 500 | The scheme failed outside its proposal application contract. |
| `verb-unknown` | 400 | The requested verb is not a lifecycle verb of the addressed family. |
| `arguments-not-json` | 400 | The lifecycle verb's body must be a JSON object. |
| `dispatch-threw` | 500 | The Plurnk actor failed outside its operation result contract. |

§pinned-wording-core **Pinned wording.** Verbatim sentences tests pin: each is contract, and a change here is a change of contract.

| sentence | arises when |
|---|---|
| Nothing is in flight. Continuing. | a WAIT (or a premature terminal) with no live work ({§loop-completion}) |
| All Open Messages resolved. Review new results; emit no OPs if finished. | resolved messages with unobserved results ({§loop-completion}) |
| Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn. | the over-budget row ({§context-over-budget-row}) |
| YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn. The turn continued without a NOTE. | a continuing or parked model turn without a NOTE ({§continued-without-note}) |
| Each directive in the notice table | a notice of the model's own output ({§notice-directive}) |
| Context window overflow: the packet exceeds the model's window. | the wall ({§context-wall}) |
| No recipient implements the requested interaction. | The session's owner is not interactive or does not declare the required client tool ({§session-ownership}). |
| Nobody is present to answer. Decide from what you already have, or conclude stating what you could not resolve. | dispatch of an interaction tool the session's owner would not receive ({§question-tool}) |
| Session name '*name*' must match `[A-Za-z0-9][A-Za-z0-9_-]{0,62}`. Recovery: Use 1–63 ASCII letters, digits, '_' or '-', starting with a letter or digit. | an invalid session name |
| Provide the client identifier. / Provide an absolute project path. / Use a positive integer limit. / prompt is not a non-empty string. | client input validation on the daemon's methods |
| name '*name*' has the path segment '*segment*'. Recovery: Provide a name with no '.' or '..' between its slashes; a dot within a segment is ordinary. / name is not well-formed Unicode: it holds an unpaired surrogate. | a workspace name refused at creation or rename ({§execution-output-identity}) |
| The stream was cancelled by KILL. | a stream terminal after KILL |
| '*runtime*' exited with code 127; `*program*` is a registered tool of `*owner*`. | a tool run as a shell command ({§exec-target-routing}) |
| '*path*' is a directory, not a file; READ reads one file. Recovery: `FIND (_path_/)` lists its files. | READ of a directory |
| The execution at ops://*session*/*loop* has not concluded. | a bare READ of a running session's result (425) |
| The child provider failed. | a child's provider failure read back by its parent |
| '*path*' exists on disk but is not a member of this workspace. Recovery: Admit it with `plurnk (members)` and a `{"verb": "add", "files": ["<path>"]}` body. | a non-member on disk at the addressed path |
| '*path*' exists on disk but is not a member of this workspace. Recovery: Git ignores it (`<file>` line `<n>`): a client or operator members definition can include it, a model definition cannot. | a non-member git ignores ({§fs-namespace}, {§membership}) |

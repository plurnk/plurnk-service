# Plurnk module contract specification

`@plurnk/plurnk-modules` is the API a daemon module codes against: the lifecycle it implements
and the base setup seam it receives. It depends on `@plurnk/plurnk-contracts` alone and holds
only abstractions, so it is the most stable package of the module kind (ARCHITECTURE.md §
Package principles). The service hosts modules: it discovers them ({§module-lifecycle}),
drives their lifecycle ({§module-lifecycle}, {§module-shutdown-order}) and implements every
seam slice.

## §module-contract 1. Module Contract and Lifecycle

A module is a `DaemonModule<SetupSeam, StartSeam>`. Every member is optional, and each seam
type names only what the module uses. The host passes one object implementing every slice; seams are typed for clarity, not enforced at runtime.

| Member | Receives | Contract |
| --- | --- | --- |
| `setup` | Its setup seam | Establishes every capability the host may demand during recovery (Functionality adapters, schemes, module actions). |
| `start` | A `Pick` slice of {§application-session-observation} | Opens exterior ingress only after the host readies schemes, publishes capabilities, and recovers durable lifecycle; may return a distinct lifetime object. |
| `stop` | Nothing | Rejects new ingress and settles owned producers while observers stay subscribed. |
| `close` | Nothing | Releases observers and remaining resources after producers settle, and returns once the work its routes admitted has settled. |
| `mounts` | Declared, not called | Absolute HTTP pathname prefixes ({§http-host}) the module mounts at `start`. |
| `contained` | Declared, not called | Invalid settings `{ key, message }` the module contained by withholding only the part each configures. |

| Invariant | Contract |
| --- | --- |
| HTTP mounts | The host claims every module's `mounts` before any module sets up: one prefix (including optional root `/`) claimed twice fails boot naming both owners. At `start` a module mounts its exact claims via `registerHttpRoute` and/or `registerHttpUpgrade`: an unclaimed prefix is refused, and a claim left unmounted fails boot. The listener answers `503 service-starting` until every module has started, and `404 route-not-found` for unclaimed paths afterwards. Without a listener, the host leaves out every module declaring mounts before setup with an info notice owned by `module:<package>`. |
| Phase order | Every module's `setup` completes before any module's `start`, and stopping runs every `stop` before any `close`. Registration order is not part of the contract and none is inferred from discovery. |
| Route settlement | A request a mounted route admitted, and work started for it, may call the host until it settles; `close` joins that work so nothing a module admitted reaches the host after `close` returns ({§module-shutdown-order}). |
| Self-activation | A discovered module's export is an object or zero-arg factory ({§module-lifecycle}) reading its own knobs from its documented environment. An unconfigured module is inert (no mounts, no registrations). |
| Contained configuration | When a setting is invalid, a module withholds only that part and lists `{ key, message }` in `contained`. The host reports each as a configuration Notice owned by `module:<package>` ({§configuration-repair-path}), and offline checks fail on it. A module that cannot work at all throws from its factory ({§module-lifecycle}). |
| Failure & unwind | The host tracks a module with `stop`/`close` before `setup`, plus any distinct lifetime object returned by `start`. A `setup` or `start` failure leaves later modules unrun for that phase, fails boot, and stops/closes every tracked module (including the failing one) in reverse registration order ({§module-shutdown-order}) into one shutdown aggregate. |

## §module-seam-slices 2. Seam Slices and Base Setup Functions

A module's setup seam is the intersection of the slices it uses; each framework owns its kind's slice and contribution types. A module declares `@plurnk/plurnk-modules` and each framework whose slice it uses as npm `peerDependencies` (there is no manifest version field).

| Slice / Base Function | Owner | Contract |
| --- | --- | --- |
| `ModuleSetupSeam` | `@plurnk/plurnk-modules` | Workspace paths, environments, workspace state directory, and module actions. |
| `FunctionalitySeam<Runtime, SchemeFacet>` | `@plurnk/plurnk-modules` | `registerFunctionalityAdapter(adapter)` beneath the host's shared coordinator ({§functionality-coordinator}), returning its family handle. |
| `SchemeRegistrationSeam`, `ResourceTreeRegistrationSeam`, `RuntimeSchemeFacet` | `@plurnk/plurnk-schemes` ({§resource-tree-scheme}) | Scheme and read-only tree registration, and the facet a runtime or family manager exposes. |
| `Executor`, `RuntimeRegistration` | `@plurnk/plurnk-execs` ({§executor-role}) | Runtimes a resident family prepares. |
| `WorkspacePluginsSeam`, `WorkspacePluginSet` | `@plurnk/plurnk-agent-plugins` ({§agent-plugins-expansion}) | `readWorkspacePlugins(workspaceId)`. |
| `ProvidedSkillsSeam` | `@plurnk/plurnk-agent-skills` ({§provided-skills-module-slice}) | `readProvidedSkills()`. |
| `workspacePaths(workspaceId)` | `ModuleSetupSeam` | Returns absolute `home`, bound `projectRoot` (`null` for folderless workspaces), optional `workspaceName`, and read-only `configurationRoots` (`{ directory, scope }`) in highest-precedence-first order ({§functionality-inspection}). Modules append their format's paths and interleave within the same scope without reconstructing root order. |
| `operatorEnvironment()` | `ModuleSetupSeam` | Ambient launch base: operator environment without Plurnk configuration or provider credentials ({§execution-output-identity}). Explicit bindings belong to the consuming module ({§mcp-module}). |
| `readWorkspaceEnvironment(workspaceId)` | `ModuleSetupSeam` | Captures the workspace env layer ({§execution-output-identity}) and returns its composer (using admitted host values when called with no argument, or a supplied reference-resolution context), applying captured values and masks without session overrides. |
| `readSessionEnvironment(workspaceId, sessionId)` | `ModuleSetupSeam` | Workspace environment layers with the session's own overrides on top ({§functionality-coordinator}). |
| `workspaceStateDirectory(workspaceId, namespaceOwner)` | `ModuleSetupSeam` | Returns and creates the module's absolute operational-state directory under the daemon's XDG state home; survives workspace renames and restarts, and isolates distinct workspaces/databases. |
| `registerModuleAction({ name, scope, residency, inputSchema, outputSchema, handler })` / `invokeModuleAction(name, params, context)` | `ModuleSetupSeam` | Adds or invokes one non-empty, extension-unique action with resolvable JSON Schemas. `scope` is `'daemon' \| 'workspace' \| 'session'`; `residency` is `'required' \| 'none'` (`'daemon'` requires `'none'`; `'required'` acquires workspace capabilities and reconciles session documents). Scoped contexts carry trusted bound identifiers, never client parameters. |

## §functionality-adapter 3. Functionality Adapters

An adapter owns protocol truth: it declares its `family`, `namespaceOwner`, `definitionSchema`, contributed defaults, optional `discovery`, `admit`, `prepare`, teardown, and optional alias grammar (when not the shared lowercase-hyphen one). Shared shapes live in `plurnk-contracts`. `FunctionalityAdapter` is generic over prepared runtime, scheme facet, admitted definition, and committed snapshot.

| Aspect | Contract |
| --- | --- |
| Alias grammar & addressing ({§functionality-replacement}) | The coordinator enforces the family's declared alias grammar at admission, in the service projection, and on persisted state. Content-named families declare the inputs of `add` and select verbs and how a select input names its alias; `admit` returns one admission per definition `add` names. |
| Admission (`admit`) | Distinguishes explicit client actions from model operations where required ({§tools-resource-materialization}). Returns `{ alias, definition, preparation? }` (or an array for addressing families), passed to that mutation's `prepare` as `admissions`. The optional `preparation` payload belongs to one attempt: never persisted, projected, used as identity, or carried into later refreshes. |
| Preparation & publication (`prepare`) | Receives each complete enabled definition with optional adapter-owned `context` (source semantics participating in runtime identity and hot-load comparisons, never projected as configuration or persisted into a workspace override; removing a local override restores the inherited definition and context together) and the previous committed snapshot. Returns runtimes, documents, per-alias outcomes, and a snapshot with synchronous I/O-free `publish` (returning an undo callback inside the registry commit), post-publication `commit`, and candidate-only `abort` ({§functionality-coordinator}). |
| Cancellation (`preparation.signal`) | Aborted when workspace Functionality stops or the invoking operation is cancelled (removing queued waiting operations before preparation). Before preparation: do not call adapter. During preparation: signal cancellation and join preparation including candidate cleanup (rejecting with the signal's reason, never recording an unavailable definition). Candidate returned before publication: `abort` candidate and preserve preceding publication. Publication begun: finish atomic commit or rollback and cleanup ({§module-shutdown-order}). |
| `forget` & `configurationNotices` | Optional `forget` releases an installed/provisioned definition before removal (failure rejects removal). Optional `configurationNotices` joins partial-source notices to workspace diagnostics without blocking valid definitions. |
| Discovery (`discovery` / `discover`) | Declares non-empty, unique `inputs` from `FunctionalityDiscoverInput` (`'query' \| 'source' \| 'configuration'`), `emptyListsAll`, and optional `details` teaching. Declared if and only if `discover` is implemented; without `discovery`, the family has no `discover` verb ({§functionality-replacement}). |

# Plurnk module contract specification

`@plurnk/plurnk-modules` is the API a daemon module codes against: the lifecycle it implements
and the base setup seam it receives. It depends on `@plurnk/plurnk-contracts` alone and holds
only abstractions, so it is the most stable layer of the module family (ARCHITECTURE.md §
Package principles). The service hosts modules: it discovers them ({§module-discovery}),
drives their lifecycle ({§module-lifecycle}, {§module-shutdown-order}) and implements every
seam slice.

## §module-contract Module contract

A module is a `DaemonModule<SetupSeam, StartSeam>`. Every member is optional, and each seam
type names only what the module uses.

| Member | Receives | Contract |
| --- | --- | --- |
| `setup` | Its setup seam | Establishes every capability the host may demand during recovery. |
| `start` | A slice of {§application-port} | Opens exterior ingress only after durable recovery; may return a distinct lifetime object. |
| `stop` | Nothing | Rejects new ingress and settles owned producers while observers stay subscribed. |
| `close` | Nothing | Releases observers and remaining resources after producers settle. |

The host passes one object implementing every slice. Seams are typed for clarity, not enforced
at runtime: a module's declared slices are the coupling the compiler checks, and anything else
the host object carries is not contract.

## Seam slices

§module-seam-slices **A module's setup seam is the intersection of the slices it uses, and each
family owns the slice for what modules contribute to it.** A family's slice and its contribution
types live in that family's package, so this package never depends on a less stable one.

| Slice | Owner | Offers |
| --- | --- | --- |
| `ModuleSetupSeam` | `@plurnk/plurnk-modules` | Configuration directories; operator, workspace and worker environment; the workspace state directory; module actions |
| `FunctionalitySeam<Runtime, SchemeFacet>` | `@plurnk/plurnk-modules` | `registerFunctionalityAdapter` |
| `SchemeRegistrationSeam`, `RuntimeSchemeFacet` | `@plurnk/plurnk-schemes` ({§scheme-module-slice}) | `registerScheme`, and the facet a runtime or a family manager exposes |
| `Executor`, `RuntimeRegistration` | `@plurnk/plurnk-execs` ({§executor-module-slice}) | The runtimes a resident family prepares |
| `WorkspacePluginsSeam`, `WorkspacePluginSet` | `@plurnk/plurnk-agent-plugins` ({§plugin-set-module-slice}) | `readWorkspacePlugins` |

A start seam is a `Pick` of {§application-port} naming the calls the module makes.

## Base setup functions

| Function | Contract |
| --- | --- |
| `workspaceConfigurationDirectories(workspaceId)` | Returns the workspace's read-only configuration sources in highest-precedence-first order ({§agent-roots}). |
| `operatorEnvironment()` | Returns what a module's subprocess inherits: the operator's environment without plurnk's own secrets ({§exec-env-scoped}), not the model's command ceiling ({§mcp-launch-environment}). |
| `readWorkspaceEnvironment(workspaceId)` | Captures the workspace env layer ({§workspace-env}) and returns its composer. No argument uses admitted host values; a supplied environment supplies a module's reference-resolution context. Both apply the same captured values and masks, without worker overrides. |
| `readWorkerEnvironment(workspaceId, workerId)` | The same layers with the worker's own overrides on top ({§functionality-scope}): what a command of that worker runs under. |
| §module-workspace-directory `workspaceStateDirectory(workspaceId, namespaceOwner)` | Returns and creates the module's absolute operational-state directory under the daemon's XDG state home. The host owns placement: the directory survives workspace renames and daemon restarts, and independently created workspaces, including in other databases, receive different directories. The module owns its contents and child-directory lifetimes. |
| §module-action-registration `registerModuleAction({ name, scope, residency, inputSchema, outputSchema, handler })` | Adds one non-empty, extension-unique action with resolvable JSON Schemas. `scope` is exactly `worldless`, `workspace`, or `worker`; the handler receives schema-validated params and a separate matching context. `residency` is explicitly `required` or `none`: only the former acquires workspace capabilities and reconciles worker documents. Worldless actions require `none`. Scoped contexts contain trusted bound identifiers, never client parameters. A client-interface module decides whether and how the name becomes public, validates successful output, and owns collisions with its built-ins. |
| §module-functionality-adapter `registerFunctionalityAdapter(adapter)` | Registers one family beneath the host's shared coordinator ({§functionality-coordinator}) and returns its family handle. |

## Functionality adapters

§functionality-adapter **An adapter owns protocol truth.** It declares its
family, namespace owner, definition schema, contributed defaults, discovery,
admission, preparation, and teardown, and its alias grammar when that is not
the shared lowercase-hyphen one: the coordinator enforces whichever grammar the
family declares, at admission, in the service projection, and on persisted
state, so an environment variable's name is an alias exactly as a skill name
is. Admission distinguishes explicit client
actions from model operations where the family contract requires it
({§members-model-scope}). Preparation receives each complete definition with optional
adapter-owned interpretation context. Context is source semantics, not policy or provenance;
it participates in runtime identity and hot-load comparisons, is never projected as configuration
or persisted into a workspace override, and cannot survive replacement by a local definition.
Removing that override restores the current inherited definition and context together.
Descriptive provenance alone does not change runtime identity. Preparation returns runtimes, documents, per-alias
outcomes, and a snapshot with `commit`/`abort`. Successful publication commits;
failure aborts; cooling tears down. Protocol continuations remain ordinary
module actions. Optional `forget` releases an installed or provisioned
definition before removal; failure rejects removal. The
seam's shapes — the identity a verb acts under, its options, definition
sources, outcomes, preparation, the prepared result and the family handle —
are declared once in `plurnk-contracts`. `FunctionalityAdapter` is generic over
the runtime a resident family prepares and the scheme facet its manager may
expose; both default to none, and their families own them ({§module-seam-slices}).
An adapter may expose current partial-source `configurationNotices`; these join the ordinary
workspace diagnostics without preventing independently valid definitions from preparing.

# Plurnk module contract specification

`@plurnk/plurnk-modules` is the API a daemon module codes against: the lifecycle it implements
and the base setup seam it receives. It depends on `@plurnk/plurnk-contracts` alone and holds
only abstractions, so it is the most stable package of the module kind (ARCHITECTURE.md §
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
| `mounts` | Declared, not called | The HTTP route prefixes the module mounts at `start` ({§module-http-mounts}). |
| `contained` | Declared, not called | Settings the module contained: each withheld the part it configures ({§module-contained-configuration}). |

§module-http-mounts **A module declares the HTTP prefixes it serves.** `mounts` lists absolute
pathname prefixes ({§http-host}). The host claims every module's mounts before any module sets
up: one prefix claimed twice fails boot naming both owners. The root `/` is optional and obeys
the same ownership rule as any other prefix. At `start` a module mounts exactly its claims through
`registerHttpRoute`: an unclaimed prefix is refused, and a claim left unmounted fails boot. The
listener answers `503 service-starting` until every module has started, so readiness never
depends on registration order; afterwards an unclaimed path answers `404 route-not-found`.
A host without a listener has nothing to serve a mount on:
before any module sets up, it leaves out every module that declares mounts, registered or
discovered, with an info notice owned by `module:<package>`.

§module-phases **Every module's `setup` completes before any module's `start`.** `setup`
registers what the host may demand during recovery: Functionality adapters, schemes and module
actions. The host then readies schemes, publishes capabilities and recovers durable lifecycle,
and only then does any `start` bring up a face. Stopping runs every `stop` before any `close`.
These phases are the only order a module may rely on: registration order is not part of the
contract, and none is inferred from discovery.

§module-self-activation **A module configures itself.** A discovered module's export is an object
or a factory taking no arguments ({§module-discovery}), so it reads its own knobs from the
environment its package documents. An unconfigured module is inert: it claims no mounts and
registers nothing. The host decides nothing on a discovered module's behalf beyond leaving out
what it cannot host ({§module-http-mounts}).

§module-contained-configuration **A module contains a setting it cannot use.** When one of its
own settings is invalid, a module withholds only the part that setting configures, keeps the rest
working, and lists the setting in `contained`: its key and the exact message. The host reads the
list when the module registers and reports each entry as a configuration Notice owned by
`module:<package>` ({§configuration-repair-path}), and the offline check fails on it. The report
is declared, like `mounts`, because the host passes every module one seam object and cannot
attribute a call to a module. A module that cannot work at all throws from its factory instead
({§module-discovery}).

§module-failure **A `setup` or `start` failure fails boot, and stopping releases exactly what was
acquired.** The host tracks a module that has `stop` or `close` before its `setup`, and a distinct
lifetime object when `start` returns one. A setup failure leaves later modules neither set up nor
started; a start failure leaves later modules unstarted. Stopping the daemon then stops and closes
every tracked module, the failing one included, in reverse registration order
({§module-shutdown-order}). A phase failure does not skip later phases and joins one shutdown
aggregate.

The host passes one object implementing every slice. Seams are typed for clarity, not enforced
at runtime: a module's declared slices are the coupling the compiler checks, and anything else
the host object carries is not contract.

## Seam slices

§module-seam-slices **A module's setup seam is the intersection of the slices it uses, and each
framework owns the slice for what modules contribute to its kind.** A kind's slice and its
contribution types live in its framework's package, so this package never depends on a less stable one.

| Slice | Owner | Offers |
| --- | --- | --- |
| `ModuleSetupSeam` | `@plurnk/plurnk-modules` | Workspace paths; operator, workspace and worker environment; the workspace state directory; module actions |
| `FunctionalitySeam<Runtime, SchemeFacet>` | `@plurnk/plurnk-modules` | `registerFunctionalityAdapter` |
| `SchemeRegistrationSeam`, `ResourceTreeRegistrationSeam`, `RuntimeSchemeFacet` | `@plurnk/plurnk-schemes` ({§scheme-module-slice}) | Scheme and read-only tree registration, and the facet a runtime or a family manager exposes |
| `Executor`, `RuntimeRegistration` | `@plurnk/plurnk-execs` ({§executor-module-slice}) | The runtimes a resident family prepares |
| `WorkspacePluginsSeam`, `WorkspacePluginSet` | `@plurnk/plurnk-agent-plugins` ({§plugin-set-module-slice}) | `readWorkspacePlugins` |
| `ProvidedSkillsSeam` | `@plurnk/plurnk-agent-skills` ({§provided-skills-module-slice}) | `readProvidedSkills` |

A start seam is a `Pick` of {§application-port} naming the calls the module makes.

§module-compatibility **A module states its compatibility as npm peer ranges.** It declares this
package, and each framework whose slice it uses, as peer dependencies; the host that implements the
contract is the one package that depends on it directly. There is no manifest version field.

## Base setup functions

| Function | Contract |
| --- | --- |
| §module-workspace-paths `workspacePaths(workspaceId)` | Returns the host's absolute `home`, the bound `projectRoot` (null for a folderless workspace), and selected read-only `configurationRoots` in highest-precedence-first order ({§agent-roots}). Each root has a `directory` and an opaque `scope` shared with plugin discovery. Modules append their own format's paths and can interleave sources within the same scope; they never reconstruct the host's root selection or order. Configuration inputs do not move with operational state. |
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
expose; both default to none, and the frameworks that own those types name them ({§module-seam-slices}).
An adapter may expose current partial-source `configurationNotices`; these join the ordinary
workspace diagnostics without preventing independently valid definitions from preparing.

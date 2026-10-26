// The daemon module contract ({§module-contract}): the lifecycle a module implements and the base
// setup seam it receives. Each framework owns the slice for what modules contribute to its kind
// ({§module-seam-slices}); this package depends on contracts alone (ARCHITECTURE.md § Package principles).
import type {
    ApplicationActionContext,
    ApplicationActionDescriptor,
    FunctionalityCaller,
    FunctionalityCandidate,
    FunctionalityAdmission,
    FunctionalityDefinitionSource,
    FunctionalityDiscoverInput,
    FunctionalityDiscoverQuery,
    FunctionalityFamilyHandle,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    JsonSchema,
    Notice,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";

export type ModuleActionScope = "daemon" | "workspace" | "session";

export type ModuleActionContext = ApplicationActionContext;

export type ModuleActionHandler = (
    params: Readonly<Record<string, unknown>>,
    context: ModuleActionContext,
) => unknown;

// {§module-action-registration}
export interface ModuleActionRegistration {
    readonly name: string;
    readonly scope: ModuleActionScope;
    readonly residency: "required" | "none";
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
    readonly handler: ModuleActionHandler;
}

export type ModuleActionDescriptor = ApplicationActionDescriptor;

// {§functionality-discovery-inputs} — the discovery a family serves: the shared query's inputs it reads,
// and whether a request naming none lists everything. The coordinator advertises exactly these.
export interface FunctionalityDiscovery {
    readonly inputs: readonly FunctionalityDiscoverInput[];
    readonly emptyListsAll?: true;
    // The family's own `discover` teaching beneath the generic verb summary.
    readonly details?: string;
}

// {§functionality-addressing} — a family whose definitions are named by their own content rather than
// by a caller-chosen alias. The coordinator still keys state by alias, under the family's own alias
// grammar; the family's verbs name it: `add` takes this input and `admit` returns one admission per
// definition it names, and enable, disable and remove take the select input. Such a family serves
// no `replace`: when the name is the definition, there is nothing to reassign.
export interface FunctionalityAddressing {
    // The exact `add` input.
    readonly add: JsonSchema;
    // The exact `enable`, `disable` and `remove` input.
    readonly select: JsonSchema;
    // The alias a select input names.
    alias(input: object): string;
}

// {§functionality-adapter} — one family of managed Functionality beneath the host's coordinator.
// `Runtime` is what a resident family prepares and `SchemeFacet` the face its manager may expose;
// both default to none, and the frameworks that own those types name them ({§module-seam-slices}).
// `Definition` is what the family's `definitionSchema` admits and `Snapshot` what its preparation
// commits; the family names both ({§functionality-adapter}).
export interface FunctionalityAdapter<Runtime = never, SchemeFacet = never, Definition extends object = object, Snapshot = unknown> {
    readonly scheme?: SchemeFacet;
    // {§capability-admission} — general policy facts of the family's runtime and the resources its
    // scheme face serves (`web` for a family that reaches the network): what a capability policy selects on.
    readonly traits?: readonly string[];
    // The action segment (`workspace.<family>.<verb>`, or `session.<family>.<verb>` for a
    // session-scoped family) and the name of the family's runtime.
    readonly family: string;
    // {§functionality-scope} Supported owners; the first is the model default.
    // Absent means workspace. A session layer inherits workspace defaults by reference.
    readonly scopes?: readonly ("workspace" | "session")[];
    // The alias grammar the coordinator enforces for this family. Absent means the shared default
    // (`[a-z][a-z0-9-]*`); a family whose alias is case-sensitive, or whose alias is the definition's
    // own content ({§functionality-addressing}), declares its own.
    readonly aliasPattern?: RegExp;
    // {§functionality-addressing} Absent: a caller-chosen alias names a definition, `add` and `replace`
    // take `{ alias?, definition }`, and the other mutations take `{ alias }`.
    readonly addressing?: FunctionalityAddressing;
    // The one publication owner for this family's runtimes and state.
    readonly namespaceOwner: string;
    readonly summary: string;
    // The exact definition the coordinator persists: what `add`/`replace` accept, or what an addressing
    // family's `admit` produces from its own `add` input.
    readonly definitionSchema: JsonSchema;
    // Teaching for the family's generated document ({§functionality-model-projection}): one exact
    // `add` input.
    readonly example?: object;
    // Absent: the family serves no discovery, and implements no `discover`.
    readonly discovery?: FunctionalityDiscovery;
    // {§functionality-document-body} — the adapter's package directory; its `docs/<family>.md` is the
    // authored teaching beneath the runtime document's generated header.
    readonly docsDir?: string;
    available(identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition<Definition>[]>;
    // Current partial-source diagnostics; independent valid definitions remain available.
    configurationNotices?(identity: WorkspaceCapabilityIdentity): readonly Notice[];
    // Receives only a query the family's declared discovery admits.
    discover?(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityCandidate[]>;
    // One admission, or, for an addressing family's `add`, one per definition the input names.
    admit(input: unknown, identity: WorkspaceCapabilityIdentity, caller?: FunctionalityCaller): Promise<FunctionalityAdmission<Definition> | readonly FunctionalityAdmission<Definition>[]>;
    prepare(preparation: FunctionalityPreparation<Definition, Snapshot>): Promise<FunctionalityPrepared<Runtime, Snapshot>>;
    teardown(snapshot: Snapshot, identity: WorkspaceCapabilityIdentity): Promise<void>;
    // Release what the workspace definition installed or provisioned, before the coordinator
    // forgets it on `remove`; a failure rejects the removal.
    forget?(definition: FunctionalityDefinitionSource<Definition>, identity: WorkspaceCapabilityIdentity): Promise<void>;
    // {§functionality-hotload} — republish when what `available` reads changed out of band; called
    // under the workspace turn gate before packet assembly.
    refreshIfChanged?(identity: WorkspaceCapabilityIdentity): Promise<void>;
}

// {§module-workspace-paths} — host placement, not a module-owned discovery cascade.
export interface WorkspacePaths {
    readonly home: string;
    readonly projectRoot: string | null;
    readonly configurationRoots: readonly {
        readonly scope: string;
        readonly directory: string;
    }[];
}

// {§module-seam-slices} — the base setup slice: what every host offers every module.
export interface ModuleSetupSeam {
    // {§module-workspace-paths}
    workspacePaths(workspaceId: number): Promise<WorkspacePaths>;
    // {§mcp-launch-environment} Ambient launch base, before the module's explicit bindings:
    // excludes reserved names ({§exec-env-scoped}) without applying the model-command ceiling.
    operatorEnvironment(): NodeJS.ProcessEnv;
    // {§workspace-env} The workspace layer over admitted ambient values, or over a supplied
    // reference-resolution environment. Never includes session overrides.
    readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§workspace-env} The same layers with the Session's own overrides on top ({§functionality-scope}).
    readSessionEnvironment(workspaceId: number, sessionId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§module-workspace-directory} The host owns placement; the module owns the contents.
    workspaceStateDirectory(workspaceId: number, namespaceOwner: string): Promise<string>;
    registerModuleAction(registration: ModuleActionRegistration): void;
}

// {§module-functionality-adapter} — registers one family beneath the host's coordinator.
export interface FunctionalitySeam<Runtime = never, SchemeFacet = never> {
    registerFunctionalityAdapter<Definition extends object = object, Snapshot = unknown>(
        adapter: FunctionalityAdapter<Runtime, SchemeFacet, Definition, Snapshot>,
    ): FunctionalityFamilyHandle;
}

// {§module-contained-configuration} One setting a module contained: it withheld the part the setting
// configures and kept the rest working.
export interface ContainedConfiguration {
    readonly key: string;
    readonly message: string;
}

export interface StartedModule {
    // {§module-shutdown-order} Producers settle before observers are released.
    stop?(): void | Promise<void>;
    close?(): void | Promise<void>;
}

// {§module-contract} `setup` establishes every capability the host may demand during recovery;
// `start` opens exterior ingress only after durable recovery is complete ({§module-lifecycle}).
export interface DaemonModule<SetupSeam = ModuleSetupSeam, StartSeam = ApplicationPort> extends StartedModule {
    // {§module-http-mounts} The HTTP route prefixes this module mounts at `start`, claimed before any
    // module sets up.
    readonly mounts?: readonly string[];
    // {§module-contained-configuration} Settings this module contained, read by the host at registration.
    readonly contained?: readonly ContainedConfiguration[];
    setup?(seam: SetupSeam): void | Promise<void>;
    start?(seam: StartSeam): void | StartedModule | Promise<void | StartedModule>;
}

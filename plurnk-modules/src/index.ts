// The daemon module contract ({§module-contract}): the lifecycle a module implements and the base
// setup seam it receives. Each framework owns the slice for what modules contribute to its kind
// ({§module-seam-slices}); this package depends on contracts alone (ARCHITECTURE.md § Package principles).
import type {
    ApplicationActionContext,
    ApplicationActionDescriptor,
    ApplicationPort,
    FunctionalityCaller,
    FunctionalityCandidate,
    FunctionalityDefinitionSource,
    FunctionalityDiscoverQuery,
    FunctionalityFamilyHandle,
    FunctionalityOptions,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityServiceDefinition,
    JsonSchema,
    Notice,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";

export type ModuleActionScope = "worldless" | "workspace" | "worker";

export type ModuleActionContext = ApplicationActionContext;

export type ModuleActionHandler = (
    params: Readonly<Record<string, unknown>>,
    context: ModuleActionContext,
) => unknown | Promise<unknown>;

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

// {§functionality-adapter} — one family of managed Functionality beneath the host's coordinator.
// `Runtime` is what a resident family prepares and `SchemeFacet` the face its manager may expose;
// both default to none, and the frameworks that own those types name them ({§module-seam-slices}).
export interface FunctionalityAdapter<Runtime = never, SchemeFacet = never> {
    readonly scheme?: SchemeFacet;
    // {§capability-admission} — general policy facts of the family's runtime and the resources its
    // scheme face serves (`web` for a family that reaches the network): what a capability policy selects on.
    readonly traits?: readonly string[];
    // The action segment (`workspace.<family>.<verb>`, or `worker.<family>.<verb>` for a
    // worker-scoped family) and the name of the family's runtime.
    readonly family: string;
    // {§functionality-scope} Supported owners; the first is the model default.
    // Absent means workspace. A worker layer inherits workspace defaults by reference.
    readonly scopes?: readonly ("workspace" | "worker")[];
    // The alias grammar the coordinator enforces for this family. Absent means the shared default
    // (`[a-z][a-z0-9-]*`); a family whose alias is case-sensitive declares its own.
    readonly aliasPattern?: RegExp;
    // The one publication owner for this family's runtimes and state.
    readonly namespaceOwner: string;
    readonly summary: string;
    // The exact definition one `add` accepts and the coordinator persists.
    readonly definitionSchema: JsonSchema;
    // Teaching for the family's generated document ({§functionality-model-projection}): one exact
    // `add` example, and the family's own `discover` contract when the generic one does not fit.
    readonly example?: { readonly alias: string; readonly definition: object };
    readonly discovery?: { readonly details: string };
    // {§functionality-document-body} — the adapter's package directory; its `docs/<family>.md` is the
    // authored teaching beneath the runtime document's generated header.
    readonly docsDir?: string;
    available(identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]>;
    // Current partial-source diagnostics; independent valid definitions remain available.
    configurationNotices?(identity: WorkspaceCapabilityIdentity): readonly Notice[];
    discover(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity, options?: FunctionalityOptions): Promise<readonly FunctionalityCandidate[]>;
    admit(input: unknown, identity: WorkspaceCapabilityIdentity, caller?: FunctionalityCaller, options?: FunctionalityOptions): Promise<FunctionalityDefinitionSource>;
    prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared<Runtime>>;
    teardown(snapshot: unknown, identity: WorkspaceCapabilityIdentity): Promise<void>;
    // Release what the workspace definition installed or provisioned, before the coordinator
    // forgets it on `remove`; a failure rejects the removal.
    forget?(definition: FunctionalityDefinitionSource, identity: WorkspaceCapabilityIdentity): Promise<void>;
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
    // {§mcp-launch-environment} What a module's subprocess inherits: the operator's environment
    // without plurnk's own secrets ({§exec-env-scoped}), not the model's command ceiling.
    operatorEnvironment(): NodeJS.ProcessEnv;
    // {§workspace-env} The workspace layer over admitted ambient values, or over a supplied
    // reference-resolution environment. Never includes worker overrides.
    readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§workspace-env} The same layers with the Worker's own overrides on top ({§functionality-scope}).
    readWorkerEnvironment(workspaceId: number, workerId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§module-workspace-directory} The host owns placement; the module owns the contents.
    workspaceStateDirectory(workspaceId: number, namespaceOwner: string): Promise<string>;
    registerModuleAction(registration: ModuleActionRegistration): void;
}

// {§module-functionality-adapter} — registers one family beneath the host's coordinator.
export interface FunctionalitySeam<Runtime = never, SchemeFacet = never> {
    registerFunctionalityAdapter(adapter: FunctionalityAdapter<Runtime, SchemeFacet>): FunctionalityFamilyHandle;
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

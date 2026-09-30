import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type {
    ApplicationActionContext,
    ApplicationActionDescriptor,
    FindStatement,
    KillStatement,
    SendStatement,
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
    WorkspaceCapabilityGate,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type {
    ProposalApplyRequest,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
    SchemeManifest,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import type { Executor } from "../core/ExecutorRegistry.ts";
import type { WorkspacePluginSet } from "./WorkspacePlugins.ts";

type ModuleActionScope = "worldless" | "workspace" | "worker";

export type ModuleActionContext = ApplicationActionContext;

type ModuleActionHandler = (
    params: Readonly<Record<string, unknown>>,
    context: ModuleActionContext,
) => unknown | Promise<unknown>;

export interface ModuleActionRegistration {
    readonly name: string;
    readonly scope: ModuleActionScope;
    readonly residency: "required" | "none";
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
    readonly handler: ModuleActionHandler;
}

export type ModuleActionDescriptor = ApplicationActionDescriptor;

// A module-owned executor may expose protocol resources under the same scheme
// name as its output streams. The facet claims only its own path subtree, and
// there it is the scheme's whole live half: every operation it implements is
// its own. Unclaimed coordinates retain the standard executor-output behavior.
export interface RuntimeSchemeFacet {
    claims(pathname: string): boolean;
    // The representation of the claimed resources where it is not the executor's own output
    // contract: whether the URI authority names the resource, their channels, and the one a
    // fragmentless address reads and a subscription publishes. `claims` always sees the authority
    // folded into the pathname.
    readonly manifest?: Partial<Pick<SchemeManifest, "authority" | "channels" | "defaultChannel">>;
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    // An operation the facet proposed is also the facet's to apply ({§http-outbound-proposes}).
    // Routed by the proposal's own `target`, the same claim that routed the operation itself, so
    // an executor-input proposal on an unclaimed coordinate still reaches the executor.
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<SchemeResult>;
}

export interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: Executor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: RuntimeSchemeFacet;
}

interface WorkspaceCapabilityContext extends WorkspaceCapabilityIdentity {
    retain(): () => void;
}

export interface WorkspaceCapabilityProvider {
    activate(context: WorkspaceCapabilityContext): void | Promise<void>;
    deactivate(identity: WorkspaceCapabilityIdentity): void | Promise<void>;
}

export interface WorkspaceCapabilityReplacement extends WorkspaceCapabilityIdentity {
    readonly namespaceOwner: string;
    readonly state: unknown | null;
    readonly runtimes: readonly RuntimeRegistration[];
}

// {§functionality-adapter} — one family of managed Functionality (Agent Skills,
// MCP servers, outbound A2A agents) beneath the shared workspace coordinator. The
// adapter owns protocol truth: definitions, inert discovery, admission,
// preparation, teardown, and any protocol continuation it registers as its own
// action. The coordinator owns lifecycle, durable state, serialization,
// publication, and both the client and model projections. The seam's shapes are
// declared once, in contracts; this is core's own face of it: the runtime
// registration a resident family prepares, and the scheme facet it may expose.
export interface FunctionalityAdapter {
    readonly scheme?: RuntimeSchemeFacet;
    // {§capability-admission} — general policy facts of the family's runtime and the resources its
    // scheme face serves (`web` for a family that reaches the network): what a capability policy selects on.
    readonly traits?: readonly string[];
    // The action segment (`workspace.<family>.<verb>`, or `worker.<family>.<verb>` for a
    // worker-scoped family) and the runtime family tag.
    readonly family: string;
    // {§functionality-scope} Supported owners; the first is the model default.
    // Absent means workspace. A worker layer inherits workspace defaults by reference.
    readonly scopes?: readonly ("workspace" | "worker")[];
    // The alias grammar the coordinator enforces for this family. Absent means the shared default
    // (`[a-z][a-z0-9-]*`, the shape skill names and MCP server ids already take); env declares the
    // shell's, because the alias IS the variable name and case is semantic there.
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
    // authored teaching beneath the family document's generated header, by the runtime doc-file rule.
    readonly docsDir?: string;
    available(identity: WorkspaceCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]>;
    discover(query: FunctionalityDiscoverQuery, identity: WorkspaceCapabilityIdentity, options?: FunctionalityOptions): Promise<readonly FunctionalityCandidate[]>;
    admit(input: unknown, identity: WorkspaceCapabilityIdentity, caller?: FunctionalityCaller, options?: FunctionalityOptions): Promise<FunctionalityDefinitionSource>;
    prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared<RuntimeRegistration>>;
    teardown(snapshot: unknown, identity: WorkspaceCapabilityIdentity): Promise<void>;
    // Release what the workspace definition installed or provisioned, before
    // the coordinator forgets it on `remove`; a failure rejects the removal.
    forget?(definition: FunctionalityDefinitionSource, identity: WorkspaceCapabilityIdentity): Promise<void>;
    // {§functionality-hotload} — republish when what `available` reads changed out of band; called
    // under the workspace turn gate before packet assembly.
    refreshIfChanged?(identity: WorkspaceCapabilityIdentity): Promise<void>;
}

export interface WorkspaceCapabilityPublication {
    readonly gate?: WorkspaceCapabilityGate;
    // Publish the coordinator's view in the same synchronous commit as the registries.
    // The returned undo runs before failed-publication document reconciliation.
    readonly publish?: () => () => void;
}

export interface ModuleSetupSeam {
    // {§agent-roots} Read-only configuration sources in highest-precedence-first order.
    workspaceConfigurationDirectories(workspaceId: number): Promise<readonly string[]>;
    // {§agent-plugins-hosting} The workspace's installed Agent Plugins, in root precedence order.
    readWorkspacePlugins(workspaceId: number): Promise<WorkspacePluginSet>;
    // {§mcp-launch-environment} What an MCP subprocess inherits: the operator's
    // environment without plurnk's own secrets ({§exec-env-scoped}), not the model's command ceiling.
    operatorEnvironment(): NodeJS.ProcessEnv;
    // {§workspace-env} Apply the workspace layer to admitted ambient values, or to
    // a provider's own reference-resolution environment. Never includes worker overrides.
    readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§module-workspace-directory} Core owns placement; modules own their contents.
    workspaceStateDirectory(workspaceId: number, namespaceOwner: string): Promise<string>;
    // {§workspace-env} The same layers with the Worker's own overrides on top ({§functionality-scope}):
    // what a command of that Worker runs under, for a family that reads the environment on a
    // Worker's behalf.
    readWorkerEnvironment(workspaceId: number, workerId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    registerRuntimes(registrations: readonly RuntimeRegistration[]): Promise<void>;
    registerScheme(name: string, handler: object): Promise<void>;
    registerModuleAction(registration: ModuleActionRegistration): void;
    registerWorkspaceCapabilityProvider(
        namespaceOwner: string,
        provider: WorkspaceCapabilityProvider,
    ): void;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkspaceCapabilities(replacement: WorkspaceCapabilityReplacement): Promise<void>;
    registerFunctionalityAdapter(adapter: FunctionalityAdapter): FunctionalityFamilyHandle;
}

export interface StartedModule {
    // {§module-shutdown-order} Producers settle before observers are released.
    stop?(): void | Promise<void>;
    close?(): void | Promise<void>;
}

export interface DaemonModule<StartSeam> extends StartedModule {
    // setup establishes every capability Core may demand during recovery.
    setup?(seam: ModuleSetupSeam): void | Promise<void>;
    // start opens exterior ingress only after durable recovery is complete.
    start?(seam: StartSeam): void | StartedModule | Promise<void | StartedModule>;
}

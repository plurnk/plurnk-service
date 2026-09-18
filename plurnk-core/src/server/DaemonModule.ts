import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type {
    ApplicationActionContext,
    ApplicationActionDescriptor,
    FindStatement,
    DispositionStatement,
    KillStatement,
    FunctionalityCandidate,
    FunctionalityDiscoverQuery,
    JsonSchema,
    ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type {
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import type { Executor } from "../core/ExecutorRegistry.ts";

type ModuleActionScope = "worldless" | "workspace" | "worker";

export type ModuleActionContext = ApplicationActionContext;

type ModuleActionHandler = (
    params: Readonly<Record<string, unknown>>,
    context: ModuleActionContext,
) => unknown | Promise<unknown>;

export interface ModuleActionRegistration {
    readonly name: string;
    readonly scope: ModuleActionScope;
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
    readonly handler: ModuleActionHandler;
}

export type ModuleActionDescriptor = ApplicationActionDescriptor;

// A module-owned executor may expose protocol resources under the same scheme
// name as its output streams. The facet claims only its own path subtree;
// unclaimed coordinates retain the standard executor-output behavior.
export interface RuntimeSchemeFacet {
    claims(pathname: string): boolean;
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    wait?(statement: DispositionStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}

export interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: Executor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: RuntimeSchemeFacet;
}

export interface WorkspaceCapabilityIdentity {
    readonly workspaceId: number;
}

// {§functionality-scope} — the identity a verb acts under. Every invocation names the workspace; one
// that arrives through a Worker (a worker-scoped client action, or any execution) also names
// that Worker, which a worker-scoped family acts for. Adapters keep seeing the workspace identity.
export interface FunctionalityIdentity extends WorkspaceCapabilityIdentity {
    readonly workerId?: number;
    readonly scope?: "workspace" | "worker";
}

export interface FunctionalityOptions {
    readonly env?: Readonly<Record<string, string>>;
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
// publication, and both the client and model projections.
type FunctionalityAlias = string;

// Who invoked a verb: a client action, or the model's execution ({§functionality-model-projection}).
// A family may bound the model's authority ({§members-model-scope}) without a second grammar.
export type FunctionalityCaller = "action" | "operation";

export interface FunctionalityDefinitionSource {
    readonly alias: FunctionalityAlias;
    readonly definition: object;
}

// A service- or configuration-contributed definition with its default
// enabledness; a workspace's durable state may override the enabledness only.
export interface FunctionalityServiceDefinition extends FunctionalityDefinitionSource {
    readonly enabled: boolean;
}

export type FunctionalityOutcome =
    | { readonly state: "active"; readonly detail?: object }
    | { readonly state: "unavailable"; readonly problem: ProblemDetails }
    | { readonly state: "authorization-required"; readonly authorization: { readonly url: string } };

interface FunctionalityDocument {
    // Relative to the Worker's generated subtree root; the coordinator prefixes
    // `worker:///_plurnk/`.
    readonly pathname: string;
    readonly content: string;
}

export interface FunctionalityPreparation {
    readonly workspaceId: number;
    // The enabled definitions to prepare, in alias order.
    readonly enabled: ReadonlyMap<FunctionalityAlias, object>;
    // The adapter's previous process snapshot for this workspace, when one exists.
    readonly previous: unknown | null;
    // Whether failures publish as unavailable outcomes (activation, model
    // mutations) or reject the mutation (explicit client mutations).
    readonly failure: "publish-unavailable" | "reject";
    // An alias whose preparation must be retried even when its definition is
    // unchanged (re-enabling an unavailable definition).
    readonly force?: string;
    retain(): () => void;
}

// A two-phase preparation. The coordinator publishes the runtimes and state
// atomically, then calls `commit` (the adapter adopts the new snapshot and
// releases what it no longer uses) or `abort` (the adapter discards this
// attempt and the previous snapshot stays authoritative). The coordinator never
// tears down a previous snapshot itself; only deactivation calls `teardown`.
export interface FunctionalityPrepared {
    // {§module-workspace-residency} — the resident facet. Only a family that holds processes
    // (MCP servers) prepares runtimes; every other family publishes its manager, documents and
    // state alone, and leaves this absent.
    readonly runtimes?: readonly RuntimeRegistration[];
    readonly documents: readonly FunctionalityDocument[];
    readonly outcomes: ReadonlyMap<FunctionalityAlias, FunctionalityOutcome>;
    readonly snapshot: unknown;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

export interface FunctionalityAdapter {
    readonly scheme?: RuntimeSchemeFacet;
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
    prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared>;
    teardown(snapshot: unknown, identity: WorkspaceCapabilityIdentity): Promise<void>;
    // Release what the workspace definition installed or provisioned, before
    // the coordinator forgets it on `remove`; a failure rejects the removal.
    forget?(definition: FunctionalityDefinitionSource, identity: WorkspaceCapabilityIdentity): Promise<void>;
}

// The coordinator's re-entry surface for one registered family: a protocol
// continuation (an OAuth completion) re-enables its alias, and a live catalog
// change republishes the unchanged state through the same publication path.
export interface FunctionalityFamilyHandle {
    invoke(
        verb: "list" | "discover" | "add" | "enable" | "disable" | "remove",
        params: unknown,
        identity: FunctionalityIdentity,
    ): Promise<{ readonly status: number; readonly body: unknown }>;
    refresh(identity: WorkspaceCapabilityIdentity, options?: { readonly gate?: WorkspaceCapabilityGate }): Promise<void>;
}

// How a capability replacement meets the workspace gate: `try` fails 409 while
// the workspace is held (an explicit client mutation), `wait` queues behind the
// holder (a Worker's own accepted mutation), `none` publishes inside the gate
// context its demand already holds (activation, turn-admission refresh).
export type WorkspaceCapabilityGate = "none" | "try" | "wait";

export interface WorkspaceCapabilityPublication {
    readonly gate?: WorkspaceCapabilityGate;
    // Publish the coordinator's view in the same synchronous commit as the registries.
    // The returned undo runs before failed-publication document reconciliation.
    readonly publish?: () => () => void;
}

export interface ModuleSetupSeam {
    awaitedEvents(scheme: string): import("@plurnk/plurnk-schemes").AwaitedEventProducer;
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
    close(): void | Promise<void>;
}

export interface DaemonModule<StartSeam> {
    close?(): void | Promise<void>;
    // setup establishes every capability Core may demand during recovery.
    setup?(seam: ModuleSetupSeam): void | Promise<void>;
    // start opens exterior ingress only after durable recovery is complete.
    start?(seam: StartSeam): void | StartedModule | Promise<void | StartedModule>;
}

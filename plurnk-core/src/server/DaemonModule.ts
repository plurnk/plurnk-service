import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type {
    ApplicationActionContext,
    ApplicationActionDescriptor,
    FindStatement,
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

export type ModuleActionScope = "worldless" | "workspace" | "worker";

export type ModuleActionContext = ApplicationActionContext;

export type ModuleActionHandler = (
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
}

export interface RuntimeRegistration {
    readonly namespaceOwner: string;
    readonly decl: RuntimeDecl;
    readonly executor: Executor;
    readonly availability: RuntimeAvailability;
    readonly scheme?: RuntimeSchemeFacet;
}

export interface WorkerCapabilityIdentity {
    readonly workspaceId: number;
    readonly workerId: number;
}

export interface WorkerCapabilityContext extends WorkerCapabilityIdentity {
    retain(): () => void;
}

export interface WorkerCapabilityProvider {
    activate(context: WorkerCapabilityContext): void | Promise<void>;
    deactivate(identity: WorkerCapabilityIdentity): void | Promise<void>;
}

export interface WorkerCapabilityReplacement extends WorkerCapabilityIdentity {
    readonly namespaceOwner: string;
    readonly state: unknown | null;
    readonly runtimes: readonly RuntimeRegistration[];
}

// {§functionality-adapter} — one family of managed Functionality (Agent Skills,
// MCP servers, outbound A2A agents) beneath the shared Worker coordinator. The
// adapter owns protocol truth: definitions, inert discovery, admission,
// preparation, teardown, and any protocol continuation it registers as its own
// action. The coordinator owns lifecycle, durable state, serialization,
// publication, and both the client and model projections.
export type FunctionalityAlias = string;

export interface FunctionalityDefinitionSource {
    readonly alias: FunctionalityAlias;
    readonly definition: object;
}

// A service- or configuration-contributed definition with its default
// enabledness; a Worker's durable state may override the enabledness only.
export interface FunctionalityServiceDefinition extends FunctionalityDefinitionSource {
    readonly enabled: boolean;
}

export type FunctionalityOutcome =
    | { readonly state: "active"; readonly detail?: object }
    | { readonly state: "unavailable"; readonly problem: ProblemDetails }
    | { readonly state: "authorization-required"; readonly authorization: { readonly url: string } };

export interface FunctionalityDocument {
    // Relative to the Worker's generated subtree root; the coordinator prefixes
    // `worker://~/_plurnk/`.
    readonly pathname: string;
    readonly content: string;
}

export interface FunctionalityPreparation {
    readonly workspaceId: number;
    readonly workerId: number;
    // The enabled definitions to prepare, in alias order.
    readonly enabled: ReadonlyMap<FunctionalityAlias, object>;
    // The adapter's previous process snapshot for this Worker, when one exists.
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
    readonly runtimes: readonly RuntimeRegistration[];
    readonly documents: readonly FunctionalityDocument[];
    readonly outcomes: ReadonlyMap<FunctionalityAlias, FunctionalityOutcome>;
    readonly snapshot: unknown;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

export interface FunctionalityAdapter {
    // The action segment (`worker.<family>.<verb>`) and the EXEC family tag.
    readonly family: string;
    // The one publication owner for this family's runtimes and state.
    readonly namespaceOwner: string;
    readonly summary: string;
    // The exact definition one `add` accepts and the coordinator persists.
    readonly definitionSchema: JsonSchema;
    available(identity: WorkerCapabilityIdentity): Promise<readonly FunctionalityServiceDefinition[]>;
    discover(query: FunctionalityDiscoverQuery, identity: WorkerCapabilityIdentity): Promise<readonly FunctionalityCandidate[]>;
    admit(input: unknown, identity: WorkerCapabilityIdentity): Promise<FunctionalityDefinitionSource>;
    prepare(preparation: FunctionalityPreparation): Promise<FunctionalityPrepared>;
    teardown(snapshot: unknown, identity: WorkerCapabilityIdentity): Promise<void>;
    // Release what the Worker's own definition installed or provisioned, before
    // the coordinator forgets it on `remove`; a failure rejects the removal.
    forget?(definition: FunctionalityDefinitionSource, identity: WorkerCapabilityIdentity): Promise<void>;
}

// The coordinator's re-entry surface for one registered family: a protocol
// continuation (an OAuth completion) re-enables its alias, and a live catalog
// change republishes the unchanged state through the same publication path.
export interface FunctionalityFamilyHandle {
    invoke(
        verb: "list" | "discover" | "add" | "enable" | "disable" | "remove",
        params: unknown,
        identity: WorkerCapabilityIdentity,
    ): Promise<{ readonly status: number; readonly body: unknown }>;
    refresh(identity: WorkerCapabilityIdentity, options?: { readonly gate?: WorkerCapabilityGate }): Promise<void>;
}

// How a capability replacement meets the workspace gate: `try` fails 409 while
// the workspace is held (an explicit client mutation), `wait` queues behind the
// holder (a Worker's own accepted mutation), `none` publishes inside the gate
// context its demand already holds (activation, turn-admission refresh).
export type WorkerCapabilityGate = "none" | "try" | "wait";

export interface ModuleSetupSeam {
    registerRuntimes(registrations: readonly RuntimeRegistration[]): Promise<void>;
    registerScheme(name: string, handler: object): Promise<void>;
    registerModuleAction(registration: ModuleActionRegistration): void;
    registerWorkerCapabilityProvider(
        namespaceOwner: string,
        provider: WorkerCapabilityProvider,
    ): void;
    readWorkerModuleState(workerId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkerCapabilities(replacement: WorkerCapabilityReplacement): Promise<void>;
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

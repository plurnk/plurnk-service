import type { RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type {
    ApplicationActionContext,
    ApplicationActionDescriptor,
    FindStatement,
    JsonSchema,
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

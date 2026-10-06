// {§functionality-adapter} — the seam between the workspace Functionality coordinator (core) and
// a family adapter (a module). Declared once here because a module never imports core: every
// package that meets the seam imports these shapes rather than restating them (#884).
import type { FunctionalityProvenance, ProblemDetails } from "./types.ts";

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

// Who invoked a verb: a client action, or the model's execution ({§functionality-model-projection}).
// A family may bound the model's authority ({§members-model-scope}) without a second grammar.
export type FunctionalityCaller = "action" | "operation";

export interface FunctionalityDefinitionSource {
    readonly alias: string;
    readonly definition: object;
}

// A service- or configuration-contributed definition with its default
// enabledness; a workspace's durable state may override the enabledness only.
export interface FunctionalityServiceDefinition extends FunctionalityDefinitionSource {
    readonly enabled: boolean;
    readonly provenance?: FunctionalityProvenance;
    // Source-specific interpretation, owned by the adapter; never persisted as a local definition.
    readonly context?: object;
}

export interface FunctionalityPreparedDefinition {
    readonly definition: object;
    readonly context?: object;
}

export type FunctionalityOutcome =
    | { readonly state: "active"; readonly detail?: object }
    | { readonly state: "unavailable"; readonly problem: ProblemDetails }
    | { readonly state: "authorization-required"; readonly authorization: { readonly url?: string } };

export interface FunctionalityDocument {
    // Relative to the Worker's generated subtree root; the coordinator prefixes
    // `worker:///_plurnk/`.
    readonly pathname: string;
    readonly content: string;
}

export interface FunctionalityPreparation extends WorkspaceCapabilityIdentity {
    // The enabled definitions to prepare, in alias order.
    readonly enabled: ReadonlyMap<string, FunctionalityPreparedDefinition>;
    // The adapter's previous process snapshot for this workspace, when one exists.
    readonly previous: unknown | null;
    // Whether failures publish as unavailable outcomes (activation, model
    // mutations) or reject the mutation (explicit client mutations).
    readonly failure: "publish-unavailable" | "reject";
    // An alias whose preparation must be retried even when its definition is
    // unchanged (re-enabling an unavailable definition).
    readonly force?: string;
    // {§functionality-preparation-visibility} Report the enabled alias currently being prepared.
    // This never publishes a capability or changes its outcome.
    progress(alias: string): void;
    retain(): () => void;
}

// A two-phase preparation. The coordinator publishes the runtimes and state
// atomically, then calls `commit` (the adapter adopts the new snapshot and
// releases what it no longer uses) or `abort` (the adapter discards this
// attempt and the previous snapshot stays authoritative). The coordinator never
// tears down a previous snapshot itself; only deactivation calls `teardown`.
export interface FunctionalityPrepared<Runtime = never> {
    // {§module-workspace-residency} — the resident facet. Only a family that holds processes
    // (MCP servers) prepares runtimes; every other family publishes its manager, documents and
    // state alone, and leaves this absent. The runtime registration is the executor family's
    // ({§executor-module-slice}); a family that prepares runtimes names it here.
    readonly runtimes?: readonly Runtime[];
    readonly documents: readonly FunctionalityDocument[];
    readonly outcomes: ReadonlyMap<string, FunctionalityOutcome>;
    readonly snapshot: unknown;
    commit(): Promise<void>;
    abort(): Promise<void>;
}

// How a capability replacement meets the workspace gate: `try` fails 409 while
// the workspace is held (an explicit client mutation), `wait` queues behind the
// holder (a Worker's own accepted mutation), `none` publishes inside the gate
// context its demand already holds (activation, turn-admission refresh).
export type WorkspaceCapabilityGate = "none" | "try" | "wait";

// The coordinator's re-entry surface for one registered family: a protocol
// continuation (an OAuth completion) re-enables its alias, and a live catalog
// change republishes the unchanged state through the same publication path.
export interface FunctionalityFamilyHandle {
    invoke(
        verb: "list" | "discover" | "add" | "enable" | "disable" | "remove",
        params: unknown,
        identity: FunctionalityIdentity,
    ): Promise<{ readonly status: number; readonly body: unknown }>;
    // Republish the resident family; `ifChanged` only when its enabled definitions differ from the ones
    // the resident publication prepared ({§functionality-hotload}).
    refresh(
        identity: WorkspaceCapabilityIdentity,
        options?: { readonly gate?: WorkspaceCapabilityGate; readonly ifChanged?: boolean },
    ): Promise<void>;
}

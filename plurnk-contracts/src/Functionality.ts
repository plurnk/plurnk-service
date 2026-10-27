// {§functionality-adapter} — the seam between the workspace Functionality coordinator (core) and
// a family adapter (a module). Declared once here because a module never imports core: every
// package that meets the seam imports these shapes rather than restating them (#884).
import type { FunctionalityDiscoverQuery, FunctionalityProvenance, ProblemDetails } from "./types.ts";

export interface WorkspaceCapabilityIdentity {
    readonly workspaceId: number;
}

// {§functionality-coordinator} — the identity a verb acts under. Every invocation names the workspace; one
// that arrives through a Session (a session-scoped client action, or any execution) also names
// that Session, which a session-scoped family acts for. Adapters keep seeing the workspace identity.
export interface FunctionalityIdentity extends WorkspaceCapabilityIdentity {
    readonly sessionId?: number;
    readonly scope?: "workspace" | "session";
}

// {§functionality-discovery-inputs} — one input of the shared discovery query a family may serve.
export type FunctionalityDiscoverInput = keyof FunctionalityDiscoverQuery;

// Who invoked a verb: a client action, or the model's execution ({§functionality-model-projection}).
// A family may bound the model's authority ({§members-model-scope}) without a second grammar.
export type FunctionalityCaller = "action" | "operation";

// `Definition` is the definition a family's `definitionSchema` admits ({§functionality-adapter}); the
// coordinator's own view is any object.
export interface FunctionalityDefinitionSource<Definition extends object = object> {
    readonly alias: string;
    readonly definition: Definition;
}

export interface FunctionalityAdmission<Definition extends object = object> extends FunctionalityDefinitionSource<Definition> {
    // Attempt-local data carried to prepare, never persisted or used as definition identity.
    readonly preparation?: unknown;
}

// A service- or configuration-contributed definition with its default
// enabledness; a workspace's durable state may override the enabledness only.
export interface FunctionalityServiceDefinition<Definition extends object = object> extends FunctionalityDefinitionSource<Definition> {
    readonly enabled: boolean;
    readonly provenance?: FunctionalityProvenance;
    // Source-specific interpretation, owned by the adapter; never persisted as a local definition.
    readonly context?: object;
}

export interface FunctionalityPreparedDefinition<Definition extends object = object> {
    readonly definition: Definition;
    readonly context?: object;
}

export type FunctionalityOutcome =
    | { readonly state: "active"; readonly detail?: object }
    | { readonly state: "unavailable"; readonly problem: ProblemDetails }
    | { readonly state: "authorization-required"; readonly authorization: { readonly url?: string } };

export interface FunctionalityDocument {
    // Relative to the Session's generated subtree root; the coordinator prefixes
    // `workspace:///_plurnk/`.
    readonly pathname: string;
    readonly content: string;
}

// `Definition` and `Snapshot` are the family's own ({§functionality-adapter}).
export interface FunctionalityPreparation<Definition extends object = object, Snapshot = unknown> extends WorkspaceCapabilityIdentity {
    // {§functionality-preparation-cancellation} The host's lifetime; cancellation still joins cleanup.
    readonly signal: AbortSignal;
    // The enabled definitions to prepare, in alias order.
    readonly enabled: ReadonlyMap<string, FunctionalityPreparedDefinition<Definition>>;
    // The adapter's previous snapshot for this workspace, when one exists.
    readonly previous: Snapshot | null;
    // The current add or replace's admissions: one, or every definition an addressing family's add
    // names ({§functionality-replacement}); empty on refresh, activation and other verbs.
    readonly admissions: readonly FunctionalityAdmission<Definition>[];
    // Whether failures publish as unavailable outcomes (activation, model
    // mutations except replacement) or reject it (explicit client mutations and replacement).
    readonly failure: "publish-unavailable" | "reject";
    // An alias whose preparation must be retried even when its definition is
    // unchanged (re-enabling an unavailable definition).
    readonly force?: string;
    // {§functionality-inspection} Report the enabled aliases being prepared now: each stays
    // listed, with the time it began, until a later report omits it. A family that prepares one alias at
    // a time reports one. This never publishes a capability or changes its outcome.
    progress(aliases: readonly string[]): void;
    readonly retain: () => () => void;
}

// A two-phase preparation. The coordinator publishes the runtimes and state
// atomically, then calls `commit` (the adapter adopts the new snapshot and
// releases what it no longer uses) or `abort` (the adapter discards this
// attempt and the previous snapshot stays authoritative). The coordinator never
// tears down a previous snapshot itself; only deactivation calls `teardown`.
export interface FunctionalityPrepared<Runtime = never, Snapshot = unknown> {
    // {§module-workspace-residency} — the resident facet. Only a family that holds processes
    // (MCP servers) prepares runtimes; every other family publishes its manager, documents and
    // state alone, and leaves this absent. The runtime registration is the exec kind's
    // ({§executor-module-slice}); a family that prepares runtimes names it here.
    readonly runtimes?: readonly Runtime[];
    readonly documents: readonly FunctionalityDocument[];
    readonly outcomes: ReadonlyMap<string, FunctionalityOutcome>;
    readonly snapshot: Snapshot;
    // {§functionality-coordinator} — candidate state goes live here, synchronously and without
    // I/O, inside the coordinator's registry commit; the returned undo restores the preceding
    // live state if that commit rolls back.
    publish(): (() => void) | undefined;
    // Post-publication settlement: the I/O the published state entails. Never runs for an
    // unpublished candidate.
    commit(): Promise<void>;
    // Discard an unpublished candidate and its resources.
    abort(): Promise<void>;
}

// How a capability replacement meets the workspace gate: `try` fails 409 while
// the workspace is held (an explicit client mutation), `wait` queues behind the
// holder (a Session's own accepted mutation), `none` publishes inside the gate
// context its demand already holds (activation, turn-admission refresh).
export type WorkspaceCapabilityGate = "none" | "try" | "wait";

// The coordinator's re-entry surface for one registered family: a protocol
// continuation (an OAuth completion) re-enables its alias, and a live catalog
// change republishes the unchanged state through the same publication path.
export interface FunctionalityFamilyHandle {
    invoke(
        verb: "list" | "discover" | "add" | "replace" | "enable" | "disable" | "remove",
        params: unknown,
        identity: FunctionalityIdentity,
    ): Promise<{ readonly status: number; readonly body: unknown }>;
    // Republish the resident family; `ifChanged` only when its enabled definitions differ from the ones
    // the resident publication prepared ({§functionality-inspection}).
    refresh(
        identity: WorkspaceCapabilityIdentity,
        options?: { readonly gate?: WorkspaceCapabilityGate; readonly ifChanged?: boolean },
    ): Promise<void>;
}

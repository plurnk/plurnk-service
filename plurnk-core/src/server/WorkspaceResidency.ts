import type Engine from "../core/Engine.ts";
import type WorkspaceGate from "../core/WorkspaceGate.ts";
import type { Db } from "../core/Db.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import ClientInput from "./client-input.ts";
import LoopDocs from "./loopDocs.ts";
import WorkspaceCapabilities, {
    workspaceCapabilityPolicy,
    type WorkspaceCapabilityRelease,
} from "./WorkspaceCapabilities.ts";
import type {
    RuntimeRegistration,
    WorkspaceCapabilityPublication,
    WorkspaceCapabilityIdentity,
    WorkspaceCapabilityGate,
    WorkspaceCapabilityProvider,
    WorkspaceCapabilityReplacement,
} from "./DaemonModule.ts";

const residencyFailure = (
    code: string, status: number, detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("daemon:workspace-functionality", code, status, detail, {}, extensions),
);

type NormalizedRuntime = {
    tag: string;
    entry: RegistryEntry;
    scheme: RuntimeRegistration["scheme"];
};

// {§module-workspace-residency} {§module-workspace-quiescence}
export default class WorkspaceResidency {
    readonly #db: Db;
    readonly #engine: () => Engine;
    readonly #workspaceGate: WorkspaceGate;
    readonly #normalizeRuntime: (registration: RuntimeRegistration) => NormalizedRuntime;
    readonly #providers = new Map<string, WorkspaceCapabilityProvider>();
    readonly #capabilities: WorkspaceCapabilities;
    #published = false;

    constructor({ db, engine, workspaceGate, normalizeRuntime }: {
        db: Db;
        engine: () => Engine;
        workspaceGate: WorkspaceGate;
        normalizeRuntime: (registration: RuntimeRegistration) => NormalizedRuntime;
    }) {
        this.#db = db;
        this.#engine = engine;
        this.#workspaceGate = workspaceGate;
        this.#normalizeRuntime = normalizeRuntime;
        this.#capabilities = new WorkspaceCapabilities(workspaceCapabilityPolicy(), {
            activate: (workspaceId) => this.#activate(workspaceId),
            deactivate: (workspaceId) => this.#deactivate(workspaceId),
            report: (workspaceId, error) => {
                console.error(`Workspace ${workspaceId} Functionality cooling failed:`, error);
            },
        });
    }

    get published(): boolean { return this.#published; }
    publish(): void { this.#published = true; }
    beginStop(): void { this.#capabilities.beginStop(); }
    activeWorkspaceIds(): number[] { return this.#capabilities.activeWorkspaceIds(); }
    isActive(workspaceId: number): boolean { return this.#capabilities.isActive(workspaceId); }
    retain(workspaceId: number): WorkspaceCapabilityRelease { return this.#capabilities.retain(workspaceId); }

    registerProvider(namespaceOwner: string, provider: WorkspaceCapabilityProvider): void {
        if (namespaceOwner.trim().length === 0) throw new Error("workspace Functionality provider requires a non-empty namespace owner");
        if (typeof provider?.activate !== "function" || typeof provider?.deactivate !== "function") {
            throw new Error("workspace Functionality provider requires activate and deactivate functions");
        }
        if (this.#providers.has(namespaceOwner)) throw new Error(`workspace Functionality provider '${namespaceOwner}' is already registered`);
        this.#providers.set(namespaceOwner, provider);
    }

    async identity(workspaceId: number): Promise<WorkspaceCapabilityIdentity> {
        const id = ClientInput.assertId("workspace Functionality", "workspaceId", workspaceId);
        const workspace = await this.#db.envelope_get_workspace.get({ id });
        if (workspace === undefined) throw residencyFailure(
            "workspace-not-found", 404, `Workspace ${id} does not exist.`,
            { workspaceId: id, retryable: false },
        );
        return { workspaceId: id };
    }

    async acquire(workspaceId: number): Promise<WorkspaceCapabilityRelease> {
        const identity = await this.identity(workspaceId);
        return this.#capabilities.acquire(identity.workspaceId);
    }

    async #activate(workspaceId: number): Promise<void> {
        const identity = await this.identity(workspaceId);
        try {
            const context = { ...identity, retain: () => this.#capabilities.retain(workspaceId) };
            for (const provider of this.#providers.values()) await provider.activate(context);
            await this.#rematerialize(workspaceId);
        } catch (cause) {
            try {
                // Activation is not yet observable, and its demand may already hold the turn gate.
                await this.#dispose(identity);
            } catch (cleanupCause) {
                throw new AggregateError([cause, cleanupCause], `Workspace ${workspaceId} Functionality activation and cleanup failed`);
            }
            throw cause;
        }
    }

    async #deactivate(workspaceId: number): Promise<boolean> {
        const gate = this.#workspaceGate.tryExclusive(workspaceId);
        if (gate === null) return false;
        try {
            await gate.acquired;
            await this.#dispose({ workspaceId });
            return true;
        } finally {
            gate.release();
        }
    }

    async #dispose(identity: WorkspaceCapabilityIdentity): Promise<void> {
        const prepared = [];
        for (const namespaceOwner of this.#providers.keys()) {
            prepared.push(await this.#engine().prepareWorkspaceRuntimes(identity.workspaceId, namespaceOwner, []));
        }
        const deactivations = await Promise.allSettled(
            [...this.#providers.values()].toReversed()
                .map((provider) => Promise.resolve().then(() => provider.deactivate(identity))),
        );
        const errors = deactivations.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (errors.length > 0) throw new AggregateError(errors, `Workspace ${identity.workspaceId} Functionality provider deactivation failed`);
        for (const commit of prepared) commit();
        LoopDocs.evict(this.#db, identity.workspaceId);
    }

    async readModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null> {
        const identity = await this.identity(workspaceId);
        if (namespaceOwner.trim().length === 0) throw new Error("workspace module state requires a non-empty namespace owner");
        const row = await this.#db.workspace_module_state_get.get<{ state: string }>({
            workspace_id: identity.workspaceId, namespace_owner: namespaceOwner,
        });
        return row === undefined ? null : JSON.parse(row.state) as unknown;
    }

    async reconcile(workspaceId: number): Promise<void> {
        await LoopDocs.materialize(this.#engine(), this.#db, workspaceId);
    }

    async #rematerialize(workspaceId: number): Promise<void> {
        if (!this.#published) return;
        await LoopDocs.materialize(this.#engine(), this.#db, workspaceId);
    }

    async rematerializeActive(): Promise<void> {
        for (const workspaceId of this.#capabilities.activeWorkspaceIds()) await this.#rematerialize(workspaceId);
    }

    async replace({
        workspaceId, namespaceOwner, state, runtimes,
    }: WorkspaceCapabilityReplacement, options: WorkspaceCapabilityPublication = {}): Promise<void> {
        await this.identity(workspaceId);
        if (namespaceOwner.trim().length === 0) throw new Error("workspace Functionality replacement requires a non-empty namespace owner");
        const encoded = state === null ? null : JSON.stringify(state);
        if (encoded === undefined) throw residencyFailure(
            "state-not-json", 400, "Workspace module state is not JSON-serializable.",
            { namespaceOwner, retryable: false },
        );
        if (encoded !== null) JSON.parse(encoded);
        const normalized = runtimes.map((registration) => {
            if (registration.namespaceOwner !== namespaceOwner) {
                throw new Error(`workspace runtime owner '${registration.namespaceOwner}' does not match '${namespaceOwner}'`);
            }
            return this.#normalizeRuntime(registration);
        });
        await this.exclusively(workspaceId, namespaceOwner, options.gate ?? "try", async () => {
            let rollbackRuntimes: (() => void) | undefined;
            let rollbackPublication: (() => void) | undefined;
            let stateChanged = false;
            const key = { workspace_id: workspaceId, namespace_owner: namespaceOwner };
            let prior: { state: string } | undefined;
            try {
                prior = await this.#db.workspace_module_state_get.get<{ state: string }>(key);
                const commitRuntimes = await this.#engine().prepareWorkspaceRuntimes(workspaceId, namespaceOwner, normalized);
                if (encoded === null) await this.#db.workspace_module_state_delete.run(key);
                else await this.#db.workspace_module_state_put.run({ ...key, state: encoded });
                stateChanged = true;
                rollbackRuntimes = commitRuntimes();
                rollbackPublication = options.publish?.();
                await this.#rematerialize(workspaceId);
            } catch (cause) {
                rollbackPublication?.();
                rollbackRuntimes?.();
                const rollbackErrors: unknown[] = [];
                if (stateChanged) {
                    try {
                        if (prior === undefined) await this.#db.workspace_module_state_delete.run(key);
                        else await this.#db.workspace_module_state_put.run({ ...key, state: prior.state });
                    } catch (rollbackCause) { rollbackErrors.push(rollbackCause); }
                    try { await this.#rematerialize(workspaceId); }
                    catch (rollbackCause) { rollbackErrors.push(rollbackCause); }
                }
                if (rollbackErrors.length > 0) {
                    throw new AggregateError([cause, ...rollbackErrors], "Workspace Functionality replacement and rollback failed");
                }
                throw cause;
            }
        });
    }

    async exclusively<T>(workspaceId: number, namespaceOwner: string, mode: WorkspaceCapabilityGate, run: () => Promise<T>): Promise<T> {
        await this.identity(workspaceId);
        const gate = mode === "none" ? undefined : mode === "wait"
            ? this.#workspaceGate.requestExclusive(workspaceId)
            : this.#workspaceGate.tryExclusive(workspaceId);
        if (gate === null) throw residencyFailure(
            "workspace-busy", 409,
            `Workspace ${workspaceId} is running an operation or another capability change.`,
            { workspaceId, namespaceOwner, recovery: "Settle the current operation and retry the capability change.", retryable: true },
        );
        try {
            await gate?.acquired;
            return await run();
        } finally {
            gate?.release();
        }
    }
}

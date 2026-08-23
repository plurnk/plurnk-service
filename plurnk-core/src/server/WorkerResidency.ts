// {§module-worker-residency} {§module-worker-quiescence} — the one owner of
// Worker Functionality residency: demand-driven acquisition, provider
// activation and cooling, capability replacement under the workspace gate, and
// the generated-document reconciliation those transitions trigger. The Daemon
// remains the composition root and ApplicationPort; it delegates here and owns
// none of these internals ({§module-lifecycle}).
import type Engine from "../core/Engine.ts";
import type WorkspaceGate from "../core/WorkspaceGate.ts";
import type { Db } from "../core/Db.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import ClientInput from "./client-input.ts";
import LoopDocs from "./loopDocs.ts";
import WorkerCapabilities, {
    workerCapabilityPolicy,
    type WorkerCapabilityRelease,
} from "./WorkerCapabilities.ts";
import type {
    RuntimeRegistration,
    WorkerCapabilityGate,
    WorkerCapabilityProvider,
    WorkerCapabilityReplacement,
} from "./DaemonModule.ts";

const residencyFailure = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("daemon:worker-functionality", code, status, detail, {}, extensions),
);

type NormalizedRuntime = {
    tag: string;
    entry: RegistryEntry;
    scheme: RuntimeRegistration["scheme"];
};

export default class WorkerResidency {
    readonly #db: Db;
    // Lazy: the composition root constructs the Engine after residency.
    readonly #engine: () => Engine;
    readonly #workspaceGate: WorkspaceGate;
    readonly #normalizeRuntime: (registration: RuntimeRegistration) => NormalizedRuntime;
    readonly #providers = new Map<string, WorkerCapabilityProvider>();
    readonly #capabilities: WorkerCapabilities;
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
        this.#capabilities = new WorkerCapabilities(
            workerCapabilityPolicy(),
            {
                activate: (workerId) => this.#activate(workerId),
                deactivate: (workerId) => this.#deactivate(workerId),
                report: (workerId, error) => {
                    console.error(`Worker ${workerId} Functionality cooling failed:`, error);
                },
            },
        );
    }

    // Publication marks the boot boundary after which registrations reconcile
    // documents for already-active Workers.
    get published(): boolean {
        return this.#published;
    }

    publish(): void {
        this.#published = true;
    }

    beginStop(): void {
        this.#capabilities.beginStop();
    }

    activeWorkerIds(): number[] {
        return this.#capabilities.activeWorkerIds();
    }

    isActive(workerId: number): boolean {
        return this.#capabilities.isActive(workerId);
    }

    retain(workerId: number): WorkerCapabilityRelease {
        return this.#capabilities.retain(workerId);
    }

    registerProvider(namespaceOwner: string, provider: WorkerCapabilityProvider): void {
        if (namespaceOwner.trim().length === 0) {
            throw new Error("worker Functionality provider requires a non-empty namespace owner");
        }
        if (
            typeof provider?.activate !== "function"
            || typeof provider?.deactivate !== "function"
        ) {
            throw new Error("worker Functionality provider requires activate and deactivate functions");
        }
        if (this.#providers.has(namespaceOwner)) {
            throw new Error(`worker Functionality provider '${namespaceOwner}' is already registered`);
        }
        this.#providers.set(namespaceOwner, provider);
    }

    async identity(workerId: number): Promise<{ workspaceId: number; workerId: number }> {
        const worker = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (worker === undefined) {
            throw residencyFailure(
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId, retryable: false },
            );
        }
        return { workspaceId: worker.workspace_id, workerId };
    }

    // {§module-worker-residency} — demand acquires residency for the duration
    // of one operation or action; idle residency cools by policy.
    async acquire(workspaceId: number, workerId: number): Promise<WorkerCapabilityRelease> {
        const checkedWorkspaceId = ClientInput.assertId(
            "worker Functionality residency",
            "workspaceId",
            workspaceId,
        );
        const checkedWorkerId = ClientInput.assertId(
            "worker Functionality residency",
            "workerId",
            workerId,
        );
        const worker = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: checkedWorkerId });
        if (worker?.workspace_id !== checkedWorkspaceId) {
            throw residencyFailure(
                "worker-not-found",
                404,
                `Worker ${checkedWorkerId} does not exist in workspace ${checkedWorkspaceId}.`,
                { workspaceId: checkedWorkspaceId, workerId: checkedWorkerId, retryable: false },
            );
        }
        return this.#capabilities.acquire(checkedWorkerId);
    }

    async #activate(workerId: number): Promise<void> {
        const identity = await this.identity(workerId);
        const { workspaceId } = identity;
        try {
            const context = {
                ...identity,
                retain: () => this.#capabilities.retain(workerId),
            };
            for (const provider of this.#providers.values()) {
                await provider.activate(context);
            }
            await LoopDocs.materialize(this.#engine(), this.#db, workspaceId, workerId);
        } catch (cause) {
            const cleanupErrors: unknown[] = [];
            try {
                await this.#deactivate(workerId, true);
            } catch (cleanupCause) {
                cleanupErrors.push(cleanupCause);
            }
            if (cleanupErrors.length > 0) {
                throw new AggregateError(
                    [cause, ...cleanupErrors],
                    `Worker ${workerId} Functionality activation and cleanup failed`,
                );
            }
            throw cause;
        }
    }

    async #deactivate(
        workerId: number,
        waitForGate = false,
    ): Promise<boolean> {
        const identity = await this.identity(workerId);
        const { workspaceId } = identity;
        const gate = waitForGate
            ? this.#workspaceGate.requestExclusive(workspaceId)
            : this.#workspaceGate.tryExclusive(workspaceId);
        if (gate === null) return false;
        await gate.acquired;
        try {
            const prepared = [];
            for (const namespaceOwner of this.#providers.keys()) {
                prepared.push(await this.#engine().prepareWorkerRuntimes(
                    workerId,
                    namespaceOwner,
                    [],
                ));
            }
            const deactivations = await Promise.allSettled(
                [...this.#providers.values()]
                    .toReversed()
                    .map((provider) => Promise.resolve().then(() => provider.deactivate(identity))),
            );
            const errors = deactivations
                .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                .map(({ reason }) => reason);

            if (errors.length > 0) {
                throw new AggregateError(
                    errors,
                    `Worker ${workerId} Functionality provider deactivation failed`,
                );
            }
            for (const commit of prepared) commit();
            LoopDocs.evict(this.#db, workerId);
            return true;
        } finally {
            gate.release();
        }
    }

    async readModuleState(workerId: number, namespaceOwner: string): Promise<unknown | null> {
        const checkedWorkerId = ClientInput.assertId(
            "worker module state",
            "workerId",
            workerId,
        );
        if (namespaceOwner.trim().length === 0) {
            throw new Error("worker module state requires a non-empty namespace owner");
        }
        await this.identity(checkedWorkerId);
        const row = await this.#db.worker_module_state_get.get<{ state: string }>({
            worker_id: checkedWorkerId,
            namespace_owner: namespaceOwner,
        });
        return row === undefined ? null : JSON.parse(row.state) as unknown;
    }

    // Worker settings can change while Functionality remains resident; the
    // pre-inference boundary reconciles one Worker's generated documents.
    async reconcile(workspaceId: number, workerId: number): Promise<void> {
        await LoopDocs.materialize(this.#engine(), this.#db, workspaceId, workerId);
    }

    // A global runtime or scheme registration after publication reconciles the
    // generated documents of every resident Worker.
    async rematerializeActive(): Promise<void> {
        if (!this.#published) return;
        for (const workerId of this.#capabilities.activeWorkerIds()) {
            const { workspaceId } = await this.identity(workerId);
            await LoopDocs.materialize(this.#engine(), this.#db, workspaceId, workerId);
        }
    }

    async replace({
        workspaceId,
        workerId,
        namespaceOwner,
        state,
        runtimes,
    }: WorkerCapabilityReplacement, options: { readonly gate?: WorkerCapabilityGate } = {}): Promise<void> {
        const checkedWorkspaceId = ClientInput.assertId(
            "worker Functionality replacement",
            "workspaceId",
            workspaceId,
        );
        const checkedWorkerId = ClientInput.assertId(
            "worker Functionality replacement",
            "workerId",
            workerId,
        );
        if (namespaceOwner.trim().length === 0) {
            throw new Error("worker Functionality replacement requires a non-empty namespace owner");
        }
        const identity = await this.identity(checkedWorkerId);
        if (identity.workspaceId !== checkedWorkspaceId) {
            throw residencyFailure(
                "workspace-mismatch",
                409,
                `Worker ${checkedWorkerId} does not belong to workspace ${checkedWorkspaceId}.`,
                {
                    workspaceId: checkedWorkspaceId,
                    workerId: checkedWorkerId,
                    actualWorkspaceId: identity.workspaceId,
                    retryable: false,
                },
            );
        }
        const encoded = state === null ? null : JSON.stringify(state);
        if (state !== null && encoded === undefined) {
            throw residencyFailure(
                "state-not-json",
                400,
                "Worker module state is not JSON-serializable.",
                { namespaceOwner, retryable: false },
            );
        }
        if (encoded !== null) JSON.parse(encoded);
        const normalized = runtimes.map((registration) => {
            if (registration.namespaceOwner !== namespaceOwner) {
                throw new Error(
                    `worker runtime owner '${registration.namespaceOwner}' does not match '${namespaceOwner}'`,
                );
            }
            return this.#normalizeRuntime(registration);
        });
        // {§module-worker-quiescence} — an explicit mutation (`try`) fails 409
        // while the workspace is held; a Worker's own accepted mutation (`wait`)
        // queues fairly behind its turn and publishes at that boundary; a
        // demand-driven activation or turn-admission refresh (`none`) publishes
        // inside whatever gate context its demand already holds.
        const mode = options.gate ?? "try";
        const gate = mode === "none"
            ? undefined
            : mode === "wait"
                ? this.#workspaceGate.requestExclusive(checkedWorkspaceId)
                : this.#workspaceGate.tryExclusive(checkedWorkspaceId);
        if (gate === null) {
            throw residencyFailure(
                "workspace-busy",
                409,
                `Workspace ${checkedWorkspaceId} is running an operation or another capability change.`,
                {
                    workspaceId: checkedWorkspaceId,
                    workerId: checkedWorkerId,
                    namespaceOwner,
                    recovery: "Settle the current operation and retry the capability change.",
                    retryable: true,
                },
            );
        }
        await gate?.acquired;
        const prior = await this.#db.worker_module_state_get.get<{ state: string }>({
            worker_id: checkedWorkerId,
            namespace_owner: namespaceOwner,
        });
        let rollbackRuntimes: (() => void) | undefined;
        let stateChanged = false;
        try {
            const commitRuntimes = await this.#engine().prepareWorkerRuntimes(
                checkedWorkerId,
                namespaceOwner,
                normalized,
            );
            if (encoded === null) {
                await this.#db.worker_module_state_delete.run({
                    worker_id: checkedWorkerId,
                    namespace_owner: namespaceOwner,
                });
            } else {
                await this.#db.worker_module_state_put.run({
                    worker_id: checkedWorkerId,
                    namespace_owner: namespaceOwner,
                    state: encoded,
                });
            }
            stateChanged = true;
            rollbackRuntimes = commitRuntimes();
            if (
                this.#published
                && this.#capabilities.isActive(checkedWorkerId)
            ) {
                await LoopDocs.materialize(this.#engine(), this.#db, checkedWorkspaceId, checkedWorkerId);
            }
        } catch (cause) {
            rollbackRuntimes?.();
            const rollbackErrors: unknown[] = [];
            if (stateChanged) {
                try {
                    if (prior === undefined) {
                        await this.#db.worker_module_state_delete.run({
                            worker_id: checkedWorkerId,
                            namespace_owner: namespaceOwner,
                        });
                    } else {
                        await this.#db.worker_module_state_put.run({
                            worker_id: checkedWorkerId,
                            namespace_owner: namespaceOwner,
                            state: prior.state,
                        });
                    }
                } catch (rollbackCause) {
                    rollbackErrors.push(rollbackCause);
                }
                if (
                    this.#published
                    && this.#capabilities.isActive(checkedWorkerId)
                ) {
                    try {
                        await LoopDocs.materialize(this.#engine(), this.#db, checkedWorkspaceId, checkedWorkerId);
                    } catch (rollbackCause) {
                        rollbackErrors.push(rollbackCause);
                    }
                }
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(
                    [cause, ...rollbackErrors],
                    "Worker Functionality replacement and rollback failed",
                );
            }
            throw cause;
        } finally {
            gate?.release();
        }
    }
}

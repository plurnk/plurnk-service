import type { Db } from "../core/Db.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import GitBranch, { GitUnavailableError, type GitSnapshot } from "../core/GitBranch.ts";
import GitMembership from "../core/git-membership.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import type { LoopPolicy, WriterTier } from "../core/types.ts";
import type WorkspaceGate from "../core/WorkspaceGate.ts";
import type { WorkspaceExclusive } from "../core/WorkspaceGate.ts";

type BatchRow = {
    id: number;
    workspace_id: number;
    parent_worker_id: number;
    parent_loop_id: number;
    parent_turn_id: number;
    state: string;
    active_sequence: number | null;
    repository_path: string | null;
    original_ref: string | null;
    original_commit: string | null;
    problem: string | null;
};

type ItemRow = {
    id: number;
    sequence: number;
    worker_id: number;
    loop_id: number;
    branch: string;
    state: string;
    result_commit: string | null;
    changed: number | null;
};

type BatchIdentity = Pick<BatchRow, "id" | "workspace_id">;

export interface EnqueueBranchWorker {
    workspaceId: number;
    parentWorkerId: number;
    parentLoopId: number;
    op: "WORK" | "FORK";
    name: string;
    prompt: string;
    policy: LoopPolicy;
    origin: WriterTier;
}

export interface BranchBatchDependencies {
    settleWorkspace(workspaceId: number): Promise<void>;
    createChild(args: EnqueueBranchWorker): Promise<{ workerId: number; loopId: number }>;
    startChild(workspaceId: number, workerId: number, loopId: number): Promise<SchemeResult>;
    wakeParent(workspaceId: number, workerId: number): Promise<void>;
    notify(workspaceId: number, payload: Readonly<Record<string, unknown>>): void;
}

// Durable coordinator for branch-tagged WORK/FORK. It owns the Git transaction;
// worker creation and drain execution remain daemon lifecycle responsibilities.
export default class BranchBatches {
    readonly #db: Db;
    readonly #gate: WorkspaceGate;
    readonly #lifecycle: LoopLifecycle;
    readonly #deps: BranchBatchDependencies;
    readonly #running = new Map<number, Promise<void>>();
    #stopping = false;

    constructor(db: Db, gate: WorkspaceGate, dependencies: BranchBatchDependencies) {
        this.#db = db;
        this.#gate = gate;
        this.#lifecycle = new LoopLifecycle(db);
        this.#deps = dependencies;
    }

    async enqueue(args: {
        workspaceId: number;
        parentWorkerId: number;
        parentLoopId: number;
        parentTurnId: number;
        op: "WORK" | "FORK";
        name: string;
        branch: string;
        prompt: string;
        policy: LoopPolicy;
        origin: WriterTier;
    }): Promise<{ workerId: number; loopId: number }> {
        try {
            await GitBranch.validate(args.branch);
        } catch (cause) {
            if (cause instanceof GitUnavailableError) {
                throw BranchBatches.#failure(
                    "git-unavailable",
                    501,
                    "Branch delegation needs git on this host, and git is not installed or not on PATH.",
                    {
                        branch: args.branch,
                        recovery: "Create the worker without a branch tag, or install git.",
                        retryable: false,
                    },
                    cause,
                );
            }
            throw BranchBatches.#failure(
                "branch-name-invalid",
                400,
                `Git rejected branch name '${args.branch}'.`,
                {
                    branch: args.branch,
                    recovery: "Use a valid Git branch name.",
                    retryable: false,
                },
                cause,
            );
        }

        let batch = await this.#db.branch_batch_by_turn.get<{ id: number; state?: string }>({
            parent_turn_id: args.parentTurnId,
        });
        if (batch === undefined) {
            const repository = await GitMembership.projectRepository(this.#db, args.workspaceId);
            if (repository === null) {
                throw BranchBatches.#failure(
                    "branch-workspace-has-no-repository",
                    409,
                    "A branch-tagged worker requires a Git repository containing the workspace project root.",
                    {
                        recovery: "Create the worker without a branch tag.",
                        retryable: false,
                    },
                );
            }
            const active = (await this.#db.branch_batch_active.all<BatchRow>({}))
                .find((row) => row.workspace_id === args.workspaceId);
            if (active !== undefined) {
                throw BranchBatches.#failure(
                    "branch-batch-already-active",
                    409,
                    `Workspace ${args.workspaceId} already has branch batch ${active.id} in state '${active.state}'.`,
                    {
                        batchId: active.id,
                        batchState: active.state,
                        recovery: "Finish or abort the active branch batch before starting another.",
                        retryable: false,
                    },
                );
            }
            batch = await this.#db.branch_batch_insert.get<{ id: number }>({
                workspace_id: args.workspaceId,
                parent_worker_id: args.parentWorkerId,
                parent_loop_id: args.parentLoopId,
                parent_turn_id: args.parentTurnId,
            });
            if (batch === undefined) throw new Error("Branch batch insert returned no row");
        }
        if (batch.state !== undefined && batch.state !== "collecting") {
            throw BranchBatches.#failure(
                "branch-batch-sealed",
                409,
                `Branch batch ${batch.id} is already '${batch.state}' and cannot accept another child.`,
                {
                    batchId: batch.id,
                    batchState: batch.state,
                    recovery: "Create the branch child in a new turn.",
                    retryable: false,
                },
            );
        }

        const items = await this.#db.branch_batch_items.all<ItemRow>({ batch_id: batch.id });
        if (items.some((item) => item.branch === args.branch)) {
            throw BranchBatches.#failure(
                "branch-duplicate",
                409,
                `Branch '${args.branch}' already belongs to another child in this turn.`,
                {
                    branch: args.branch,
                    recovery: "Use a distinct branch for each child in the turn.",
                    retryable: false,
                },
            );
        }

        const child = await this.#deps.createChild({
            workspaceId: args.workspaceId,
            parentWorkerId: args.parentWorkerId,
            parentLoopId: args.parentLoopId,
            op: args.op,
            name: args.name,
            prompt: args.prompt,
            policy: args.policy,
            origin: args.origin,
        });
        try {
            const sequence = await this.#db.branch_batch_next_sequence.get<{ next: number }>({
                batch_id: batch.id,
            });
            if (sequence === undefined) throw new Error("Branch batch sequence query returned no row");
            const item = await this.#db.branch_batch_insert_item.get<{ id: number }>({
                batch_id: batch.id,
                sequence: sequence.next,
                worker_id: child.workerId,
                loop_id: child.loopId,
                branch: args.branch,
            });
            if (item === undefined) throw new Error("Branch batch item insert returned no row");
        } catch (cause) {
            await this.#lifecycle.finish(
                child.loopId,
                Results.failure(
                    "lifecycle:branch",
                    "branch-batch-record-failed",
                    500,
                    "The branch worker was created but could not be attached to its durable batch.",
                    {},
                    {
                        branch: args.branch,
                        stage: "batch-registration",
                        retryable: false,
                    },
                ),
            );
            throw cause;
        }
        return child;
    }

    // Called while the parent still holds its shared turn permit. requestExclusive
    // queues synchronously; execution waits asynchronously until that permit and
    // every earlier reader drains.
    async sealTurn(parentTurnId: number): Promise<void> {
        const row = await this.#db.branch_batch_seal.get<{
            id: number;
            workspace_id: number;
            parent_worker_id: number;
        }>({ parent_turn_id: parentTurnId });
        if (row === undefined) return;
        const items = await this.#db.branch_batch_items.all<ItemRow>({ batch_id: row.id });
        this.#deps.notify(row.workspace_id, {
            batchId: row.id,
            state: "queued",
            completed: 0,
            total: items.length,
            parentWorkerId: row.parent_worker_id,
        });
        const exclusive = this.#gate.requestExclusive(row.workspace_id);
        const run = this.#execute(row.id, row.workspace_id, row.parent_worker_id, exclusive);
        this.#track(row.id, run);
    }

    async completionGate(workerId: number): Promise<SchemeResult | null> {
        const active = await this.#db.branch_batch_active_for_worker.get<{
            batch_id: number;
            state: string;
            branch: string;
            repository_path: string | null;
        }>({ worker_id: workerId });
        if (active === undefined || active.state !== "running") return null;
        if (active.repository_path === null) {
            throw new Error(`Running branch batch ${active.batch_id} has no project repository snapshot`);
        }
        const current = await GitBranch.currentBranch(active.repository_path);
        if (current !== active.branch) {
            return Results.failure(
                "lifecycle:branch",
                "branch-checkout-changed",
                409,
                `Branch '${active.branch}' cannot conclude while the project repository is checked out at '${current ?? "detached HEAD"}'.`,
                {},
                {
                    branch: active.branch,
                    currentBranch: current,
                    stage: "branch-completion",
                    recovery: "Restore the assigned branch, commit the work, and conclude again.",
                    retryable: false,
                },
            );
        }
        try {
            await GitBranch.assertClean(active.repository_path);
        } catch {
            return Results.failure(
                "lifecycle:branch",
                "branch-work-uncommitted",
                409,
                `Branch '${active.branch}' cannot conclude with uncommitted project changes.`,
                {},
                {
                    branch: active.branch,
                    stage: "branch-completion",
                    recovery: "Commit or deliberately discard the changes before concluding again.",
                    retryable: false,
                },
            );
        }
        return null;
    }

    async recover(): Promise<void> {
        for (const batch of await this.#db.branch_batch_active.all<BatchRow>({})) {
            if (batch.state === "collecting") {
                await this.#failUnstarted(
                    batch,
                    Results.failure(
                        "lifecycle:branch",
                        "branch-parent-interrupted",
                        500,
                        "The daemon restarted before the parent turn sealed its branch batch.",
                        {},
                        {
                            stage: "batch-sealing",
                            recovery: "Create a new branch batch for the unfinished work.",
                            retryable: false,
                        },
                    ),
                );
                continue;
            }
            const exclusive = this.#gate.requestExclusive(batch.workspace_id);
            const run = batch.state === "queued"
                ? this.#recoverQueued(batch, exclusive)
                : this.#recoverRunning(batch, exclusive);
            this.#track(batch.id, run);
        }
    }

    async idle(): Promise<void> {
        await Promise.allSettled(this.#running.values());
    }

    beginStop(): void {
        this.#stopping = true;
    }

    async #execute(
        batchId: number,
        workspaceId: number,
        parentWorkerId: number,
        exclusive: WorkspaceExclusive,
    ): Promise<void> {
        await exclusive.acquired;
        const created: string[] = [];
        let started = false;
        let release = true;
        try {
            await this.#deps.settleWorkspace(workspaceId);
            const open = await this.#db.branch_batch_workspace_open_subscriptions.get<{ n: number }>({
                workspace_id: workspaceId,
            });
            if ((open?.n ?? 0) !== 0) {
                throw BranchBatches.#failure(
                    "branch-streams-open",
                    409,
                    `The workspace has ${open?.n ?? 0} open stream subscription(s).`,
                    {
                        openSubscriptions: open?.n ?? 0,
                        stage: "stream-settlement",
                        recovery: "Close the active streams before creating a branch batch.",
                        retryable: false,
                    },
                );
            }
            const items = await this.#db.branch_batch_items.all<ItemRow>({ batch_id: batchId });
            const repository = await GitMembership.projectRepository(this.#db, workspaceId);
            if (repository === null) {
                throw BranchBatches.#failure(
                    "branch-workspace-has-no-repository",
                    409,
                    "The workspace project root is not inside an enabled Git repository.",
                    {
                        stage: "git-preflight",
                        recovery: "Create workers without branch tags in a workspace that has no project repository.",
                        retryable: false,
                    },
                );
            }
            try {
                await GitBranch.assertClean(repository);
            } catch (cause) {
                throw BranchBatches.#failure(
                    "branch-checkout-dirty",
                    409,
                    "The project repository has staged, unstaged, or nonignored untracked changes.",
                    {
                        stage: "git-preflight",
                        recovery: "Commit or deliberately discard the project repository changes before creating a branch batch.",
                        retryable: false,
                    },
                    cause,
                );
            }
            const snapshot = await GitBranch.snapshot(repository);
            for (const item of items) {
                await GitBranch.validate(item.branch);
                if (await GitBranch.branchExists(repository, item.branch)) {
                    throw BranchBatches.#failure(
                        "branch-already-exists",
                        409,
                        `Git branch '${item.branch}' already exists in the project repository.`,
                        {
                            branch: item.branch,
                            stage: "git-preflight",
                            recovery: "Use a branch name that does not already exist.",
                            retryable: false,
                        },
                    );
                }
            }
            for (const item of items) {
                await GitBranch.create(repository, item.branch, snapshot.commit);
                created.push(item.branch);
            }
            await this.#db.branch_batch_start.run({
                batch_id: batchId,
                repository_path: repository,
                original_ref: snapshot.ref,
                original_commit: snapshot.commit,
            });
            started = true;
            this.#deps.notify(workspaceId, {
                batchId,
                state: "running",
                completed: 0,
                total: items.length,
            });
            await this.#runItems(batchId, workspaceId, parentWorkerId, snapshot, items, exclusive);
        } catch (cause) {
            if (cause instanceof RecoveryRequiredError) {
                release = false;
            } else if (started) {
                release = false;
                await this.#requireRecovery({
                    id: batchId,
                    workspace_id: workspaceId,
                }, cause);
            } else {
                try {
                    const repository = await GitMembership.projectRepository(this.#db, workspaceId);
                    if (repository === null && created.length > 0) {
                        throw new Error("The project repository disappeared during branch preflight");
                    }
                    if (repository !== null) await this.#rollbackPreflight(repository, created);
                } catch (rollbackCause) {
                    release = false;
                    await this.#requireRecovery({
                        id: batchId,
                        workspace_id: workspaceId,
                    }, new AggregateError([cause, rollbackCause], "Branch preflight and rollback both failed"));
                    return;
                }
                const failure = cause instanceof OperationFailureError
                    ? cause.result
                    : Results.failure(
                        "lifecycle:branch",
                        "branch-batch-preflight-failed",
                        500,
                        `Branch batch ${batchId} failed during preflight.`,
                        {},
                        {
                            batchId,
                            stage: "git-preflight",
                            retryable: false,
                        },
                    );
                await this.#failBatch(batchId, failure);
                this.#deps.notify(workspaceId, {
                    batchId,
                    state: "failed",
                    problem: failure.problem,
                });
            }
        } finally {
            if (release) {
                exclusive.release();
                await this.#deps.wakeParent(workspaceId, parentWorkerId);
            }
        }
    }

    async #runItems(
        batchId: number,
        workspaceId: number,
        parentWorkerId: number,
        snapshot: GitSnapshot,
        items: ItemRow[],
        exclusive: WorkspaceExclusive,
    ): Promise<void> {
        for (const item of items.filter(({ state }) => state === "queued")) {
            if (this.#stopping) {
                const failure = Results.failure(
                    "lifecycle:branch",
                    "branch-batch-stopped",
                    499,
                    "The daemon stopped before the remaining branch children started.",
                    {},
                    {
                        batchId,
                        stage: "branch-scheduling",
                        retryable: false,
                    },
                );
                await this.#failBatch(batchId, failure);
                this.#deps.notify(workspaceId, {
                    batchId,
                    state: "failed",
                    problem: failure.problem,
                });
                return;
            }
            await GitBranch.switch(snapshot.root, item.branch);
            await this.#db.branch_batch_start_item.run({ item_id: item.id });
            await this.#db.branch_batch_set_active.run({
                batch_id: batchId,
                sequence: item.sequence,
            });
            exclusive.setRoot(item.worker_id);
            this.#deps.notify(workspaceId, {
                batchId,
                state: "running",
                activeSequence: item.sequence,
                branch: item.branch,
                workerId: item.worker_id,
                completed: item.sequence - 1,
                total: items.length,
            });

            let result: SchemeResult;
            try {
                result = await this.#deps.startChild(workspaceId, item.worker_id, item.loop_id);
            } catch (cause) {
                console.error(`Branch child '${item.branch}' failed outside its terminal result contract:`, cause);
                result = await this.#lifecycle.result(item.loop_id)
                    ?? Results.failure(
                        "lifecycle:branch",
                        "branch-child-threw",
                        500,
                        `Branch child '${item.branch}' failed outside its terminal result contract.`,
                        {},
                        {
                            branch: item.branch,
                            stage: "child-loop",
                            retryable: false,
                        },
                    );
            }
            exclusive.setRoot(null);

            try {
                await this.#assertAssignedAndClean(snapshot.root, item.branch);
                await this.#recordTip(item, snapshot);
                await this.#restore(snapshot);
            } catch (cause) {
                const failure = Results.failure(
                    "lifecycle:branch",
                    "branch-recovery-required",
                    500,
                    `Branch '${item.branch}' returned with ambiguous Git state: ${ErrorDetail.preview(cause)}`,
                    {},
                    {
                        branch: item.branch,
                        batchId,
                        stage: "git-restoration",
                        retryable: false,
                    },
                );
                await this.#db.branch_batch_finish_item.run({
                    item_id: item.id,
                    state: "recovery_required",
                    result: JSON.stringify(failure),
                });
                await this.#db.branch_batch_finish.run({
                    batch_id: batchId,
                    state: "recovery_required",
                    problem: JSON.stringify(failure.problem),
                });
                this.#deps.notify(workspaceId, {
                    batchId,
                    state: "recovery_required",
                    branch: item.branch,
                    problem: failure.problem,
                });
                throw new RecoveryRequiredError(failure.problem?.detail ?? "Branch recovery required");
            }
            await this.#db.branch_batch_finish_item.run({
                item_id: item.id,
                state: result.status >= 200 && result.status < 300 ? "succeeded" : "failed",
                result: JSON.stringify(result),
            });
        }
        await this.#db.branch_batch_finish.run({
            batch_id: batchId,
            state: "completed",
            problem: null,
        });
        this.#deps.notify(workspaceId, {
            batchId,
            state: "completed",
            completed: items.length,
            total: items.length,
            parentWorkerId,
        });
    }

    async #recoverQueued(batch: BatchRow, exclusive: WorkspaceExclusive): Promise<void> {
        await exclusive.acquired;
        let replacement: WorkspaceExclusive | null = null;
        try {
            const snapshot = BranchBatches.#snapshot(batch);
            if (snapshot !== null) {
                const items = await this.#db.branch_batch_items.all<ItemRow>({ batch_id: batch.id });
                await GitBranch.assertClean(snapshot.root);
                await GitBranch.restore(snapshot);
                for (const item of items) {
                    if (await GitBranch.branchExists(snapshot.root, item.branch)) {
                        const tip = await GitBranch.tip(snapshot.root, item.branch);
                        if (tip !== snapshot.commit) {
                            throw new Error(`Partially-created branch '${item.branch}' moved from its frozen base`);
                        }
                        await GitBranch.delete(snapshot.root, item.branch);
                    }
                }
                await this.#db.branch_batch_reset_preflight.run({ batch_id: batch.id });
            }
            replacement = this.#gate.requestExclusive(batch.workspace_id);
        } catch (cause) {
            await this.#requireRecovery(batch, cause);
            return;
        } finally {
            if (replacement !== null) exclusive.release();
        }
        if (replacement === null) return;
        await this.#execute(batch.id, batch.workspace_id, batch.parent_worker_id, replacement);
    }

    async #recoverRunning(batch: BatchRow, exclusive: WorkspaceExclusive): Promise<void> {
        await exclusive.acquired;
        let release = true;
        try {
            const snapshot = BranchBatches.#snapshot(batch);
            const items = await this.#db.branch_batch_items.all<ItemRow>({ batch_id: batch.id });
            if (snapshot === null) throw new Error("Running branch batch has no project repository snapshot");
            await GitBranch.assertClean(snapshot.root);

            if (batch.active_sequence !== null) {
                const item = items.find(({ sequence }) => sequence === batch.active_sequence);
                if (item === undefined) throw new Error(`Active branch sequence ${batch.active_sequence} has no item`);
                const branch = await GitBranch.currentBranch(snapshot.root);
                const head = await GitBranch.head(snapshot.root);
                const atOriginal = branch === snapshot.ref && head === snapshot.commit;
                if (branch !== item.branch && !atOriginal) {
                    throw new Error(`The project repository is at '${branch ?? "detached HEAD"}', not '${item.branch}' or its original position`);
                }
                await this.#recordTip(item, snapshot);
                await this.#restore(snapshot);
                const failure = Results.failure(
                    "lifecycle:branch",
                    "branch-child-interrupted",
                    500,
                    `The daemon restarted while branch '${item.branch}' was active. Its committed tip was preserved.`,
                    {},
                    {
                        branch: item.branch,
                        batchId: batch.id,
                        stage: "child-loop",
                        recovery: "Review the preserved branch tip before deciding how to continue.",
                        retryable: false,
                    },
                );
                await this.#db.branch_batch_finish_item.run({
                    item_id: item.id,
                    state: "failed",
                    result: JSON.stringify(failure),
                });
            } else {
                await this.#restore(snapshot);
            }
            await this.#runItems(
                batch.id,
                batch.workspace_id,
                batch.parent_worker_id,
                snapshot,
                items,
                exclusive,
            );
        } catch (cause) {
            release = false;
            await this.#requireRecovery(batch, cause);
        } finally {
            if (release) {
                exclusive.release();
                await this.#deps.wakeParent(batch.workspace_id, batch.parent_worker_id);
            }
        }
    }

    async #requireRecovery(batch: BatchIdentity, cause: unknown): Promise<void> {
        console.error(`Branch batch ${batch.id} requires operator recovery:`, cause);
        const failure = Results.failure(
            "lifecycle:branch",
            "branch-recovery-required",
            500,
            `Branch batch ${batch.id} requires operator recovery: ${ErrorDetail.preview(cause)}`,
            {},
            {
                batchId: batch.id,
                stage: "git-restoration",
                retryable: false,
            },
        );
        await this.#db.branch_batch_finish.run({
            batch_id: batch.id,
            state: "recovery_required",
            problem: JSON.stringify(failure.problem),
        });
        this.#deps.notify(batch.workspace_id, {
            batchId: batch.id,
            state: "recovery_required",
            problem: failure.problem,
        });
    }

    async #failUnstarted(batch: BatchRow, failure: SchemeResult): Promise<void> {
        await this.#failBatch(batch.id, failure);
        this.#deps.notify(batch.workspace_id, {
            batchId: batch.id,
            state: "failed",
            problem: failure.problem,
        });
        await this.#deps.wakeParent(batch.workspace_id, batch.parent_worker_id);
    }

    async #failBatch(batchId: number, failure: SchemeResult): Promise<void> {
        for (const item of await this.#db.branch_batch_items.all<ItemRow>({ batch_id: batchId })) {
            if (item.state === "queued" || item.state === "running") {
                await this.#lifecycle.finish(item.loop_id, failure);
                await this.#db.branch_batch_finish_item.run({
                    item_id: item.id,
                    state: "failed",
                    result: JSON.stringify(failure),
                });
            }
        }
        await this.#db.branch_batch_finish.run({
            batch_id: batchId,
            state: "failed",
            problem: JSON.stringify(failure.problem),
        });
    }

    async #recordTip(item: ItemRow, snapshot: GitSnapshot): Promise<void> {
        if (item.result_commit !== null) return;
        const tip = await GitBranch.tip(snapshot.root, item.branch);
        await this.#db.branch_batch_record_tip.run({
            item_id: item.id,
            result_commit: tip,
            changed: tip === snapshot.commit ? 0 : 1,
        });
    }

    async #restore(snapshot: GitSnapshot): Promise<void> {
        await GitBranch.restore(snapshot);
        await GitBranch.assertClean(snapshot.root);
    }

    async #assertAssignedAndClean(root: string, branch: string): Promise<void> {
        const current = await GitBranch.currentBranch(root);
        if (current !== branch) {
            throw new Error(`The project repository is at '${current ?? "detached HEAD"}', expected '${branch}'`);
        }
        await GitBranch.assertClean(root);
    }

    async #rollbackPreflight(root: string, created: string[]): Promise<void> {
        const failures: unknown[] = [];
        for (const branch of created.toReversed()) {
            try {
                if (await GitBranch.branchExists(root, branch)) await GitBranch.delete(root, branch);
            } catch (error) {
                failures.push(new Error(`Could not remove preflight branch '${branch}'`, { cause: error }));
            }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Branch preflight rollback failed");
    }

    static #snapshot(batch: BatchRow): GitSnapshot | null {
        if (batch.repository_path === null && batch.original_commit === null) return null;
        if (batch.repository_path === null || batch.original_commit === null) {
            throw new Error(`Branch batch ${batch.id} has an incomplete project repository snapshot`);
        }
        return {
            root: batch.repository_path,
            ref: batch.original_ref,
            commit: batch.original_commit,
        };
    }

    #track(batchId: number, run: Promise<void>): void {
        this.#running.set(batchId, run);
        void run.finally(() => {
            if (this.#running.get(batchId) === run) this.#running.delete(batchId);
        }).catch((error: unknown) => {
            console.error(`branch batch ${batchId} failed:`, error);
        });
    }

    static #failure(
        code: string,
        status: number,
        detail: string,
        extensions: Readonly<Record<string, unknown>> = {},
        cause?: unknown,
    ): OperationFailureError {
        return new OperationFailureError(
            Results.failure("lifecycle:branch", code, status, detail, {}, extensions),
            cause === undefined ? {} : { cause },
        );
    }
}

class RecoveryRequiredError extends Error {}

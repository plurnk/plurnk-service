// Envelope lifecycle helpers for module clients. SPEC {§connection-lifecycle}.
//
// A client-interface module receives this value from an explicit workspace create
// or attach call. Core creates or selects the client worker but retains no transport
// binding; each dispatched client action allocates and settles its own journal segment.

import type { Db } from "../core/Db.ts";
import GitMembership from "../core/git-membership.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import WorkerName from "../core/WorkerName.ts";

const envelopeFailure = (
    owner: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure(owner, code, status, detail, {}, extensions),
);

export interface WorkspaceRow {
    id: number;
    name: string;
    project_root: string | null;
    created_at: string;
    cost_usd: number;
}

export interface WorkerRow {
    id: number;
    name: string;
    created_at: string;
    cost_usd: number;
    origin: "model" | "client" | "plurnk";
}

// `workerId` is the client actor's worker: dispatched client actions live there
// ({§connection-lifecycle}, {§machine-processes}). The conversation worker is
// resolved separately by the client-interface module.
export interface ClientEnvelope {
    workspaceId: number;
    workspaceName: string;
    projectRoot: string | null;
    workerId: number;
    workerName: string;
}

export default class Envelope {
    // Workspace names default to `workspace-{unixtime}-{random}`; the suffix avoids
    // collisions when two creations land in the same second. Worker names use the
    // workspace-local `<prefix>-<ordinal>` contract in WorkerName.
    static #tsName(prefix: string): string {
        const ts = Math.floor(Date.now() / 1000);
        const rand = Math.floor(Math.random() * 0xFFFFFF).toString(36).padStart(4, "0");
        return `${prefix}-${ts}-${rand}`;
    }

    static generateWorkspaceName(): string {
        return Envelope.#tsName("workspace");
    }

    static async createClientEnvelope(db: Db, opts: { name?: string; prefix?: string; projectRoot?: string | null; settings?: string } = {}): Promise<ClientEnvelope> {
        const name = opts.name ?? Envelope.#tsName(opts.prefix ?? "workspace");
        const projectRoot = opts.projectRoot ?? null;
        const workspace = await db.envelope_insert_workspace.get<{ id: number; name: string; project_root: string | null }>({ name, project_root: projectRoot, settings: opts.settings ?? "{}" });
        if (workspace === undefined) {
            throw envelopeFailure(
                "daemon:workspace",
                "name-conflict",
                409,
                `Workspace name '${name}' is already in use.`,
                {
                    name,
                    recovery: "Choose another workspace name or attach to the existing workspace.",
                    retryable: false,
                },
            );
        }
        // SPEC {§membership} D4 — establish git-ls-files membership at workspace setup so
        // tracked files are members before the first op. No-op when projectRoot is
        // null (headless) or not a git working tree.
        await GitMembership.resolveGitMembership(db, workspace.id, undefined);
        const worker = await WorkerName.claimAuto(db, {
            workspaceId: workspace.id,
            prefix: "client",
            origin: "client",
        });
        return {
            workspaceId: workspace.id, workspaceName: workspace.name,
            projectRoot: workspace.project_root,
            workerId: worker.id, workerName: worker.name,
        };
    }

    // Resolve the worker inside a workspace. Three modes:
    // - opts.workerId given: lookup by id, verify workspace ownership (else throw).
    // - opts.workerName given: lookup by (workspaceId, name); reuse if found, create otherwise.
    // - neither: create a new worker with an auto-generated name (current behavior).
    // `workerId` and `workerName` are alternatives — passing both throws (use one).
    static async #resolveWorker(db: Db, workspaceId: number, opts: { workerId?: number; workerName?: string }): Promise<{ id: number; name: string }> {
        if (opts.workerId !== undefined && opts.workerName !== undefined) {
            throw envelopeFailure(
                "daemon:worker",
                "worker-selector-conflict",
                400,
                "Workspace attachment received both a worker ID and worker name.",
                {
                    workerId: opts.workerId,
                    workerName: opts.workerName,
                    recovery: "Select the worker by either ID or name.",
                    retryable: false,
                },
            );
        }
        if (opts.workerId !== undefined) {
            const existing = await db.envelope_get_worker_by_id.get<{ id: number; name: string; workspace_id: number }>({ id: opts.workerId });
            if (existing === undefined) {
                throw envelopeFailure(
                    "daemon:worker",
                    "worker-not-found",
                    404,
                    `Worker ${opts.workerId} does not exist.`,
                    { workerId: opts.workerId },
                );
            }
            if (existing.workspace_id !== workspaceId) {
                throw envelopeFailure(
                    "daemon:worker",
                    "workspace-mismatch",
                    409,
                    `Worker ${opts.workerId} does not belong to workspace ${workspaceId}.`,
                    {
                        workerId: opts.workerId,
                        workspaceId,
                        actualWorkspaceId: existing.workspace_id,
                        retryable: false,
                    },
                );
            }
            return { id: existing.id, name: existing.name };
        }
        if (opts.workerName !== undefined) {
            const workerName = WorkerName.assert(opts.workerName); // {§worker-name-minting}
            const existing = await db.envelope_get_worker_by_name.get<{ id: number; name: string }>({ workspace_id: workspaceId, name: workerName });
            if (existing !== undefined) return existing;
            const created = await db.envelope_insert_worker.get<{ id: number; name: string }>({ workspace_id: workspaceId, name: workerName, origin: "client" });
            if (created === undefined) throw new Error("resolveWorker: worker insert returned no row");
            return created;
        }
        return await WorkerName.claimAuto(db, {
            workspaceId,
            prefix: "client",
            origin: "client",
        });
    }

    static async attachToWorkspace(db: Db, workspaceId: number, opts: { workerId?: number; workerName?: string } = {}): Promise<ClientEnvelope> {
        const workspace = await db.envelope_get_workspace.get<{ id: number; name: string; project_root: string | null }>({ id: workspaceId });
        if (workspace === undefined) {
            throw envelopeFailure(
                "daemon:workspace",
                "workspace-not-found",
                404,
                `Workspace ${workspaceId} does not exist.`,
                { workspaceId },
            );
        }
        const worker = await Envelope.#resolveWorker(db, workspace.id, opts);
        return {
            workspaceId: workspace.id, workspaceName: workspace.name,
            projectRoot: workspace.project_root,
            workerId: worker.id, workerName: worker.name,
        };
    }

    // Client action journal allocator. One action allocates one segment; its
    // statements become ordered turns and settlement closes the segment.
    static async ensureClientLoop(db: Db, workerId: number): Promise<number> {
        const loop = await db.envelope_insert_client_loop.get<{ id: number }>({ worker_id: workerId });
        if (loop === undefined) throw new Error("ensureClientLoop: loop insert returned no row");
        return loop.id;
    }

    // Lazy model-worker allocator ({§connection-lifecycle}, {§machine-processes} — the client writes to its own worker).
    // The model's conversation lives in its own worker, distinct from the client's
    // client worker, so the packet — rendered from the model worker — never carries
    // the client's dispatched actions. The module resolves and retains the binding.
    // {§methods-conversation-worker}: a fresh conversation is a named, empty-log,
    // model-origin root, distinct from the stable default and from a history-copying fork.
    static async createModelWorker(db: Db, workspaceId: number, name?: string): Promise<{ id: number; name: string }> {
        if (name === undefined) {
            return await WorkerName.claimAuto(db, {
                workspaceId,
                prefix: "model",
                origin: "model",
            });
        }
        const worker = await db.envelope_insert_worker.get<{ id: number; name: string }>({
            workspace_id: workspaceId,
            name: WorkerName.assert(name),
            origin: "model",
        });
        if (worker === undefined) throw new Error("createModelWorker: worker insert returned no row");
        return worker;
    }

    static async ensureModelWorker(db: Db, workspaceId: number): Promise<number> {
        // {§methods-model-worker}: idempotence lives at the seam, not in a client's
        // connection cache. #186 tracks distinguishing this default from arbitrary fresh roots.
        const worker = await WorkerName.ensureAutoRoot(db, {
            workspaceId,
            prefix: "model",
            origin: "model",
        });
        return worker.id;
    }

    // Self-hosting keystone ({§actor-boundary-self-hosting}): the workspace's
    // reserved `plurnk` worker. One durable worker per workspace, reused across
    // the ephemeral administrative loops that dispatch ordinary runtime-owned ops.
    static async ensurePlurnkWorker(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        if (existing !== undefined) return existing.id;
        const worker = await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "plurnk" });
        if (worker === undefined) throw new Error("ensurePlurnkWorker: worker insert returned no row");
        return worker.id;
    }

    static async listWorkersForWorkspace(db: Db, workspaceId: number): Promise<WorkerRow[]> {
        return await db.envelope_list_workers_for_workspace.all<WorkerRow>({ workspace_id: workspaceId });
    }

    // #238 — a workspace's prior user prompts, newest-first, capped. The conversation worker's
    // loop seeds (engine_get_loop_prompt is the per-loop read); exposed directly so a
    // client seeds up/down history without log archaeology.
    static async listPromptsForWorkspace(db: Db, workspaceId: number, limit: number): Promise<string[]> {
        const rows = await db.envelope_list_workspace_prompts.all<{ prompt: string }>({ workspace_id: workspaceId, limit });
        return rows.map((r) => r.prompt);
    }

    static async closeClientLoop(db: Db, loopId: number, result: SchemeResult): Promise<void> {
        const exact = structuredClone(Results.assert(result));
        if (exact.problem !== undefined && exact.problem.instance === undefined) {
            Results.attachInstance(exact, `loop:///${loopId}`);
        }
        await db.envelope_close_client_loop.run({
            status: LoopLifecycle.projectStatus(exact.status),
            result: JSON.stringify(exact),
            message: exact.problem?.detail ?? null,
            loop_id: loopId,
        });
    }

    static async listWorkspaces(db: Db): Promise<WorkspaceRow[]> {
        return await db.envelope_list_workspaces.all<WorkspaceRow>();
    }

    // workspace.rename — the workspace name is a mutable handle (vs a worker's immutable
    // name, {§machine-processes}). Mutates workspaces.name only; the UNIQUE constraint is
    // the real guard against collision (the handler pre-checks for a clean error).
    static async updateWorkspaceName(db: Db, workspaceId: number, name: string): Promise<string> {
        const row = await db.envelope_set_workspace_name.get<{ id: number; name: string }>({ id: workspaceId, name });
        if (row === undefined) {
            const workspace = await db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId });
            if (workspace !== undefined) {
                throw envelopeFailure(
                    "daemon:workspace",
                    "name-conflict",
                    409,
                    `Workspace name '${name}' is already in use.`,
                    {
                        workspaceId,
                        name,
                        recovery: "Choose another workspace name.",
                        retryable: false,
                    },
                );
            }
            throw envelopeFailure(
                "daemon:workspace",
                "workspace-not-found",
                404,
                `Workspace ${workspaceId} does not exist.`,
                { workspaceId },
            );
        }
        return row.name;
    }
}

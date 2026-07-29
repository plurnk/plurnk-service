// Envelope lifecycle helpers for client connections. SPEC §connection-lifecycle.
//
// Every connected client gets a (workspace, run, client-loop) envelope. Either
// the client picks the workspace explicitly (workspace.create / workspace.attach)
// or the daemon auto-creates one on first requiresInit RPC. In both cases
// the daemon opens a NEW run within the workspace and a NEW client loop within
// that worker; the client loop closes on disconnect.

import type { Db } from "../core/Db.ts";
import GitMembership from "../core/git-membership.ts";
import Owner from "../core/Owner.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";

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

// Per-connection envelope. `workerId` is the connection's own worker — the client
// actor's: `op.*` and `log.read` live there (§connection-lifecycle, §machine-processes). `modelWorkerId` is the
// model's separate run (the conversation); `loop.run`/`loop.cancel` target it and
// the packet renders it, so client ops are absent from what the model sees with no
// filter. Both `modelWorkerId` and `clientLoopId` are lazily allocated on first use —
// a connection that never drives a model never spawns a model worker.
export interface ClientEnvelope {
    workspaceId: number;
    workspaceName: string;
    projectRoot: string | null;
    workerId: number;
    workerName: string;
    modelWorkerId: number | null;
    clientLoopId: number | null;
}

export default class Envelope {
    // Run names reserved for non-client actors: a client must not create OR
    // attach to a worker under a reserved name (origin-impersonation — `plurnk`
    // is the runtime actor, §authority-terms/§actor-boundary). Checked case-insensitively, before
    // lookup, so a client can neither forge nor hijack one (SPEC §methods).
    static readonly RESERVED_RUN_NAMES: ReadonlySet<string> = Owner.RESERVED; // §methods-worker-name-reserved + {§entry-owner} (commons/plurnk rows, ~ self-sigil)

    // Grammar 0.5.0 (#10): Workspace and Run carry user-renameable string names.
    // Defaults are `workspace-{unixtime}` and `run-{unixtime}`; random suffix avoids
    // collisions when two creations land in the same second.
    static #tsName(prefix: string): string {
        const ts = Math.floor(Date.now() / 1000);
        const rand = Math.floor(Math.random() * 0xFFFFFF).toString(36).padStart(4, "0");
        return `${prefix}-${ts}-${rand}`;
    }

    static generateWorkspaceName(): string {
        return Envelope.#tsName("workspace");
    }

    static async mintWorkerName(db: Db, workspaceId: number, prefix: string): Promise<string> {
        const count = await db.envelope_count_workers_by_prefix.get<{ n: number }>({ workspace_id: workspaceId, name_prefix: `${prefix}-%` });
        let n = (count?.n ?? 0) + 1;
        // A manually-named squatter (`model-3` typed by a user) can hold the ordinal — bump past it.
        while (await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: `${prefix}-${n}` }) !== undefined) n++;
        return `${prefix}-${n}`;
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
        // SPEC §membership D4 — establish git-ls-files membership at workspace setup so
        // tracked files are members before the first op. No-op when projectRoot is
        // null (headless) or not a git working tree.
        await GitMembership.resolveGitMembership(db, workspace.id, undefined);
        const workerName = await Envelope.mintWorkerName(db, workspace.id, "client");
        const run = await db.envelope_insert_worker.get<{ id: number; name: string }>({ workspace_id: workspace.id, name: workerName, origin: "client" });
        if (run === undefined) throw new Error("createClientEnvelope: run insert returned no row");
        return {
            workspaceId: workspace.id, workspaceName: workspace.name,
            projectRoot: workspace.project_root,
            workerId: run.id, workerName: run.name,
            modelWorkerId: null,
            clientLoopId: null,
        };
    }

    // Resolve the worker inside a workspace. Three modes:
    // - opts.workerId given: lookup by id, verify workspace ownership (else throw).
    // - opts.workerName given: lookup by (workspaceId, name); reuse if found, create otherwise.
    // - neither: create a new run with an auto-generated name (current behavior).
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
            if (Envelope.RESERVED_RUN_NAMES.has(opts.workerName.toLowerCase())) {
                throw envelopeFailure(
                    "daemon:worker",
                    "name-reserved",
                    409,
                    `Worker name '${opts.workerName}' is reserved.`,
                    {
                        name: opts.workerName,
                        recovery: "Choose another worker name.",
                        retryable: false,
                    },
                );
            }
            const existing = await db.envelope_get_worker_by_name.get<{ id: number; name: string }>({ workspace_id: workspaceId, name: opts.workerName });
            if (existing !== undefined) return existing;
            const created = await db.envelope_insert_worker.get<{ id: number; name: string }>({ workspace_id: workspaceId, name: opts.workerName, origin: "client" });
            if (created === undefined) throw new Error("resolveWorker: run insert returned no row");
            return created;
        }
        const created = await db.envelope_insert_worker.get<{ id: number; name: string }>({ workspace_id: workspaceId, name: await Envelope.mintWorkerName(db, workspaceId, "client"), origin: "client" });
        if (created === undefined) throw new Error("resolveWorker: run insert returned no row");
        return created;
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
        const run = await Envelope.#resolveWorker(db, workspace.id, opts);
        return {
            workspaceId: workspace.id, workspaceName: workspace.name,
            projectRoot: workspace.project_root,
            workerId: run.id, workerName: run.name,
            modelWorkerId: null,
            clientLoopId: null,
        };
    }

    // Client action journal allocator. One action allocates one segment; its
    // statements become ordered turns and settlement closes the segment.
    static async ensureClientLoop(db: Db, workerId: number): Promise<number> {
        const loop = await db.envelope_insert_client_loop.get<{ id: number }>({ worker_id: workerId });
        if (loop === undefined) throw new Error("ensureClientLoop: loop insert returned no row");
        return loop.id;
    }

    // Lazy model-run allocator (§connection-lifecycle, §machine-processes — the client writes to its own worker).
    // The model's conversation lives in its OWN run, distinct from the connection's
    // (client) run, so the packet — rendered from the model's run — never carries
    // the client's op.*. Created on the first loop.run; reused for the connection.
    // #366 — a FRESH conversation over the same world (§machine-processes: two workers are two
    // conversations about one curated workspace): a named, empty-log, model-origin ROOT run.
    // Distinct from ensureModelWorker (the stable default conversation) and forkWorker (copies history).
    static async createModelWorker(db: Db, workspaceId: number, name?: string): Promise<{ id: number; name: string }> {
        if (name !== undefined && Owner.RESERVED.has(name.toLowerCase())) {
            throw envelopeFailure(
                "daemon:worker",
                "name-reserved",
                409,
                `Worker name '${name}' is reserved.`,
                { name, recovery: "Choose another worker name.", retryable: false },
            );
        }
        const run = await db.envelope_insert_worker.get<{ id: number; name: string }>({ workspace_id: workspaceId, name: name ?? await Envelope.mintWorkerName(db, workspaceId, "model"), origin: "model" });
        if (run === undefined) throw new Error("createModelWorker: run insert returned no row");
        return run;
    }

    static async ensureModelWorker(db: Db, workspaceId: number): Promise<number> {
        // #371 — ensure means FIND-FIRST (the WS connection's per-workspace cache used to hide the
        // insert-only bug; the seam has no connection state, so idempotence lives HERE): reuse the
        // workspace's canonical conversation worker — the earliest model-origin root (forks/workers
        // inherit origin and are excluded by parent_worker_id). #366 is the explicit fresh-run door.
        const existing = await db.envelope_get_model_worker.get<{ id: number }>({ workspace_id: workspaceId });
        if (existing !== undefined) return existing.id;
        const run = await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: await Envelope.mintWorkerName(db, workspaceId, "model"), origin: "model" });
        if (run === undefined) throw new Error("ensureModelWorker: run insert returned no row");
        return run.id;
    }

    // Self-hosting keystone (§actor-boundary): the workspace's reserved `plurnk` run, where the
    // runtime acts as an ordinary actor (doc materialization today; fs/git work
    // later). One per workspace, reused; its log is the runtime's own — invisible
    // to other workers except through the shared workspace filesystem.
    static async ensurePlurnkWorker(db: Db, workspaceId: number): Promise<number> {
        const existing = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        if (existing !== undefined) return existing.id;
        const run = await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "plurnk" });
        if (run === undefined) throw new Error("ensurePlurnkWorker: run insert returned no row");
        return run.id;
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
    // name, §machine-processes). Mutates workspaces.name only; the UNIQUE constraint is
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

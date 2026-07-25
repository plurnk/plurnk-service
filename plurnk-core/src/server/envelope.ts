// Envelope lifecycle helpers for client connections. SPEC §connection-lifecycle.
//
// Every connected client gets a (workspace, run, client-loop) envelope. Either
// the client picks the workspace explicitly (workspace.create / workspace.attach)
// or the daemon auto-creates one on first requiresInit RPC. In both cases
// the daemon opens a NEW run within the workspace and a NEW client loop within
// that worker; the client loop closes on disconnect.

import type { Db, PrepMethod } from "../core/Db.ts";
import GitMembership from "../core/git-membership.ts";
import Owner from "../core/Owner.ts";

export interface WorkspaceRow {
    id: number;
    name: string;
    project_root: string | null;
    created_at: string;
    cost_pico: number;
}

export interface WorkerRow {
    id: number;
    name: string;
    created_at: string;
    cost_pico: number;
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
        const count = await (db.envelope_count_workers_by_prefix as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, name_prefix: `${prefix}-%` });
        let n = (count?.n ?? 0) + 1;
        // A manually-named squatter (`model-3` typed by a user) can hold the ordinal — bump past it.
        while (await (db.envelope_get_worker_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: `${prefix}-${n}` }) !== undefined) n++;
        return `${prefix}-${n}`;
    }

    static async createClientEnvelope(db: Db, opts: { name?: string; prefix?: string; projectRoot?: string | null; settings?: string } = {}): Promise<ClientEnvelope> {
        const name = opts.name ?? Envelope.#tsName(opts.prefix ?? "workspace");
        const projectRoot = opts.projectRoot ?? null;
        const workspace = await (db.envelope_insert_workspace as PrepMethod).get<{ id: number; name: string; project_root: string | null }>({ name, project_root: projectRoot, settings: opts.settings ?? "{}" });
        if (workspace === undefined) throw new Error("createClientEnvelope: workspace insert returned no row");
        // SPEC §membership D4 — establish git-ls-files membership at workspace setup so
        // tracked files are members before the first op. No-op when projectRoot is
        // null (headless) or not a git working tree.
        await GitMembership.resolveGitMembership(db, workspace.id, undefined);
        const workerName = await Envelope.mintWorkerName(db, workspace.id, "client");
        const run = await (db.envelope_insert_worker as PrepMethod).get<{ id: number; name: string }>({ workspace_id: workspace.id, name: workerName, origin: "client" });
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
            throw new Error("attachToWorkspace: pass workerId OR workerName, not both");
        }
        if (opts.workerId !== undefined) {
            const existing = await (db.envelope_get_worker_by_id as PrepMethod).get<{ id: number; name: string; workspace_id: number }>({ id: opts.workerId });
            if (existing === undefined) throw new Error(`run ${opts.workerId} not found`);
            if (existing.workspace_id !== workspaceId) throw new Error(`run ${opts.workerId} belongs to workspace ${existing.workspace_id}, not ${workspaceId}`);
            return { id: existing.id, name: existing.name };
        }
        if (opts.workerName !== undefined) {
            if (Envelope.RESERVED_RUN_NAMES.has(opts.workerName.toLowerCase())) {
                throw new Error(`worker name "${opts.workerName}" is reserved for a non-client actor`);
            }
            const existing = await (db.envelope_get_worker_by_name as PrepMethod).get<{ id: number; name: string }>({ workspace_id: workspaceId, name: opts.workerName });
            if (existing !== undefined) return existing;
            const created = await (db.envelope_insert_worker as PrepMethod).get<{ id: number; name: string }>({ workspace_id: workspaceId, name: opts.workerName, origin: "client" });
            if (created === undefined) throw new Error("resolveWorker: run insert returned no row");
            return created;
        }
        const created = await (db.envelope_insert_worker as PrepMethod).get<{ id: number; name: string }>({ workspace_id: workspaceId, name: await Envelope.mintWorkerName(db, workspaceId, "client"), origin: "client" });
        if (created === undefined) throw new Error("resolveWorker: run insert returned no row");
        return created;
    }

    static async attachToWorkspace(db: Db, workspaceId: number, opts: { workerId?: number; workerName?: string } = {}): Promise<ClientEnvelope> {
        const workspace = await (db.envelope_get_workspace as PrepMethod).get<{ id: number; name: string; project_root: string | null }>({ id: workspaceId });
        if (workspace === undefined) throw new Error(`workspace ${workspaceId} not found`);
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
        const loop = await (db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ worker_id: workerId });
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
        if (name !== undefined && Owner.RESERVED.has(name.toLowerCase())) throw new Error(`worker name "${name}" is reserved`);
        const run = await (db.envelope_insert_worker as PrepMethod).get<{ id: number; name: string }>({ workspace_id: workspaceId, name: name ?? await Envelope.mintWorkerName(db, workspaceId, "model"), origin: "model" });
        if (run === undefined) throw new Error("createModelWorker: run insert returned no row");
        return run;
    }

    static async ensureModelWorker(db: Db, workspaceId: number): Promise<number> {
        // #371 — ensure means FIND-FIRST (the WS connection's per-workspace cache used to hide the
        // insert-only bug; the seam has no connection state, so idempotence lives HERE): reuse the
        // workspace's canonical conversation worker — the earliest model-origin root (forks/workers
        // inherit origin and are excluded by parent_worker_id). #366 is the explicit fresh-run door.
        const existing = await (db.envelope_get_model_worker as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId });
        if (existing !== undefined) return existing.id;
        const run = await (db.envelope_insert_worker as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: await Envelope.mintWorkerName(db, workspaceId, "model"), origin: "model" });
        if (run === undefined) throw new Error("ensureModelWorker: run insert returned no row");
        return run.id;
    }

    // Self-hosting keystone (§actor-boundary): the workspace's reserved `plurnk` run, where the
    // runtime acts as an ordinary actor (doc materialization today; fs/git work
    // later). One per workspace, reused; its log is the runtime's own — invisible
    // to other workers except through the shared workspace filesystem.
    static async ensurePlurnkWorker(db: Db, workspaceId: number): Promise<number> {
        const existing = await (db.envelope_get_worker_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        if (existing !== undefined) return existing.id;
        const run = await (db.envelope_insert_worker as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "plurnk" });
        if (run === undefined) throw new Error("ensurePlurnkWorker: run insert returned no row");
        return run.id;
    }

    static async listWorkersForWorkspace(db: Db, workspaceId: number): Promise<WorkerRow[]> {
        return await (db.envelope_list_workers_for_workspace as PrepMethod).all<WorkerRow>({ workspace_id: workspaceId });
    }

    // #238 — a workspace's prior user prompts, newest-first, capped. The conversation worker's
    // loop seeds (engine_get_loop_prompt is the per-loop read); exposed directly so a
    // client seeds up/down history without log archaeology.
    static async listPromptsForWorkspace(db: Db, workspaceId: number, limit: number): Promise<string[]> {
        const rows = await (db.envelope_list_workspace_prompts as PrepMethod).all<{ prompt: string }>({ workspace_id: workspaceId, limit });
        return rows.map((r) => r.prompt);
    }

    static async closeClientLoop(db: Db, loopId: number, status: 200 | 499): Promise<void> {
        await (db.envelope_close_client_loop as PrepMethod).run({ status, loop_id: loopId });
    }

    static async listWorkspaces(db: Db): Promise<WorkspaceRow[]> {
        return await (db.envelope_list_workspaces as PrepMethod).all<WorkspaceRow>();
    }

    // workspace.rename — the workspace name is a mutable handle (vs a worker's immutable
    // name, §machine-processes). Mutates workspaces.name only; the UNIQUE constraint is
    // the real guard against collision (the handler pre-checks for a clean error).
    static async updateWorkspaceName(db: Db, workspaceId: number, name: string): Promise<string> {
        const row = await (db.envelope_set_workspace_name as PrepMethod).get<{ id: number; name: string }>({ id: workspaceId, name });
        if (row === undefined) throw new Error(`workspace ${workspaceId} not found`);
        return row.name;
    }
}

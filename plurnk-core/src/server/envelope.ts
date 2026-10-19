// Envelope lifecycle helpers for module clients. SPEC {§connection-lifecycle}.
//
// A client-interface module receives this value from an explicit workspace create
// or attach call. Binding a workspace mints nothing and retains no transport binding;
// each client operation allocates and settles its own administrative loop in the runtime worker.

import AdministrativeLoop from "../core/AdministrativeLoop.ts";
import type { Db } from "../core/Db.ts";
import crypto from "node:crypto";
import GitMembership from "../core/git-membership.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import WorkerName from "../core/WorkerName.ts";
import { lifecycleOfLoopStatus, selectWorkerLoop, type ApplicationWorkerKind, type ClientEnvelope, type LoopLifecycle as WorkerLifecycle } from "@plurnk/plurnk-contracts";

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
}

// The stored envelope; the daemon adds the folder's label, which needs its home ({§workspace-label}).
export type WorkspaceEnvelope = Omit<ClientEnvelope, "projectLabel">;

export interface WorkerRow {
    id: number;
    name: string;
    created_at: string;
    origin: "model" | "_plurnk";
    owner: string;
    parentWorkerId: number | null;
    // {§application-worker-observation}
    kind: ApplicationWorkerKind;
    lifecycle: WorkerLifecycle;
}

export const projectWorkerRow = <T extends { loopObservations: string }>(row: T): Omit<T, "loopObservations"> & { lifecycle: WorkerLifecycle } => {
    const { loopObservations, ...rest } = row;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§validation-topology}: the worker query's loop observations, as its SQL aggregates them
    const loops = JSON.parse(loopObservations) as Array<{ status: number; sequence: number; terminatedAt: string | null }>;
    return { ...rest, lifecycle: lifecycleOfLoopStatus(selectWorkerLoop(loops)?.status) };
};

export interface WorkerQuery {
    origin?: WorkerRow["origin"];
    parentWorkerId?: number | null;
}

export default class Envelope {
    // {§workspace-auto-name} — five characters from the line-anchor alphabet, no prefix:
    // a name says nothing about where the workspace came from.
    static readonly AUTO_NAME_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    static generateWorkspaceName(): string {
        let name: string;
        do {
            name = Array.from({ length: 5 }, () => Envelope.AUTO_NAME_ALPHABET[crypto.randomInt(Envelope.AUTO_NAME_ALPHABET.length)]).join("");
        } while (!/[A-Za-z]/u.test(name));
        return name;
    }

    static async createClientEnvelope(db: Db, opts: { name?: string; projectRoot?: string | null; settings?: string } = {}): Promise<WorkspaceEnvelope> {
        const projectRoot = opts.projectRoot ?? null;
        const insert = (name: string) => db.envelope_insert_workspace.get<{ id: number; name: string; project_root: string | null }>({ name, project_root: projectRoot, settings: opts.settings ?? "{}" });
        let workspace = opts.name === undefined ? undefined : await insert(opts.name);
        // An auto-name is unique by construction: a colliding draw is redrawn, never surfaced.
        while (workspace === undefined && opts.name === undefined) workspace = await insert(Envelope.generateWorkspaceName());
        if (workspace === undefined) {
            const name = opts.name!;
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
        return { workspaceId: workspace.id, workspaceName: workspace.name, projectRoot: workspace.project_root };
    }

    static async attachToWorkspace(db: Db, workspaceId: number): Promise<WorkspaceEnvelope> {
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
        return { workspaceId: workspace.id, workspaceName: workspace.name, projectRoot: workspace.project_root };
    }

    // Client operation loop allocator. One operation allocates one administrative loop, opened by its
    // actor ({§actor-boundary-client-operations}); its statements become ordered turns and settlement closes it.
    static async ensureClientLoop(db: Db, workerId: number, actor: string): Promise<number> {
        return (await AdministrativeLoop.open(db, workerId, actor)).id;
    }

    // Model-worker allocator ({§machine-processes}). A person's client operations journal in the runtime
    // worker, never here, so the packet, rendered from the model worker, never carries them
    // ({§connection-lifecycle}). The module resolves and retains the binding.
    // {§methods-worker-create}: a fresh worker is a named, empty-log, model-origin worker,
    // distinct from a history-copying fork.
    static async createModelWorker(db: Db, workspaceId: number, name?: string, parentWorkerId?: number, owner?: string): Promise<{ id: number; name: string }> {
        const options = { workspaceId, parentWorkerId, owner, origin: "model" as const };
        return name === undefined
            ? WorkerName.claimAuto(db, options)
            : WorkerName.claimNamed(db, name, options);
    }

    static async listWorkersForWorkspace(
        db: Db,
        workspaceId: number,
        query: WorkerQuery = {},
    ): Promise<WorkerRow[]> {
        const filterParent = Object.hasOwn(query, "parentWorkerId");
        const rows = await db.envelope_list_workers_for_workspace.all<Omit<WorkerRow, "lifecycle"> & { loopObservations: string }>({
            workspace_id: workspaceId,
            origin: query.origin ?? null,
            filter_parent: filterParent ? 1 : 0,
            parent_worker_id: query.parentWorkerId ?? null,
        });
        return rows.map(projectWorkerRow);
    }

    // {§methods-workspace-prompts}: expose root-worker loop seeds directly,
    // without forcing clients to reconstruct prompt history from log rows.
    static async listPromptsForWorkspace(db: Db, workspaceId: number, limit: number, workerId: number | null): Promise<string[]> {
        const rows = await db.envelope_list_workspace_prompts.all<{ prompt: string }>({ workspace_id: workspaceId, limit, worker_id: workerId });
        return rows.map((r) => r.prompt);
    }

    static async closeClientLoop(db: Db, loopId: number, result: SchemeResult): Promise<void> {
        const exact = structuredClone(Results.assert(result));
        if (exact.problem !== undefined && exact.problem.instance === undefined) {
            Results.attachInstance(exact, await LoopLifecycle.address(db, loopId));
        }
        await db.envelope_close_client_loop.run({
            status: LoopLifecycle.projectStatus(exact.status),
            result: JSON.stringify(exact),
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

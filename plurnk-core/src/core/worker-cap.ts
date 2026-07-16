import type { Db, PrepMethod } from "./Db.ts";

// Workspace-tier ceiling on CONCURRENT active runs (a run with a non-terminal loop)
// — the fork-bomb / destabilization brake. `PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE` is the
// knob; -1 / unset / invalid = no cap. Only concurrency is bounded, never lifetime:
// workspaces persist for months, so a total-created cap would punish longevity. A
// spawn/fork past the ceiling fails hard (508) — no queue, no retry. Checked at the
// single run-creation site (Dispatcher.#handleWorkerCopy, which both spawns and forks); irc is
// exempt — it targets an existing run and creates nothing.
export default class WorkerCap {
    static async deny(db: Db, workspaceId: number): Promise<{ status: number; error: string } | null> {
        const raw = process.env.PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE;
        const cap = raw === undefined || raw.length === 0 ? -1 : Number.parseInt(raw, 10);
        if (!Number.isFinite(cap) || cap < 0) return null; // no cap
        const row = await (db.worker_count_active as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId });
        if ((row?.n ?? 0) >= cap) return { status: 508, error: `workspace active-run ceiling reached (PLURNK_SERVICE_WORKSPACE_WORKERS_MAX_ACTIVE=${cap})` };
        return null;
    }
}

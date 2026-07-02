import type { Db, PrepMethod } from "./Db.ts";

// Session-tier ceiling on CONCURRENT active runs (a run with a non-terminal loop)
// — the fork-bomb / destabilization brake. `PLURNK_SESSION_RUNS_MAX_ACTIVE` is the
// knob; -1 / unset / invalid = no cap. Only concurrency is bounded, never lifetime:
// sessions persist for months, so a total-created cap would punish longevity. A
// spawn/fork past the ceiling fails hard (508) — no queue, no retry. Checked at the
// single run-creation site (Dispatcher.#handleRunCopy, which both spawns and forks); irc is
// exempt — it targets an existing run and creates nothing.
export default class RunCap {
    static async deny(db: Db, sessionId: number): Promise<{ status: number; error: string } | null> {
        const raw = process.env.PLURNK_SESSION_RUNS_MAX_ACTIVE;
        const cap = raw === undefined || raw.length === 0 ? -1 : Number.parseInt(raw, 10);
        if (!Number.isFinite(cap) || cap < 0) return null; // no cap
        const row = await (db.run_count_active as PrepMethod).get<{ n: number }>({ session_id: sessionId });
        if ((row?.n ?? 0) >= cap) return { status: 508, error: `session active-run ceiling reached (PLURNK_SESSION_RUNS_MAX_ACTIVE=${cap})` };
        return null;
    }
}

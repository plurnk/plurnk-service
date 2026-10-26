import type { Db } from "./Db.ts";
import type { SchemeResult } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";

// Workspace-tier ceiling on CONCURRENT active sessions (a session with a non-terminal loop)
// — the fork-bomb / destabilization brake. `PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE` is the
// knob; -1 / unset / invalid = no cap. Only concurrency is bounded, never lifetime:
// workspaces persist for months, so a total-created cap would punish longevity. A
// spawn/fork past the ceiling fails hard (508) — no queue, no retry. Checked at the
// single session-creation site (Dispatcher.#handleSessionControl, which both spawns and forks); IRC is
// exempt — it targets an existing session and creates nothing.
export default class SessionCap {
    static async deny(db: Db, workspaceId: number): Promise<SchemeResult | null> {
        const raw = process.env.PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE;
        const cap = raw === undefined || raw.length === 0 ? -1 : Number.parseInt(raw, 10);
        if (!Number.isFinite(cap) || cap < 0) return null; // no cap
        const row = await db.session_count_active.get<{ n: number }>({ workspace_id: workspaceId });
        const activeSessions = row?.n ?? 0;
        if (activeSessions >= cap) {
            return Results.failure(
                "engine:session",
                "active-session-limit-reached",
                508,
                `The workspace has ${activeSessions} active sessions, reaching its limit of ${cap}.`,
                {},
                {
                    activeSessions,
                    maximumActiveSessions: cap,
                    stage: "session-admission",
                    recovery: "Wait for an active session to finish or KILL one before creating another.",
                    retryable: false,
                },
            );
        }
        return null;
    }
}

// {§search-gate} (#406, owner ruling) — the search cost gates, rail-family shape: in-memory
// per-loop accounting cleaned at the same seam as strikes/notices, restart-drop accepted
// (a post-restart duplicate just re-fetches; the TTL makes that cheap).
//
//   Dedup — an IDENTICAL (runtime, command) already run in this loop STRIKES and SERVES: the
//   result is status 409 (a turn failure — the strike rail counts it, the failed-ops gate holds
//   the terminal a turn) CARRYING the prior ranked digest, re-read live from the original
//   exec entry so it includes final materialization verdicts. No provenance prose, no re-fetch (owner:
//   "strike on identical, duplicate searches, and return the same results").
//
//   Cap — the (N+1)th search in one TURN is flood control: 429, a legible steer, nothing served.
const DEDUP_KEY = (runtime: string, command: string): string => `${runtime}\0${command}`;

export type GateVerdict =
    | { verdict: "pass" }
    | { verdict: "duplicate"; priorPathname: string }
    | { verdict: "capped"; cap: number };

export default class SearchGate {
    // loopId → (runtime\0command → the prior exec entry's coordinate pathname)
    readonly #seen = new Map<number, Map<string, string>>();
    // Spawns are ASYNC: dispatch accepts before run() succeeds or fails, so registration is
    // two-phase — pending at dispatch, promoted to seen only when the stream concludes 200
    // (a failed search must never poison the retry with a dead duplicate).
    readonly #pending = new Map<string, { loopId: number; turnId: number; runtime: string; command: string }>();
    // loopId → this turn's search count (self-resets when the turn changes)
    readonly #turnCount = new Map<number, { turnId: number; n: number }>();

    #runtimes(): Set<string> {
        const v = process.env.PLURNK_SERVICE_SEARCH_RUNTIMES;
        if (v === undefined) throw new Error("PLURNK_SERVICE_SEARCH_RUNTIMES is unset — the .env.defaults floor must declare it");
        return new Set(v.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
    }

    #cap(): number {
        const v = process.env.PLURNK_SERVICE_SEARCH_MAX_PER_TURN;
        if (v === undefined) throw new Error("PLURNK_SERVICE_SEARCH_MAX_PER_TURN is unset — the .env.defaults floor must declare it");
        return Number.parseInt(v, 10);
    }

    // Pre-dispatch. Only search runtimes are gated; everything else passes untouched.
    check(loopId: number, turnId: number, runtime: string, command: string): GateVerdict {
        if (!this.#runtimes().has(runtime)) return { verdict: "pass" };
        const prior = this.#seen.get(loopId)?.get(DEDUP_KEY(runtime, command));
        if (prior !== undefined) return { verdict: "duplicate", priorPathname: prior };
        const cap = this.#cap();
        const count = this.#turnCount.get(loopId);
        const n = count !== undefined && count.turnId === turnId ? count.n : 0;
        if (cap > 0 && n >= cap) return { verdict: "capped", cap };
        return { verdict: "pass" };
    }

    // Post-dispatch: the ATTEMPT counts toward the per-turn cap immediately (flood control
    // counts attempts), but dedup registration stays PENDING until the stream concludes 200.
    registerPending(loopId: number, turnId: number, runtime: string, command: string, pathname: string): void {
        if (!this.#runtimes().has(runtime)) return;
        this.#pending.set(pathname, { loopId, turnId, runtime, command });
        const count = this.#turnCount.get(loopId);
        if (count !== undefined && count.turnId === turnId) count.n += 1;
        else this.#turnCount.set(loopId, { turnId, n: 1 });
    }

    // The stream concluded — promote (200) or drop (anything else). Non-search pathnames
    // were never pending, so this is a cheap no-op for every other stream.
    settle(pathname: string, closeStatus: number): void {
        const p = this.#pending.get(pathname);
        if (p === undefined) return;
        this.#pending.delete(pathname);
        if (closeStatus !== 200) return;
        let loopSeen = this.#seen.get(p.loopId);
        if (loopSeen === undefined) { loopSeen = new Map(); this.#seen.set(p.loopId, loopSeen); }
        loopSeen.set(DEDUP_KEY(p.runtime, p.command), pathname);
    }

    // The rail-family seam — Engine.cleanup(loopId) calls this with the rest.
    cleanup(loopId: number): void {
        this.#seen.delete(loopId);
        this.#turnCount.delete(loopId);
        for (const [pathname, p] of this.#pending) if (p.loopId === loopId) this.#pending.delete(pathname);
    }
}

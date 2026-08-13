// {§search-gate} — per-loop duplicate accounting and per-turn flood control.
// Duplicate runtime+query pairs serve the prior durable result; over-cap
// searches are refused without execution.
const DEDUP_KEY = (runtime: string, query: string): string => `${runtime}\0${query}`;

export type GateVerdict =
    | { verdict: "pass" }
    | { verdict: "duplicate"; priorPathname: string }
    | { verdict: "capped"; cap: number };

export default class SearchGate {
    // loopId → (runtime\0query → the prior exec entry's coordinate pathname)
    readonly #seen = new Map<number, Map<string, string>>();
    // Spawns are ASYNC: dispatch accepts before run() succeeds or fails, so registration is
    // two-phase — pending at dispatch, promoted to seen only when the stream concludes 200
    // (a failed search must never poison the retry with a dead duplicate).
    readonly #pending = new Map<string, { loopId: number; turnId: number; runtime: string; query: string }>();
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
    check(loopId: number, turnId: number, runtime: string, query: string): GateVerdict {
        if (!this.#runtimes().has(runtime)) return { verdict: "pass" };
        const prior = this.#seen.get(loopId)?.get(DEDUP_KEY(runtime, query));
        if (prior !== undefined) return { verdict: "duplicate", priorPathname: prior };
        const cap = this.#cap();
        const count = this.#turnCount.get(loopId);
        const n = count !== undefined && count.turnId === turnId ? count.n : 0;
        if (cap > 0 && n >= cap) return { verdict: "capped", cap };
        return { verdict: "pass" };
    }

    // Post-dispatch: the ATTEMPT counts toward the per-turn cap immediately (flood control
    // counts attempts), but dedup registration stays PENDING until the stream concludes 200.
    registerPending(loopId: number, turnId: number, runtime: string, query: string, pathname: string): void {
        if (!this.#runtimes().has(runtime)) return;
        this.#pending.set(pathname, { loopId, turnId, runtime, query });
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
        loopSeen.set(DEDUP_KEY(p.runtime, p.query), pathname);
    }

    // The rail-family seam — Engine.cleanup(loopId) calls this with the rest.
    cleanup(loopId: number): void {
        this.#seen.delete(loopId);
        this.#turnCount.delete(loopId);
        for (const [pathname, p] of this.#pending) if (p.loopId === loopId) this.#pending.delete(pathname);
    }
}

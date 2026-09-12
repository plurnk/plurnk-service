// {§retention-policy} — the operator's retention policy, read once from the environment and run
// as set statements: on the daemon's cadence while it runs, and as a shutdown step before the
// planner statistics. Information is kept by default; only what no row references is collected.
import type { Db } from "../core/Db.ts";

export interface RetentionPolicy {
    readonly retainPacketTurns: number;   // -1 = every packet
    readonly retainPacketMs: number;      // -1 = no age limit
    readonly collectPacketItems: boolean;
    readonly collectDerivations: boolean;
    readonly intervalMs: number;          // 0 = shutdown only
}

const readBound = (env: NodeJS.ProcessEnv, name: string, floor: number): number => {
    const raw = env[name];
    const value = Number(raw);
    if (raw === undefined || !Number.isSafeInteger(value) || value < floor) {
        throw new Error(`${name} must be ${floor === -1 ? "-1 or a non-negative" : "a non-negative"} safe integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

const readFlag = (env: NodeJS.ProcessEnv, name: string): boolean => {
    const raw = env[name];
    if (raw !== "0" && raw !== "1") throw new Error(`${name} must be 0 or 1; got ${JSON.stringify(raw)}.`);
    return raw === "1";
};

export const retentionPolicy = (env: NodeJS.ProcessEnv = process.env): RetentionPolicy => ({
    retainPacketTurns: readBound(env, "PLURNK_SERVICE_RETAIN_PACKET_TURNS", -1),
    retainPacketMs: readBound(env, "PLURNK_SERVICE_RETAIN_PACKET_MS", -1),
    collectPacketItems: readFlag(env, "PLURNK_SERVICE_COLLECT_PACKET_ITEMS"),
    collectDerivations: readFlag(env, "PLURNK_SERVICE_COLLECT_DERIVATIONS"),
    intervalMs: readBound(env, "PLURNK_SERVICE_RETENTION_INTERVAL_MS", 0),
});

export default class Retention {
    readonly #db: Db;
    readonly #policy: RetentionPolicy;
    #timer: ReturnType<typeof setInterval> | null = null;

    constructor(db: Db, policy: RetentionPolicy) {
        this.#db = db;
        this.#policy = policy;
    }

    get policy(): RetentionPolicy { return this.#policy; }

    // One pass, in dependency order: compositions retire first, then the items and derivations
    // nothing references. Each statement is a no-op under the default policy.
    async run(now: number = Date.now()): Promise<{ retiredPackets: number; collectedItems: number; collectedDerivations: number }> {
        const { retainPacketTurns, retainPacketMs, collectPacketItems, collectDerivations } = this.#policy;
        const packets = await this.#db.retention_retire_packets.run({ keep_turns: retainPacketTurns, keep_ms: retainPacketMs, now_ms: now });
        const items = await this.#db.retention_collect_packet_items.run({ collect: collectPacketItems ? 1 : 0 });
        const derivations = await this.#db.retention_collect_derivations.run({ collect: collectDerivations ? 1 : 0 });
        return { retiredPackets: packets.changes, collectedItems: items.changes, collectedDerivations: derivations.changes };
    }

    // The cadence: unref'd so an idle daemon still exits; a pass that fails reports through the
    // caller's handler and does not stop the cadence.
    start(onError: (cause: unknown) => void): void {
        if (this.#policy.intervalMs === 0 || this.#timer !== null) return;
        this.#timer = setInterval(() => { this.run().catch(onError); }, this.#policy.intervalMs);
        this.#timer.unref();
    }

    stop(): void {
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
    }
}

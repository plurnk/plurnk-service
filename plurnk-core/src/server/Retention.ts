// {§retention-policy} — the operator's retention policy, read once from the environment and run
// as set statements: on the daemon's cadence while it runs, and as a shutdown step before the
// planner statistics. Information is kept by default; only what no row references is collected.
import type { Db } from "../core/Db.ts";
import { Knob } from "@plurnk/plurnk-meta";
import DerivationUse from "../schemes/_derivation-use.ts";

export interface RetentionPolicy {
    readonly retainPacketTurns: number;   // -1 = every packet
    readonly retainPacketMs: number;      // -1 = no age limit
    readonly retainResponseTurns: number; // -1 = every response body
    readonly retainResponseMs: number;    // -1 = no age limit
    readonly collectPacketItems: boolean;
    readonly collectDerivations: boolean;
    readonly collectContents: boolean;
    readonly intervalMs: number;          // 0 = shutdown only
    readonly autoVacuum: AutoVacuum;
    readonly reclaimMinFreeBytes: number; // 0 = reclaim every pass
}

export type AutoVacuum = "incremental" | "none";

// SQLite's PRAGMA auto_vacuum codes for the modes the daemon manages.
const AUTO_VACUUM_CODE: Readonly<Record<AutoVacuum, number>> = Object.freeze({ none: 0, incremental: 2 });

export const retentionPolicy = (env: NodeJS.ProcessEnv = process.env): RetentionPolicy => ({
    retainPacketTurns: Knob.integer("PLURNK_SERVICE_RETAIN_PACKET_TURNS", -1, env),
    retainPacketMs: Knob.integer("PLURNK_SERVICE_RETAIN_PACKET_MS", -1, env),
    retainResponseTurns: Knob.integer("PLURNK_SERVICE_RETAIN_RESPONSE_TURNS", -1, env),
    retainResponseMs: Knob.integer("PLURNK_SERVICE_RETAIN_RESPONSE_MS", -1, env),
    collectPacketItems: Knob.flag("PLURNK_SERVICE_COLLECT_PACKET_ITEMS", env),
    collectDerivations: Knob.flag("PLURNK_SERVICE_COLLECT_DERIVATIONS", env),
    collectContents: Knob.flag("PLURNK_SERVICE_COLLECT_CONTENTS", env),
    intervalMs: Knob.integer("PLURNK_SERVICE_RETENTION_INTERVAL_MS", 0, env),
    autoVacuum: Knob.choice("PLURNK_SERVICE_AUTO_VACUUM", ["incremental", "none"], env),
    reclaimMinFreeBytes: Knob.integer("PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES", 0, env),
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

    // One pass, in dependency order: compositions and response bodies retire first, then the
    // items and derivations nothing references. Each statement is a no-op under the default policy.
    // {§db-space-reclamation} — once per open: a database whose auto-vacuum mode differs from the
    // policy's is converted (a mode change takes effect through one VACUUM). Runs before any drain.
    async prepareStorage(): Promise<{ converted: boolean; pagesBefore: number; pagesAfter: number }> {
        const before = await this.#pages();
        const mode = await this.#db.retention_auto_vacuum_mode.get<{ auto_vacuum: number }>({});
        if (mode?.auto_vacuum === AUTO_VACUUM_CODE[this.#policy.autoVacuum]) return { converted: false, pagesBefore: before.pages, pagesAfter: before.pages };
        if (this.#policy.autoVacuum === "incremental") await this.#db.retention_convert_incremental({});
        else await this.#db.retention_convert_none({});
        const after = await this.#pages();
        return { converted: true, pagesBefore: before.pages, pagesAfter: after.pages };
    }

    async #pages(): Promise<{ pages: number; free: number; pageSize: number }> {
        const row = await this.#db.retention_page_counts.get<{ pages: number; free: number; pageSize: number }>({});
        if (row === undefined) throw new Error("page counts are unavailable");
        return row;
    }

    async run(now: number = Date.now()): Promise<{ retiredPackets: number; retiredResponses: number; collectedItems: number; collectedDerivations: number; collectedContents: number; reclaimedPages: number }> {
        const { retainPacketTurns, retainPacketMs, retainResponseTurns, retainResponseMs, collectPacketItems, collectDerivations, collectContents } = this.#policy;
        const packets = await this.#db.retention_retire_packets.run({ keep_turns: retainPacketTurns, keep_ms: retainPacketMs, now_ms: now });
        const responses = await this.#db.retention_retire_responses.run({ keep_turns: retainResponseTurns, keep_ms: retainResponseMs, now_ms: now });
        const items = await this.#db.retention_collect_packet_items.run({ collect: collectPacketItems ? 1 : 0 });
        const collected = await DerivationUse.collect(this.#db, async () => {
            const derivations = await this.#db.retention_collect_derivations.run({ collect: collectDerivations ? 1 : 0 });
            const contents = await this.#db.retention_collect_contents.run({ collect: collectContents ? 1 : 0 });
            return { derivations: derivations.changes, contents: contents.changes };
        });
        const reclaimedPages = await this.#reclaim();
        // `.run`, not `.all`: `.all` is served by a read-only reader, and a checkpoint there is an I/O error.
        await this.#db.retention_wal_truncate.run({});
        return { retiredPackets: packets.changes, retiredResponses: responses.changes, collectedItems: items.changes, collectedDerivations: collected?.derivations ?? 0, collectedContents: collected?.contents ?? 0, reclaimedPages };
    }

    // {§db-space-reclamation} — free pages go back to the OS once they reach the policy's floor;
    // below it they stay for SQLite to reuse. Under auto_vacuum=none there is nothing to step.
    async #reclaim(): Promise<number> {
        if (this.#policy.autoVacuum === "none") return 0;
        const { free, pageSize } = await this.#pages();
        if (free === 0 || free * pageSize < this.#policy.reclaimMinFreeBytes) return 0;
        // SQLite frees one page per step of this pragma; stepping it to completion frees them all.
        await this.#db.retention_incremental_vacuum.all({});
        return free - (await this.#pages()).free;
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

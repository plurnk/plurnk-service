// {§derivation-dedup-parallel} #416 — the pump groups pending entries by content_hash so each
// unique content derives once (dedup preserved under concurrency), runs unique reps with bounded
// concurrency, and releases each rep's duplicates immediately. This pins the SCHEDULING contract:
// every pending entry is fully derived exactly once, without a global tail barrier.
import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingVector } from "@plurnk/plurnk-mimetypes";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, seedEntryWithChannel, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const runPump = async (concurrency: string): Promise<{ stamped: number; maxActive: number }> => {
    const prev = process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
    process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = concurrency;
    const db = await openMigrated();
    try {
        let active = 0;
        let maxActive = 0;
        const mimetypes = new Proxy(DEFAULT_MIMETYPES, {
            get(target, property, receiver) {
                if (property === "process") {
                    return async (...args: Parameters<typeof DEFAULT_MIMETYPES.process>) => {
                        active++;
                        maxActive = Math.max(maxActive, active);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                        try { return await target.process(...args); } finally { active--; }
                    };
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const workspaceId = await insertWorkspace(db, `derive-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        // A mix: distinct contents + a triplet of identical content (the dedup case).
        for (let i = 0; i < 8; i++) await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: `/u${i}`, channel: "body", content: `distinct entry number ${i}`, mimetype: "text/markdown" });
        for (let i = 0; i < 3; i++) await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: `/dup${i}`, channel: "body", content: "identical shared body across three entries", mimetype: "text/markdown" });
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        // Every body entry has a stamped deep_hash — fully derived exactly once.
        const stamped = await db.test_count_stamped_deep_hash.get<{ n: number }>({ workspace_id: workspaceId });
        return { stamped: stamped?.n ?? 0, maxActive };
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY; else process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = prev;
        await db.close();
    }
};

test("every pending entry is derived once — identical at sequential, bounded, and host-sized concurrency (#416)", async () => {
    const seq = await runPump("1");
    const par = await runPump("4");
    const host = await runPump("-1");
    assert.equal(seq.stamped, 11, "concurrency 1: all 11 body entries stamped");
    assert.equal(seq.maxActive, 1, "concurrency 1 remains sequential");
    assert.equal(par.stamped, 11, "concurrency 4: identical — bounded concurrency neither skips nor double-derives");
    assert.equal(par.maxActive, 4, "different entries actually overlap at the configured bound");
    assert.equal(host.stamped, 11, "concurrency -1: host-sized scheduling preserves the same derivation result");
    assert.ok(host.maxActive > 1, "host-sized scheduling is genuinely parallel");
});

test("a completed representative releases its duplicates while an unrelated representative is still blocked (#588)", async () => {
    const previousConcurrency = process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
    const previousDisable = process.env.PLURNK_SERVICE_EMBED_DISABLE;
    process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = "2";
    process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";
    const db = await openMigrated();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((accept) => { releaseSlow = accept; });
    try {
        const vector = EmbeddingVector.encode([1, 0]);
        const mimetypes = new Proxy(DEFAULT_MIMETYPES, {
            get(target, property, receiver) {
                if (property === "embedderInfo") return async () => ({
                    dimension: 2,
                    contextWindow: 512,
                    countTokens: async (text: string) => Math.ceil(text.length / 4),
                    model: "progressive-dedup-test",
                });
                if (property === "embedBatch") return async (texts: readonly string[]) => texts.map(() => vector);
                if (property === "process") {
                    return async (...args: Parameters<typeof DEFAULT_MIMETYPES.process>) => {
                        if (typeof args[0]?.content === "string" && args[0].content.startsWith("slow unique")) await slowGate;
                        return target.process(...args);
                    };
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const workspaceId = await insertWorkspace(db, `progressive-dedup-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        for (let i = 0; i < 3; i++) {
            await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: `/dup${i}`, channel: "body", content: "same", mimetype: "text/markdown" });
        }
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/slow", channel: "body", content: `slow unique ${"content ".repeat(40)}`, mimetype: "text/markdown" });

        let twoCompleted!: () => void;
        const reachedTwo = new Promise<void>((accept) => { twoCompleted = accept; });
        const pump = SearchIndex.maintain(makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            mimetypes,
            pushNotice: (notice) => {
                if (notice.kind === "embed_progress" && notice.completed === 2) twoCompleted();
            },
        }));
        await Promise.race([
            reachedTwo,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("duplicates remained behind the slow representative")), 2_000)),
        ]);
        const duringSlow = await db.test_count_stamped_deep_hash.get<{ n: number }>({ workspace_id: workspaceId });
        assert.ok((duringSlow?.n ?? 0) >= 2, "the fast representative and a sibling stamp before the slow group completes");
        releaseSlow();
        await pump;
        const final = await db.test_count_stamped_deep_hash.get<{ n: number }>({ workspace_id: workspaceId });
        assert.equal(final?.n, 4, "all entries complete after the slow representative is released");
    } finally {
        releaseSlow();
        if (previousConcurrency === undefined) delete process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY; else process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = previousConcurrency;
        if (previousDisable === undefined) delete process.env.PLURNK_SERVICE_EMBED_DISABLE; else process.env.PLURNK_SERVICE_EMBED_DISABLE = previousDisable;
        await db.close();
    }
});

// [§derivation-dedup-parallel] #416 — the pump groups pending entries by content_hash so each
// unique content derives once (dedup preserved under concurrency), and runs the unique reps with
// bounded concurrency so their embeds overlap and saturate the embedder pool. This pins the
// SCHEDULING contract: every pending entry is fully derived (deep_hash stamped) exactly once,
// identical at concurrency 1 and >1 — no entry skipped, no double-stamp, order-independent.
import test from "node:test";
import assert from "node:assert/strict";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
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
        for (let i = 0; i < 8; i++) await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: `/u${i}`, channel: "body", content: `distinct entry number ${i}`, mimetype: "text/markdown" });
        for (let i = 0; i < 3; i++) await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: `/dup${i}`, channel: "body", content: "identical shared body across three entries", mimetype: "text/markdown" });
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        // Every body entry has a stamped deep_hash — fully derived exactly once.
        const stamped = await (db.test_count_stamped_deep_hash as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId });
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

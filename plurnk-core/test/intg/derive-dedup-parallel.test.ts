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

const runPump = async (concurrency: string): Promise<number> => {
    const prev = process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
    process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = concurrency;
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `derive-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        // A mix: distinct contents + a triplet of identical content (the dedup case).
        for (let i = 0; i < 8; i++) await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: `/u${i}`, channel: "body", content: `distinct entry number ${i}`, mimetype: "text/markdown" });
        for (let i = 0; i < 3; i++) await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: `/dup${i}`, channel: "body", content: "identical shared body across three entries", mimetype: "text/markdown" });
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }));
        // Every body entry has a stamped deep_hash — fully derived exactly once.
        const stamped = await (db.test_count_stamped_deep_hash as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId });
        return stamped?.n ?? 0;
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY; else process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = prev;
        await db.close();
    }
};

test("every pending entry is derived once — identical at sequential, bounded, and host-sized concurrency (#416)", async () => {
    const seq = await runPump("1");
    const par = await runPump("4");
    const host = await runPump("-1");
    assert.equal(seq, 11, "concurrency 1: all 11 body entries stamped");
    assert.equal(par, 11, "concurrency 4: identical — bounded concurrency neither skips nor double-derives");
    assert.equal(host, 11, "concurrency -1: host-sized scheduling preserves the same derivation result");
});

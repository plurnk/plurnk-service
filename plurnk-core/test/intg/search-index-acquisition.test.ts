// {§derivation-dedup-parallel} — the maintenance pass judges entry channels from stored identity
// and acquires a body only for a derivation that runs: an unchanged workspace acquires none of its
// channel bodies, at any producer concurrency.
import test from "node:test";
import assert from "node:assert/strict";
import SearchIndex from "../../src/schemes/_search-index.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, seedStaticChannel, seedEntryWithChannel, DEFAULT_MIMETYPES } from "./_helpers.ts";

const seedHashedEntry = async (db: Db, workspaceId: number, pathname: string, content: string): Promise<number> => {
    const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
        workspace_id: workspaceId, scheme: "worker", authority: "", pathname, default_channel: "body", output: 0,
    });
    if (entry === undefined) throw new Error("seedHashedEntry: insert returned no row");
    await seedStaticChannel(db, entry.id, { name: "body", content, mimetype: "text/markdown" });
    return entry.id;
};

for (const concurrency of ["1", "4"]) {
    test(`{§derivation-dedup-parallel} an unchanged workspace acquires no channel body; a change acquires exactly its own (concurrency ${concurrency})`, async (t) => {
        const previous = process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
        process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = concurrency;
        t.after(() => {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
            else process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY = previous;
        });
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, `acquire-${concurrency}`);
        const workerId = await insertWorker(db, workspaceId);
        const bodies = Array.from({ length: 20 }, (_, i) => `# Doc ${i}\n\n${"alpha beta gamma ".repeat(50 + i)}\n`);
        for (const [i, body] of bodies.entries()) await seedHashedEntry(db, workspaceId, `/doc-${i}.md`, body);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES, writer: "_plurnk" });

        const cold = await SearchIndex.maintain(ctx);
        assert.equal(cold.derived, 20, "every seeded channel derives once");
        assert.equal(cold.acquiredBytes, bodies.reduce((total, body) => total + body.length, 0), "a cold pass acquires every body exactly once");

        assert.deepEqual(await SearchIndex.maintain(ctx), { derived: 0, acquiredBytes: 0 }, "an unchanged pass decides from stored identity and acquires nothing");

        const extra = `# New\n\n${"omega psi ".repeat(40)}\n`;
        await seedHashedEntry(db, workspaceId, "/doc-new.md", extra);
        assert.deepEqual(await SearchIndex.maintain(ctx), { derived: 1, acquiredBytes: extra.length }, "one new entry acquires exactly its own body");

        // A channel without a stored identity is the one body the pass must read to judge it, every pass.
        const stream = "line one\nline two\n";
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/stream.log", channel: "body", content: stream, mimetype: "text/plain", state: "active" });
        assert.deepEqual(await SearchIndex.maintain(ctx), { derived: 1, acquiredBytes: stream.length }, "an identity-less channel is read once to judge and once to derive; the same body serves both");
        assert.deepEqual(await SearchIndex.maintain(ctx), { derived: 0, acquiredBytes: stream.length }, "and read again on the next pass, because nothing stored can judge it");
    });
}

test("{§derivation-dedup-parallel} a representation that moves on between judgement and derivation is left for the next pass", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "acquire-moved-on");
    const workerId = await insertWorker(db, workspaceId);
    const entryId = await seedHashedEntry(db, workspaceId, "/moving.md", "# First\n\nfirst body\n");
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES, writer: "_plurnk" });
    // Replace the body under a new identity after the candidate was judged but before its derivation ran.
    const body = await db.search_index_entry_body.get<{ content: string }>({ entry_id: entryId, channel: "body", content_hash: "not-the-stored-identity" });
    assert.equal(body, undefined, "a body is served only under the identity it was judged by");
    const report = await SearchIndex.maintain(ctx);
    assert.equal(report.derived, 1);
    const attached = await db.test_channel_hashes_for_entry.all<{ name: string; deep_hash: string | null }>({ entry_id: entryId });
    assert.ok(attached.every(({ deep_hash }) => deep_hash !== null), "the derivation attached under the stored identity");
});

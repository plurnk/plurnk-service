import assert from "node:assert/strict";
import test from "node:test";
import type { EntryData } from "@plurnk/plurnk-schemes";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { makeSchemeCtx } from "./_scheme.ts";

const coordinate = { authority: "", pathname: "/shared.md" };
const version = (name: string): EntryData => ({
    attributes: { version: name },
    channels: {
        body: { content: name, mimetype: "text/plain" },
        evidence: { content: name, mimetype: "text/plain" },
    },
});

test("{§crud} republishing preserves unchanged derivations and invalidates only changed representations", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-identity-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
    const publication = await EntryCrud.writeEntry(coordinate, version("before"), ctx, "session");
    assert.ok(publication.entryId);
    const hashes = () => db.test_channel_hashes_for_entry.all<{ name: string; deep_hash: string | null; content_hash: string }>({ entry_id: publication.entryId! });
    await SearchIndex.maintain(ctx);
    const before = await hashes();
    assert.ok(before.every(({ deep_hash }) => deep_hash !== null), "initial channels have completed derivations");

    await Promise.all(Array.from({ length: 8 }, () => EntryCrud.writeEntry(coordinate, version("before"), ctx, "session")));
    assert.deepEqual(await hashes(), before, "concurrent unchanged publication cannot invalidate another session's settled FIND");

    const changed = version("before");
    changed.channels.evidence.content = "after";
    await EntryCrud.writeEntry(coordinate, changed, ctx, "session");
    const after = await hashes();
    assert.deepEqual(after[0], before[0], "the unchanged body retains its artifact");
    assert.equal(after[1].deep_hash, null, "changed content cannot retain stale search evidence");
    assert.notEqual(after[1].content_hash, before[1].content_hash);

    await SearchIndex.maintain(ctx);
    changed.channels.evidence.mimetype = "text/markdown";
    await EntryCrud.writeEntry(coordinate, changed, ctx, "session");
    assert.equal((await hashes())[1].deep_hash, null, "a changed mimetype also invalidates the representation");
    delete changed.channels.evidence;
    await EntryCrud.writeEntry(coordinate, changed, ctx, "session");
    assert.deepEqual(await hashes(), [before[0]], "omitted channels are still removed by whole-entry publication");
});

for (const existing of [false, true]) {
    test(`{§crud} concurrent whole-entry publication preserves one complete version; existing=${existing}`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `publication-${crypto.randomUUID()}`);
        const sessions = await Promise.all(Array.from({ length: 8 }, () => insertSession(db, workspaceId)));
        const contexts = sessions.map((sessionId) => makeSchemeCtx({ db, workspaceId, sessionId }));
        if (existing) await EntryCrud.writeEntry(coordinate, version("before"), contexts[0], "session");

        const outcomes = await Promise.allSettled(contexts.map((ctx, index) =>
            EntryCrud.writeEntry(coordinate, version(`version-${index}`), ctx, "session")));
        for (const result of outcomes) assert.equal(result.status, "fulfilled", String(result.status === "rejected" ? result.reason : result.value));
        const publications = outcomes.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        assert.equal(new Set(publications.map(({ entryId }) => entryId)).size, 1, "the resource retains one identity");
        assert.equal(publications.filter(({ created }) => created).length, existing ? 0 : 1, "creation is claimed once");
        const read = await EntryCrud.readEntry(coordinate, contexts[0], "session");
        assert.equal(read.status, 200);
        const name = read.entry?.attributes?.version;
        assert.match(String(name), /^version-[0-7]$/);
        assert.deepEqual(Object.keys(read.entry!.channels).toSorted(), ["body", "evidence"]);
        assert.equal(read.entry!.channels.body.content, name);
        assert.equal(read.entry!.channels.evidence.content, name, "metadata and all channels belong to the same publication");
    });
}

test("{§crud} a rejected channel rolls back the whole replacement, including attributes", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `publication-rollback-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
    await EntryCrud.writeEntry(coordinate, version("before"), ctx, "session");
    const before = await EntryCrud.readEntry(coordinate, ctx, "session");
    const replacement = version("after");
    replacement.channels.evidence.state = "invalid" as never;
    await assert.rejects(
        EntryCrud.writeEntry(coordinate, replacement, ctx, "session"),
        /CHECK constraint failed: state IN/,
    );
    assert.deepEqual(await EntryCrud.readEntry(coordinate, ctx, "session"), before,
        "a failed publication does not leave partial content or metadata");
});

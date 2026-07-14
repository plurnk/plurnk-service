// [§find-count-not-contents] #418 — a FIND whose match set exceeds the render budget returns a
// COUNT + narrow-your-query steer instead of enumerating every match (a repo-scale FIND(**) over
// a huge workspace grinds clean, not crash-and-recover). The meta line still self-describes the
// full count.
import test from "node:test";
import assert from "node:assert/strict";
import EntryFind from "../../src/schemes/_entry-find.ts";
import Known from "../../src/schemes/Known.ts";
import type { FindStatement } from "@plurnk/plurnk-grammar";
import { openMigrated, insertSession, insertRun, seedEntryWithChannel, makeSchemeCtx } from "./_helpers.ts";

const findAll = (): FindStatement => ({
    op: "FIND", suffix: "", signal: null,
    target: { kind: "url", raw: "known:///**", scheme: "known", username: null, password: null, hostname: null, port: null, pathname: "/**", params: {}, fragment: null },
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("[§find-count-not-contents] over the budget, FIND returns a count + narrow steer, not the enumerated rows (#418)", async () => {
    const prev = process.env.PLURNK_SERVICE_FIND_MAX_MATCHES;
    process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = "3";
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `findcap-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        for (let i = 0; i < 6; i++) await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: `/e${i}`, channel: "body", content: `entry ${i}`, mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        const r = await EntryFind.findSessionEntries(findAll(), ctx, Known.manifest);
        assert.equal(r.status, 200);
        assert.equal(r.overflow, 6, "the full match count is reported");
        assert.equal(r.mimetype, "text/markdown", "the content is a steer, not the JSON catalog");
        assert.match(String(r.content), /6 entries match.*narrow/i, "the model is told how many and how to narrow");
        assert.doesNotMatch(String(r.content), /\{"path"/, "no catalog rows were materialized into the body");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FIND_MAX_MATCHES; else process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = prev;
        await db.close();
    }
});

test("[§find-count-not-contents] under the budget, FIND enumerates the catalog rows as before (#418)", async () => {
    const prev = process.env.PLURNK_SERVICE_FIND_MAX_MATCHES;
    process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = "500";
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `findsmall-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/one", channel: "body", content: "just one", mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        const r = await EntryFind.findSessionEntries(findAll(), ctx, Known.manifest);
        assert.equal(r.overflow, undefined, "no overflow under budget");
        assert.equal(r.mimetype, "application/json", "the catalog rows are enumerated");
        assert.ok(Array.isArray(JSON.parse(String(r.content))), "content is the JSON catalog array");
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FIND_MAX_MATCHES; else process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = prev;
        await db.close();
    }
});

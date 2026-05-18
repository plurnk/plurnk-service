// Tests for SEND[410] → scheme.delete pattern (SPEC §3.5, §6.7).

import test from "node:test";
import assert from "node:assert/strict";
import type { SendStatement, EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const url = (scheme: string, pathname: string, fragment: string | null = null): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}${fragment !== null ? `#${fragment}` : ""}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment,
});

const sendStmt = (status: number, recipient: UrlPath | null = null, body: string | null = null): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path: recipient, lineMarker: null,
    body: body === null ? null : { raw: body, json: null },
    position: { line: 1, column: 1 },
});

const editStmt = (path: UrlPath, body: string | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { sessionId: number; runId: number; loopId: number; turnId: number }, statement: SendStatement) =>
    engine.dispatch({ statement, ...env, actionIndex: 0, origin: "client" });

test("[§3.5-410-deletes-resource] SEND[410](known://x) deletes the entry", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({ db, sessionId, runId, statement: editStmt(url("known", "doomed"), "tomorrow") });
        const beforeDelete = db.prepare("SELECT id FROM entries WHERE pathname = 'doomed'").get();
        assert.ok(beforeDelete !== undefined);

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, url("known", "doomed")));
        assert.equal(r.status, 200);

        const afterDelete = db.prepare("SELECT id FROM entries WHERE pathname = 'doomed'").get();
        assert.equal(afterDelete, undefined, "entry removed");
    } finally { db.close(); }
});

test("SEND[410] on missing entry returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, url("known", "nope")));
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("[§3.5-410-fragment-400] SEND[410] with #fragment returns 400 (channel-level delete not supported)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({ db, sessionId, runId, statement: editStmt(url("known", "x"), "body") });
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, url("known", "x", "preview")));
        assert.equal(r.status, 400);

        // Entry not touched
        const stillThere = db.prepare("SELECT id FROM entries WHERE pathname = 'x'").get();
        assert.ok(stillThere !== undefined);
    } finally { db.close(); }
});

test("[§3.5-entry-schemes-501-on-non-410] SEND[200] on entry scheme returns 501 (entry schemes don't interpret 200 directly)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({ db, sessionId, runId, statement: editStmt(url("known", "x"), "body") });
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(200, url("known", "x")));
        assert.equal(r.status, 501);
    } finally { db.close(); }
});

test("SEND[410](unknown://x) deletes unknown entry", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const Unknown = (await import("../../src/schemes/Unknown.ts")).default;
        await new Unknown().edit({ db, sessionId, runId, statement: editStmt(url("unknown", "topic"), "open question") });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, url("unknown", "topic")));
        assert.equal(r.status, 200);
        assert.equal(db.prepare("SELECT id FROM entries WHERE pathname = 'topic'").get(), undefined);
    } finally { db.close(); }
});

test("SEND[410](skill://x) deletes skill entry", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const Skill = (await import("../../src/schemes/Skill.ts")).default;
        await new Skill().edit({ db, sessionId, runId, statement: editStmt(url("skill", "grep"), "search text") });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, url("skill", "grep")));
        assert.equal(r.status, 200);
        assert.equal(db.prepare("SELECT id FROM entries WHERE pathname = 'grep'").get(), undefined);
    } finally { db.close(); }
});

test("SEND[410] cascades — channels, tags, visibility all removed", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, sessionId, runId, statement: { ...editStmt(url("known", "doomed"), "body"), signal: ["a", "b"] } });
        const entryId = (db.prepare("SELECT id FROM entries WHERE pathname = 'doomed'").get() as { id: number }).id;
        // Verify pre-state has channels, tags, visibility
        assert.ok((db.prepare("SELECT COUNT(*) as n FROM entry_channels WHERE entry_id = ?").get(entryId) as { n: number }).n > 0);
        assert.ok((db.prepare("SELECT COUNT(*) as n FROM entry_tags WHERE entry_id = ?").get(entryId) as { n: number }).n > 0);
        assert.ok((db.prepare("SELECT COUNT(*) as n FROM visibility WHERE entry_id = ?").get(entryId) as { n: number }).n > 0);

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, sendStmt(410, url("known", "doomed")));
        assert.equal(r.status, 200);

        // All related rows gone via CASCADE
        assert.equal((db.prepare("SELECT COUNT(*) as n FROM entry_channels WHERE entry_id = ?").get(entryId) as { n: number }).n, 0);
        assert.equal((db.prepare("SELECT COUNT(*) as n FROM entry_tags WHERE entry_id = ?").get(entryId) as { n: number }).n, 0);
        assert.equal((db.prepare("SELECT COUNT(*) as n FROM visibility WHERE entry_id = ?").get(entryId) as { n: number }).n, 0);
    } finally { db.close(); }
});

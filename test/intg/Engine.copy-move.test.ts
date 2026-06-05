// Tests for SPEC §6.4 (Engine.copy orchestration) and §6.5 (Engine.move).

import test from "node:test";
import assert from "node:assert/strict";
import type { CopyStatement, MoveStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, localPath, editStmt, copyStmt, moveStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = async (engine: Engine, env: { sessionId: number; runId: number; loopId: number; turnId: number }, statement: CopyStatement | MoveStatement) => {
    return await engine.dispatch({
        statement, ...env, sequence: 1, origin: "client",
    });
};

test("Engine.copy same-scheme (known → known)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "france/capital"), "Paris", ["france"]), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(urlPath("known", "france/capital"), urlPath("known", "europe/france")));
        assert.equal(r.status, 201);

        const dst = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ scheme: string; pathname: string }>({ pathname: "europe/france", scheme: "known" });
        assert.equal(dst?.scheme, "known");
        const channel = await (db.test_get_channel_by_pathname as PrepMethod).get<{ content: string }>({ pathname: "europe/france", name: "body" });
        assert.equal(channel?.content, "Paris");
        const tags = await (db.test_tags_by_pathname as PrepMethod).all<{ tag: string }>({ pathname: "europe/france" });
        assert.deepEqual(tags.map((t) => t.tag), ["france"]);
    } finally { await db.close(); }
});

test("[§6.4-cross-scheme-copy] Engine.copy cross-scheme (unknown → known)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const Unknown = (await import("../../src/schemes/Unknown.ts")).default;
        await new Unknown().edit(editStmt(urlPath("unknown", "topic"), "open question"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(urlPath("unknown", "topic"), urlPath("known", "topic")));
        assert.equal(r.status, 201);

        const dst = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ scheme: string }>({ pathname: "topic", scheme: "known" });
        assert.equal(dst?.scheme, "known");
        const channel = await (db.test_get_channel_by_pathname_scheme as PrepMethod).get<{ content: string }>({ pathname: "topic", scheme: "known", name: "body" });
        assert.equal(channel?.content, "open question");
    } finally { await db.close(); }
});

test("[§6.4-missing-source-404] Engine.copy missing source returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(urlPath("known", "nope"), urlPath("known", "elsewhere")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("[§6.4-conflict-409] Engine.copy conflicting destination returns 409", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const k = new Known();
        await k.edit(editStmt(urlPath("known", "src"), "source body"), makeSchemeCtx({ db, sessionId, runId }));
        await k.edit(editStmt(urlPath("known", "dst"), "dest body"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(urlPath("known", "src"), urlPath("known", "dst")));
        assert.equal(r.status, 409);
        const dstBody = (await (db.test_get_channel_by_pathname as PrepMethod).get<{ content: string }>({ pathname: "dst", name: "body" }))?.content;
        assert.equal(dstBody, "dest body");
    } finally { await db.close(); }
});

test("[§6.4-noop-304] Engine.copy to a destination already holding identical content returns 304", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const k = new Known();
        await k.edit(editStmt(urlPath("known", "src"), "same body"), makeSchemeCtx({ db, sessionId, runId }));
        // Three dispatches in one turn → distinct sequences (log_entries is unique on turn_id+sequence).
        const copy = (sequence: number) => engine.dispatch({ statement: copyStmt(urlPath("known", "src"), urlPath("known", "dst")), sessionId, runId, loopId, turnId, sequence, origin: "client" });

        assert.equal((await copy(1)).status, 201, "first copy creates the destination");
        assert.equal((await copy(2)).status, 304, "identical re-copy is a no-op, not a 409");

        // Divergent destination is still a real collision; it stays untouched.
        await k.edit(editStmt(urlPath("known", "src"), "changed body"), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal((await copy(3)).status, 409, "divergent content is a collision");
        const dstBody = (await (db.test_get_channel_by_pathname as PrepMethod).get<{ content: string }>({ pathname: "dst", name: "body" }))?.content;
        assert.equal(dstBody, "same body", "collision leaves the destination untouched");
    } finally { await db.close(); }
});

test("[§6.4-signal-replaces-source-tags] Engine.copy tag policy — signal present REPLACES source tags on dest", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "src"), "x", ["original", "tags"]), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(urlPath("known", "src"), urlPath("known", "dst"), ["new", "tags"]));
        assert.equal(r.status, 201);

        const tags = await (db.test_tags_by_pathname as PrepMethod).all<{ tag: string }>({ pathname: "dst" });
        assert.deepEqual(tags.map((t) => t.tag), ["new", "tags"]);
    } finally { await db.close(); }
});

test("[§6.4-no-signal-carries-source-tags] Engine.copy tag policy — no signal CARRIES source tags", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "src"), "x", ["a", "b"]), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(urlPath("known", "src"), urlPath("known", "dst"), null));
        assert.equal(r.status, 201);

        const tags = await (db.test_tags_by_pathname as PrepMethod).all<{ tag: string }>({ pathname: "dst" });
        assert.deepEqual(tags.map((t) => t.tag), ["a", "b"]);
    } finally { await db.close(); }
});

test("[§6.5-relocation-deletes-source] Engine.move relocates: source deleted, dest created", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "src"), "movable"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(urlPath("known", "src"), urlPath("known", "dst")));
        assert.equal(r.status, 201);

        const src = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "src" });
        assert.equal(src, undefined, "source removed");

        const dstBody = (await (db.test_get_channel_by_pathname as PrepMethod).get<{ content: string }>({ pathname: "dst", name: "body" }))?.content;
        assert.equal(dstBody, "movable");
    } finally { await db.close(); }
});

test("[§6.5-null-body-deletes] Engine.move null body = delete source", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "trash-me"), "stale"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(urlPath("known", "trash-me"), null));
        assert.equal(r.status, 200);

        const remaining = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "trash-me" });
        assert.equal(remaining, undefined);
    } finally { await db.close(); }
});

test("[§6.5-dev-null-deletes] Engine.move to /dev/null = delete source", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "obsolete"), "stale"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(urlPath("known", "obsolete"), localPath("/dev/null")));
        assert.equal(r.status, 200);

        const remaining = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "obsolete" });
        assert.equal(remaining, undefined);
    } finally { await db.close(); }
});

test("[§6.5-missing-source-404] Engine.move missing source returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(urlPath("known", "nope"), urlPath("known", "elsewhere")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("[§6.5-cross-scheme-move] Engine.move cross-scheme (unknown → known) deletes source, creates dest", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const Unknown = (await import("../../src/schemes/Unknown.ts")).default;
        await new Unknown().edit(editStmt(urlPath("unknown", "draft"), "answer"), makeSchemeCtx({ db, sessionId, runId }));

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(urlPath("unknown", "draft"), urlPath("known", "answer")));
        assert.equal(r.status, 201);

        const srcRemaining = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ id: number }>({ pathname: "draft", scheme: "unknown" });
        assert.equal(srcRemaining, undefined, "unknown source deleted");

        const dst = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ scheme: string }>({ pathname: "answer", scheme: "known" });
        assert.equal(dst?.scheme, "known");
    } finally { await db.close(); }
});

test("Engine.copy with <L> source range slices content", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "long"), "alpha\nbeta\ngamma\ndelta"), makeSchemeCtx({ db, sessionId, runId }));
        const stmt: CopyStatement = { ...copyStmt(urlPath("known", "long"), urlPath("known", "sliced")), lineMarker: { first: 2, last: 3 } };
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, stmt);
        assert.equal(r.status, 201);
        const entryRow = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "sliced" });
        const dstChannel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entryRow?.id, name: "body" });
        assert.equal(dstChannel?.content, "beta\ngamma\n");
    } finally { await db.close(); }
});

test("Engine.copy with <L> out of range returns 416", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "src"), "only one line"), makeSchemeCtx({ db, sessionId, runId }));
        const stmt: CopyStatement = { ...copyStmt(urlPath("known", "src"), urlPath("known", "dst")), lineMarker: { first: 99, last: null } };
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, stmt);
        assert.equal(r.status, 416);
    } finally { await db.close(); }
});

test("Engine.move with <L> source range slices then deletes source", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit(editStmt(urlPath("known", "orig"), "first\nsecond\nthird"), makeSchemeCtx({ db, sessionId, runId }));
        const stmt: MoveStatement = { ...moveStmt(urlPath("known", "orig"), urlPath("known", "moved")), lineMarker: { first: 1, last: 2 } };
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, stmt);
        assert.equal(r.status, 201);
        const srcRemaining = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "orig" });
        assert.equal(srcRemaining, undefined);
        const entryRow = await (db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "moved" });
        const dstChannel = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entryRow?.id, name: "body" });
        assert.equal(dstChannel?.content, "first\nsecond\n");
    } finally { await db.close(); }
});

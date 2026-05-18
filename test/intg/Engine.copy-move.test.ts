// Tests for SPEC §6.4 (Engine.copy orchestration) and §6.5 (Engine.move).

import test from "node:test";
import assert from "node:assert/strict";
import type { CopyStatement, MoveStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const copyStmt = (src: UrlPath, dst: UrlPath, tags: string[] | null = null): CopyStatement => ({
    op: "COPY", suffix: "", signal: tags, path: src, lineMarker: null, body: dst,
    position: { line: 1, column: 1 },
});

const moveStmt = (src: UrlPath, dst: UrlPath | null, tags: string[] | null = null): MoveStatement => ({
    op: "MOVE", suffix: "", signal: tags, path: src, lineMarker: null, body: dst,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = async (engine: Engine, env: { sessionId: number; runId: number; loopId: number; turnId: number }, statement: CopyStatement | MoveStatement) => {
    return await engine.dispatch({
        statement, ...env, actionIndex: 0, origin: "client",
    });
};

test("Engine.copy same-scheme (known → known)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        // Seed source entry
        await new Known().edit({
            db, sessionId, runId,
            statement: { op: "EDIT", suffix: "", signal: ["france"], path: url("known", "france/capital"), lineMarker: null, body: "Paris", position: { line: 1, column: 1 } },
        });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(url("known", "france/capital"), url("known", "europe/france")));
        assert.equal(r.status, 201);

        const dst = db.prepare("SELECT scheme, pathname FROM entries WHERE pathname = 'europe/france'").get() as { scheme: string; pathname: string };
        assert.equal(dst.scheme, "known");
        const body = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'europe/france') AND name = 'body'").get() as { content: string }).content;
        assert.equal(body, "Paris");
        const tags = db.prepare("SELECT tag FROM entry_tags WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'europe/france')").all() as { tag: string }[];
        assert.deepEqual(tags.map((t) => t.tag), ["france"]);
    } finally { db.close(); }
});

test("[§6.4-cross-scheme-copy] Engine.copy cross-scheme (unknown → known)", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new (await import("../../src/schemes/Unknown.ts")).default().edit({
            db, sessionId, runId,
            statement: { op: "EDIT", suffix: "", signal: null, path: url("unknown", "topic"), lineMarker: null, body: "open question", position: { line: 1, column: 1 } },
        });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(url("unknown", "topic"), url("known", "topic")));
        assert.equal(r.status, 201);

        const dst = db.prepare("SELECT scheme FROM entries WHERE pathname = 'topic' AND scheme = 'known'").get() as { scheme: string };
        assert.equal(dst.scheme, "known");
        const body = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'topic' AND scheme = 'known') AND name = 'body'").get() as { content: string }).content;
        assert.equal(body, "open question");
    } finally { db.close(); }
});

test("[§6.4-missing-source-404] Engine.copy missing source returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(url("known", "nope"), url("known", "elsewhere")));
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("[§6.4-conflict-409] Engine.copy conflicting destination returns 409", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const k = new Known();
        await k.edit({ db, sessionId, runId, statement: { op: "EDIT", suffix: "", signal: null, path: url("known", "src"), lineMarker: null, body: "source body", position: { line: 1, column: 1 } } });
        await k.edit({ db, sessionId, runId, statement: { op: "EDIT", suffix: "", signal: null, path: url("known", "dst"), lineMarker: null, body: "dest body", position: { line: 1, column: 1 } } });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(url("known", "src"), url("known", "dst")));
        assert.equal(r.status, 409);
        // Dest body unchanged
        const dstBody = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'dst') AND name = 'body'").get() as { content: string }).content;
        assert.equal(dstBody, "dest body");
    } finally { db.close(); }
});

test("[§6.4-signal-replaces-source-tags] Engine.copy tag policy — signal present REPLACES source tags on dest", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({
            db, sessionId, runId,
            statement: { op: "EDIT", suffix: "", signal: ["original", "tags"], path: url("known", "src"), lineMarker: null, body: "x", position: { line: 1, column: 1 } },
        });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(url("known", "src"), url("known", "dst"), ["new", "tags"]));
        assert.equal(r.status, 201);

        const tags = db.prepare("SELECT tag FROM entry_tags WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'dst') ORDER BY tag").all() as { tag: string }[];
        assert.deepEqual(tags.map((t) => t.tag), ["new", "tags"]);
    } finally { db.close(); }
});

test("[§6.4-no-signal-carries-source-tags] Engine.copy tag policy — no signal CARRIES source tags", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({
            db, sessionId, runId,
            statement: { op: "EDIT", suffix: "", signal: ["a", "b"], path: url("known", "src"), lineMarker: null, body: "x", position: { line: 1, column: 1 } },
        });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, copyStmt(url("known", "src"), url("known", "dst"), null));
        assert.equal(r.status, 201);

        const tags = db.prepare("SELECT tag FROM entry_tags WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'dst') ORDER BY tag").all() as { tag: string }[];
        assert.deepEqual(tags.map((t) => t.tag), ["a", "b"]);
    } finally { db.close(); }
});

test("[§6.5-relocation-deletes-source] Engine.move relocates: source deleted, dest created", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({
            db, sessionId, runId,
            statement: { op: "EDIT", suffix: "", signal: null, path: url("known", "src"), lineMarker: null, body: "movable", position: { line: 1, column: 1 } },
        });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(url("known", "src"), url("known", "dst")));
        assert.equal(r.status, 201);

        const src = db.prepare("SELECT id FROM entries WHERE pathname = 'src'").get();
        assert.equal(src, undefined, "source removed");

        const dstBody = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'dst') AND name = 'body'").get() as { content: string }).content;
        assert.equal(dstBody, "movable");
    } finally { db.close(); }
});

test("[§6.5-null-body-deletes] Engine.move null body = delete source", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new Known().edit({
            db, sessionId, runId,
            statement: { op: "EDIT", suffix: "", signal: null, path: url("known", "trash-me"), lineMarker: null, body: "stale", position: { line: 1, column: 1 } },
        });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(url("known", "trash-me"), null));
        assert.equal(r.status, 200);

        const remaining = db.prepare("SELECT id FROM entries WHERE pathname = 'trash-me'").get();
        assert.equal(remaining, undefined);
    } finally { db.close(); }
});

test("[§6.5-missing-source-404] Engine.move missing source returns 404", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(url("known", "nope"), url("known", "elsewhere")));
        assert.equal(r.status, 404);
    } finally { db.close(); }
});

test("[§6.5-cross-scheme-move] Engine.move cross-scheme (unknown → known) deletes source, creates dest", async () => {
    const { db, sessionId, runId, loopId, turnId, engine } = await setup();
    try {
        await new (await import("../../src/schemes/Unknown.ts")).default().edit({
            db, sessionId, runId,
            statement: { op: "EDIT", suffix: "", signal: null, path: url("unknown", "draft"), lineMarker: null, body: "answer", position: { line: 1, column: 1 } },
        });

        const r = await dispatch(engine, { sessionId, runId, loopId, turnId }, moveStmt(url("unknown", "draft"), url("known", "answer")));
        assert.equal(r.status, 201);

        const srcRemaining = db.prepare("SELECT id FROM entries WHERE pathname = 'draft' AND scheme = 'unknown'").get();
        assert.equal(srcRemaining, undefined, "unknown source deleted");

        const dst = db.prepare("SELECT scheme FROM entries WHERE pathname = 'answer' AND scheme = 'known'").get() as { scheme: string };
        assert.equal(dst.scheme, "known");
    } finally { db.close(); }
});

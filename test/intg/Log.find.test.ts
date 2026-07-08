// §log-uniform-query — FIND over the run's log rows, on the SAME source-agnostic primitive every
// entry scheme runs (§find-source-agnostic). The jumbo forensic: the model ran
// `FIND(log:///**):#engine#i` six times — a canon-documented gesture (plurnk.md:148) — and got a
// bare 501 from the one scheme that sat outside the universal paradigm. These pin the uniform
// contract through the REAL dispatch: FIND(log) with content dialects, the hierarchy as scope, and
// the FIND→READ fan-out composition.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, findStmt } from "./_dsl.ts";

const editStmt = (pathname: string, content: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "url", raw: `known://${pathname}`, scheme: "known", username: null, password: null, hostname: null, port: null, pathname, params: {}, fragment: null } as UrlPath,
    lineMarker: null, body: content, position: { line: 1, column: 1 },
});
const readStmt = (target: ParsedPath | null, body: MatcherBody | null = null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `logfind-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "test prompt");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // Three rows: an EDIT ack (JSON dust), a READ result carrying prose, another EDIT.
    await engine.dispatch({ statement: editStmt("/notes.md", "the engine hums along"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
    await engine.dispatch({ statement: readStmt(urlPath("known", "/notes.md")), sessionId, runId, loopId, turnId, sequence: 2, origin: "model" });
    await engine.dispatch({ statement: editStmt("/other.md", "nothing relevant"), sessionId, runId, loopId, turnId, sequence: 3, origin: "model" });
    return { db, engine, sessionId, runId, loopId, turnId };
};

test("[§log-uniform-query] FIND(log:///**):#regex# matches log rows by CONTENT — the jumbo gesture works", async () => {
    const { db, runId } = await setup();
    try {
        const r = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/engine hums/", pattern: "engine hums", flags: "" } as MatcherBody),
            makeSchemeCtx({ db, runId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(r.status, 200, "no more 501 — log speaks the universal FIND");
        const paths = r.results.map((x) => x.path);
        // BOTH rows whose projection carries the phrase match: the EDIT's rx echoes the written
        // span, the READ's rx carries the retrieved content — FIND matches exactly what READ shows.
        assert.ok(paths.includes("log:///1/1/2/READ"), "the READ-result row matches by its content");
        assert.ok(paths.includes("log:///1/1/1/EDIT"), "the EDIT row matches too — its rx echoes the written span (the projection is the contract)");
        assert.ok(!paths.some((x) => x.includes("/1/1/3/")), "the irrelevant row is excluded");
        assert.ok(r.results.every((x) => x.matchSpan !== undefined), "(row, span) items — READ fan-out honors them (#286)");
    } finally { await db.close(); }
});

test("[§log-uniform-query] a body-less FIND(log:///1/1) lists the turn's rows — the hierarchy is the scope", async () => {
    const { db, runId } = await setup();
    try {
        const r = await new Log().find(findStmt(urlPath("log", "/1/1")), makeSchemeCtx({ db, runId, mimetypes: DEFAULT_MIMETYPES }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 3, "the turn's three rows, catalog-shaped");
        assert.ok(r.results.every((x) => /^log:\/\/\/1\/1\/\d+\//.test(x.path)), "each item keyed log:///loop/turn/seq/OP");
        assert.ok(r.results.every((x) => Object.values(x.channels)[0]!.tokens >= 0), "each carries {mimetype, tokens, lines} — the model budgets its READs");
    } finally { await db.close(); }
});

test("[§log-uniform-query] READ(log:///**):#pattern# fans out — FIND locates, per-row READs deliver, uniform with entries", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        const result = await engine.dispatch({
            statement: readStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/engine hums/", pattern: "engine hums", flags: "" } as MatcherBody),
            sessionId, runId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(result.status, 200, "the matcher READ fans out through Log.find");
        const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; rx: string; sequence: number }>({ loop_id: loopId });
        const delivered = rows.filter((r) => r.op === "READ" && r.sequence >= 4 && r.rx.includes("engine hums"));
        assert.ok(delivered.length >= 1, "the matching row's content delivered as a fanned READ row");
    } finally { await db.close(); }
});

test("[§log-uniform-query] zero content matches → 204; ~semantic → 501 until the pump embeds log rows (S5)", async () => {
    const { db, runId } = await setup();
    try {
        const none = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/absent-phrase-xyz/", pattern: "absent-phrase-xyz", flags: "" } as MatcherBody),
            makeSchemeCtx({ db, runId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(none.status, 204, "a sweep that found nothing steers nothing");
        const sem = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "semantic", raw: "~engine" } as MatcherBody),
            makeSchemeCtx({ db, runId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(sem.status, 501, "~query on log is an HONEST 501 until log rows are embedded — never a silent wrong answer");
    } finally { await db.close(); }
});

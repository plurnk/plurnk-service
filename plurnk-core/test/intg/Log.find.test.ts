// {§log-uniform-query} — FIND over the worker's log rows, on the SAME source-agnostic primitive every
// entry scheme runs ({§find-source-agnostic}). The jumbo forensic: the model ran
// `FIND(log:///**):/engine/i` six times — a canon-documented gesture — and got a
// bare 501 from the one scheme that sat outside the universal paradigm. These pin the uniform
// contract through the REAL dispatch: FIND(log) with content dialects, the hierarchy as scope, and
// the FIND→READ fan-out composition.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, findStmt } from "./_dsl.ts";

const editStmt = (pathname: string, content: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "url", raw: `worker:///${pathname}`, scheme: "worker", username: null, password: null, hostname: null, port: null, pathname, params: {}, fragment: null } as UrlPath,
    lineMarker: null, body: content, position: { line: 1, column: 1 },
});
const readStmt = (target: ParsedPath | null, body: MatcherBody | null = null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `logfind-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "test prompt");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // Three rows: an EDIT ack (JSON dust), a READ result carrying prose, another EDIT.
    await engine.dispatch({ statement: editStmt("/notes.md", "the engine hums along"), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model" });
    await engine.dispatch({ statement: readStmt(urlPath("worker", "/notes.md")), workspaceId, workerId, loopId, turnId, sequence: 2, origin: "model" });
    await engine.dispatch({ statement: editStmt("/other.md", "nothing relevant"), workspaceId, workerId, loopId, turnId, sequence: 3, origin: "model" });
    return { db, engine, workspaceId, workerId, loopId, turnId };
};

test("FIND(log:///**):/regex/ matches log rows by CONTENT — the jumbo gesture works", async () => {
    const { db, workerId } = await setup();
    try {
        const r = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/engine hums/", pattern: "engine hums", flags: "" } as MatcherBody),
            makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(r.status, 200, "no more 501 — log speaks the universal FIND");
        const paths = r.results.map((x) => x.path);
        // BOTH rows whose projection carries the phrase match: the EDIT's rx echoes the written
        // span, the READ's rx carries the retrieved content — FIND matches exactly what READ shows.
        assert.ok(paths.includes("log:///1/1/2/READ"), "the READ-result row matches by its content");
        assert.ok(paths.includes("log:///1/1/1/EDIT"), "the EDIT row matches too — its rx echoes the written span (the projection is the contract)");
        assert.ok(!paths.some((x) => x.includes("/1/1/3/")), "the irrelevant row is excluded");
        assert.ok(r.results.every((x) => x.matches !== undefined), "each selected row carries addressable match coordinates");
    } finally { await db.close(); }
});

test("a body-less FIND(log:///1/1) lists the turn's rows — the hierarchy is the scope", async () => {
    const { db, workerId } = await setup();
    try {
        const r = await new Log().find(findStmt(urlPath("log", "/1/1")), makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 3, "the turn's three rows, catalog-shaped");
        assert.deepEqual(JSON.parse(r.content!), r.results, "line-addressable content remains the exact JSON result array");
        assert.equal(r.content!.split("\n").length, r.results.length, "log FIND uses the same one-item-per-line rendering as entry FIND");
        assert.ok(r.results.every((x) => /^log:\/\/\/1\/1\/\d+\//.test(x.path)), "each item keyed log:///loop/turn/seq/OP");
        assert.ok(r.results.every((x) => x.channels !== undefined && Object.values(x.channels)[0]!.tokens >= 0), "each carries {mimetype, tokens, lines} — the model budgets its READs");
    } finally { await db.close(); }
});

test("a single-star log FIND maps one coordinate level without crossing separators", async () => {
    const { db, workerId } = await setup();
    try {
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES });

        const root = await log.find(findStmt(urlPath("log", "/*")), ctx);
        assert.equal(root.status, 200);
        assert.deepEqual(root.results.map((item) => item.path), ["log:///1/**"]);
        const loop = root.results[0];
        assert.ok(loop !== undefined && loop.items === 3 && (loop.tokens ?? 0) >= 0, "the loop scope summarizes its recursive rows");
        assert.deepEqual(root.matches, [], "the summary is navigation metadata, not a hidden row match");

        const segmented = await log.find(findStmt(urlPath("log", "/*/*/*")), ctx);
        assert.equal(segmented.results.length, 3, "one star per canonical coordinate segment reaches the rows");
        assert.ok(segmented.results.every((item) => /^log:\/\/\/1\/1\/\d+\//.test(item.path)));

        const turnRows = await log.find(findStmt(urlPath("log", "/1/1/*")), ctx);
        assert.equal(turnRows.results.length, 3, "a turn-level star lists its item resources rather than /OP decorations");

        const recursive = await log.find(findStmt(urlPath("log", "/**")), ctx);
        assert.equal(recursive.results.length, 3, "double-star remains the direct recursive row listing");
    } finally { await db.close(); }
});

test("FIND pagination misses carry the exact result extent", async () => {
    const { db, workerId } = await setup();
    try {
        const statement = {
            ...findStmt(urlPath("log", "/1/1")),
            lineMarker: { marks: [9] as [number] },
        };
        const r = await new Log().find(statement, makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }));
        assert.equal(r.status, 416);
        assert.deepEqual(r.problem?.range, {
            unit: "result",
            requested: { first: 9, last: null },
            available: { first: 1, last: 3, total: 3 },
        });
    } finally { await db.close(); }
});

test("log FIND reports an exact readable region for structural matches", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/data.json", '{\n  "first": 1,\n  "second": 2\n}'),
            workspaceId, workerId, loopId, turnId, sequence: 4, origin: "model",
        });
        await engine.dispatch({
            statement: readStmt(urlPath("worker", "/data.json")),
            workspaceId, workerId, loopId, turnId, sequence: 5, origin: "model",
        });
        const result = await new Log().find(
            findStmt(urlPath("log", "/1/1/5/READ"), { dialect: "jsonpath", raw: "$.second" } as MatcherBody),
            makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 200);
        const match = result.results[0]?.matches?.[0];
        assert.equal(match?.path, "$['second']");
        assert.equal(match?.region?.startLine, 3);
        assert.equal(match?.region?.endLine, 3);
        assert.ok((match?.region?.endColumn ?? 0) > (match?.region?.startColumn ?? 0));
    } finally { await db.close(); }
});

test("READ(log:///**):/pattern/ fans out — FIND locates, per-row READs deliver, uniform with entries", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const result = await engine.dispatch({
            statement: readStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/engine hums/", pattern: "engine hums", flags: "" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(result.status, 200, "the matcher READ fans out through Log.find");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; sequence: number }>({ loop_id: loopId });
        const delivered = rows.filter((r) => r.op === "READ" && r.sequence >= 4 && r.rx.includes("engine hums"));
        assert.ok(delivered.length >= 1, "the matching row's content delivered as a fanned READ row");
    } finally { await db.close(); }
});

test("READ(log://) returns a composed row's complete canonical body", async () => {
    const { db, workerId, loopId, turnId } = await setup();
    try {
        const full = Array.from({ length: 30 }, (_, i) => `plan line ${i + 1}`).join("\n");
        await db.engine_insert_log_entry.get({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: 4,
            origin: "model",
            source: null,
            op: "PLAN",
            suffix: "",
            signal: null,
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            params: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ body: full }),
            mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 200 }),
            mimetype_rx: "application/json",
            status_rx: 200,
            tokens: 0,
            state: "resolved",
            outcome: null,
            attrs: "{}",
        });

        const result = await new Log().read(
            readStmt(urlPath("log", "/1/1/4/PLAN")),
            makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 200);
        assert.equal(result.content, full, "log READ bypasses only the packet projection, not the canonical body");
    } finally { await db.close(); }
});

test("zero content matches → 204; an unwarmed relation query fails with structured index state", async () => {
    const { db, workerId } = await setup();
    try {
        const none = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/absent-phrase-xyz/", pattern: "absent-phrase-xyz", flags: "" } as MatcherBody),
            makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(none.status, 204, "a sweep that found nothing steers nothing");
        const sem = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "semantic", raw: "~engine" } as MatcherBody),
            makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(sem.status, 503, "an advertised matcher is unavailable only while its persistent index is incomplete");
        assert.deepEqual(sem.problem?.search, { state: "incomplete", indexed: 0, total: 3 });
    } finally { await db.close(); }
});

test("semantic and graph FIND over logs use the same persistent derivations as entries", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        await engine.dispatch({
            statement: editStmt("/source.ts", "export function helper() { return 1; }\nexport function caller() { return helper(); }"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 4,
            origin: "model",
        });
        await engine.dispatch({
            statement: readStmt(urlPath("worker", "/source.ts")),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 5,
            origin: "model",
        });
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }));

        const entryAttachment = await db.test_entry_deep_hash_by_path.get<{ deep_hash: string | null }>({
            workspace_id: workspaceId,
            scheme: "worker",
            pathname: "/notes.md",
        });
        const logAttachment = await db.test_log_deep_hash_by_turn_sequence.get<{ deep_hash: string | null }>({
            turn_id: turnId,
            sequence: 2,
        });
        assert.ok(entryAttachment?.deep_hash);
        assert.equal(
            logAttachment?.deep_hash,
            entryAttachment.deep_hash,
            "identical entry and log READ projections attach the same immutable derivation artifact",
        );

        const semanticStatement = findStmt(
            urlPath("log", "/**"),
            { dialect: "semantic", raw: "engine hums" } as MatcherBody,
        );
        const semantic = await new Log().find(
            semanticStatement,
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(semantic.status, 200);
        assert.ok(semantic.results.some(({ path }) => path.includes("/1/1/2/READ")),
            "semantic rank returns the log address whose READ projection carries the phrase");
        assert.ok(semantic.results.length >= 2, "the semantic specimen has multiple ranked log results");
        const secondSemantic = await new Log().find(
            { ...semanticStatement, lineMarker: { marks: [2] } },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.deepEqual(
            secondSemantic.results.map(({ path }) => path),
            semantic.results.slice(1, 2).map(({ path }) => path),
            "log semantic FIND uses the same positional result scope as every FIND",
        );

        const graph = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "graph", raw: "@<helper" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(graph.status, 200);
        assert.ok(graph.results.some(({ path }) => path.includes("/1/1/5/READ")),
            "graph relation returns the log address whose readable code projection references helper");
    } finally { await db.close(); }
});

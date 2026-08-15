// {§log-uniform-query} — FIND over the worker's log rows, on the SAME source-agnostic primitive every
// entry scheme runs ({§find-source-agnostic}). The jumbo forensic: the model ran
// `FIND(log:///**):/engine/i` six times — a canon-documented gesture — and got a
// bare 501 from the one scheme that sat outside the universal paradigm. These pin the uniform
// contract through the REAL dispatch: FIND(log) with content dialects, the hierarchy as scope, and
// exact FIND→READ navigation.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import type { CatalogResource, FindResult } from "../../src/schemes/_entry-find.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, readLog, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, findStmt } from "./_dsl.ts";
import { matchLocations } from "./_find.ts";

const editStmt = (pathname: string, content: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: { kind: "url", raw: `worker:///${pathname}`, scheme: "worker", username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: null } as UrlPath,
    lineMarker: null, body: content, position: { line: 1, column: 1 },
});
const readStmt = (target: ParsedPath | null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 },
});
const resources = (result: FindResult): CatalogResource[] =>
    result.results.filter((item): item is CatalogResource => Array.isArray(item));
const paths = (result: FindResult): string[] => resources(result).map(([item]) => item.path);

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
        const foundPaths = paths(r);
        // BOTH rows whose projection carries the phrase match: the EDIT's rx echoes the written
        // span, the READ's rx carries the retrieved content — FIND matches exactly what READ shows.
        assert.ok(foundPaths.includes("log:///1/1/2/READ"), "the READ-result row matches by its content");
        assert.ok(foundPaths.includes("log:///1/1/1/EDIT"), "the EDIT row matches too — its rx echoes the written span (the projection is the contract)");
        assert.ok(!foundPaths.some((x) => x.includes("/1/1/3/")), "the irrelevant row is excluded");
        assert.ok(resources(r).every(([item]) => (item.matchLocationCount ?? 0) > 0), "each selected row reports its addressable location count");
    } finally { await db.close(); }
});

test("a body-less FIND(log:///1/1) lists the turn's rows — the hierarchy is the scope", async () => {
    const { db, workerId } = await setup();
    try {
        const r = await new Log().find(findStmt(urlPath("log", "/1/1")), makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 3, "the turn's three rows, catalog-shaped");
        const projected = JSON.parse(r.content!) as Array<Array<Record<string, unknown>>>;
        assert.equal(projected[0]?.[0]?.tokens, resources(r)[0]?.[0].weight);
        assert.equal(Object.hasOwn(projected[0]?.[0] ?? {}, "weight"), false, "model projection translates internal weight once");
        assert.equal(r.content!.split("\n").length, r.results.length, "log FIND uses the same one-item-per-line rendering as entry FIND");
        assert.ok(paths(r).every((path) => /^log:\/\/\/1\/1\/\d+\//.test(path)), "each item carries log:///loop/turn/seq/OP");
        assert.ok(resources(r).every(([item]) => item.weight >= 0), "each default channel carries internal curation weight");
    } finally { await db.close(); }
});

test("an exact body-less log FIND returns 404 when the resource does not exist", async () => {
    const { db, workerId } = await setup();
    try {
        const result = await new Log().find(
            findStmt(urlPath("log", "/9/9/9/READ")),
            makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/log/entry-not-found");
        assert.equal(result.problem?.target, "log:///9/9/9/READ");
    } finally { await db.close(); }
});

test("an exact log FIND rejects a supplied /OP suffix that disagrees with an existing row", async () => {
    const { db, workerId } = await setup();
    try {
        const result = await new Log().find(
            findStmt(urlPath("log", "/1/1/1/READ")),
            makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(result.status, 404);
        assert.equal(result.problem?.target, "log:///1/1/1/READ");
    } finally { await db.close(); }
});

test("markerless log FIND returns the first 16 rows with a compact selection extent", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        for (let sequence = 4; sequence <= 20; sequence++) {
            await engine.dispatch({
                statement: editStmt(`/entry-${sequence}.md`, `row ${sequence}`),
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence,
                origin: "model",
            });
        }
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES });
        const bounded = await log.find(findStmt(urlPath("log", "/1/1")), ctx);
        assert.equal(bounded.results.length, 16);
        assert.equal(bounded.range?.total, 20);
        assert.deepEqual(bounded.range?.returned, [1, 16]);
        assert.ok(bounded.itemsWeightTotal > bounded.returnedItemsWeightTotal);

        const all = await log.find({
            ...findStmt(urlPath("log", "/1/1")),
            lineMarker: { marks: [1, -1] },
        }, ctx);
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
        assert.equal(all.itemsWeightTotal, all.returnedItemsWeightTotal);
    } finally { await db.close(); }
});

test("a single-star log FIND maps one coordinate level without crossing separators", async () => {
    const { db, workerId } = await setup();
    try {
        const log = new Log();
        const ctx = makeSchemeCtx({ db, workerId, mimetypes: DEFAULT_MIMETYPES });

        const root = await log.find(findStmt(urlPath("log", "/*")), ctx);
        assert.equal(root.status, 200);
        assert.deepEqual(paths(root), ["log:///1/**"]);
        const loop = resources(root)[0]?.[0];
        assert.ok(loop !== undefined && "items" in loop && loop.items === 3 && loop.weight >= 0, "the loop scope summarizes its recursive rows");
        assert.equal(root.matchingPathCount, 0, "the summary is navigation metadata, not a hidden row match");

        const segmented = await log.find(findStmt(urlPath("log", "/*/*/*")), ctx);
        assert.equal(segmented.results.length, 3, "one star per canonical coordinate segment reaches the rows");
        assert.ok(paths(segmented).every((path) => /^log:\/\/\/1\/1\/\d+\//.test(path)));

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
            unit: "resource",
            total: 3,
            requested: [9, 9],
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
        const match = matchLocations(result)[0];
        assert.equal(match?.locator, "$['second']");
        assert.equal(match?.region?.startLine, 3);
        assert.equal(match?.region?.endLine, 3);
        assert.ok((match?.region?.endColumn ?? 0) > (match?.region?.startColumn ?? 0));
    } finally { await db.close(); }
});

test("FIND(log:///**):/pattern/ — FIND locates matching log entries", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const result = await engine.dispatch({
            statement: findStmt(urlPath("log", "/**"), { dialect: "regex", raw: "/engine hums/", pattern: "engine hums", flags: "" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 4, origin: "model",
        });
        assert.equal(result.status, 200, "FIND locates log entries");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; sequence: number }>({ loop_id: loopId });
        const delivered = rows.filter((r) => r.op === "FIND" && r.sequence >= 4);
        assert.ok(delivered.length >= 1, "the matching FIND row is recorded");
    } finally { await db.close(); }
});

test("READ(log://)<1,-1> returns a composed row's complete canonical body", async () => {
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
            model_call_id: null,
            op: "PLAN",
            suffix: "",
            signal: null,
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            query: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ body: full }),
            mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 200 }),
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: 0,
            state: "resolved",
            outcome: null,
            attrs: "{}",
        });

        const result = await readLog(
            { ...readStmt(urlPath("log", "/1/1/4/PLAN")), lineMarker: { marks: [1, -1] } },
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
        assert.ok(paths(semantic).some((path) => path.includes("/1/1/2/READ")),
            "semantic rank returns the log address whose READ projection carries the phrase");
        assert.ok(semantic.results.length >= 2, "the semantic specimen has multiple ranked log results");
        const secondSemantic = await new Log().find(
            { ...semanticStatement, lineMarker: { marks: [2] } },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.deepEqual(
            paths(secondSemantic),
            paths(semantic).slice(1, 2),
            "log semantic FIND uses the same positional result scope as every FIND",
        );

        const graph = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "graph", raw: "@<helper" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(graph.status, 200);
        assert.ok(paths(graph).some((path) => path.includes("/1/1/5/READ")),
            "graph relation returns the log address whose readable code projection references helper");

        const graphMiss = await new Log().find(
            findStmt(urlPath("log", "/**"), { dialect: "graph", raw: "@<absentSymbol" } as MatcherBody),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES }),
        );
        assert.equal(graphMiss.status, 204, "entry and log relation misses share the universal matcher status");
        assert.deepEqual(graphMiss.results, []);
    } finally { await db.close(); }
});

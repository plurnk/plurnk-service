// The uniform matcher contract end-to-end through the engine. A matcher selects
// resources; FIND lists each resource with match coordinates, while READ
// returns one whole/scoped body per resource with the same evidence.
//
// These exercise the real dispatch path (engine.dispatch -> #handleReadFanout / scheme.find),
// not the scheme methods in isolation. Real Mimetypes so
// jsonpath/xpath/semantic resolve; SearchIndex.maintain makes @graph + embeddings query-ready.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { FindStatement, ReadStatement, EditStatement, PlurnkStatement } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";

// A ~semantic READ-honors-FIND case (#286) asserts REAL vector ranking — re-enable the embedder the
// fast lane turns off (.env.test PLURNK_SERVICE_EMBED_DISABLE=1); --test-isolation scopes this to this file.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const parseOp = <T extends PlurnkStatement>(dsl: string, op: T["op"]): T => {
    const found = PlurnkParser.parse(`<<PLAN::PLAN\n${dsl}`).items.find((i) => i.kind === "statement" && i.statement.op === op);
    if (found === undefined) throw new Error(`no ${op} parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: T }).statement;
};

const setup = async () => {
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `uniform-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "uniform");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, mimetypes });
    return { db, engine, mimetypes, workspaceId, workerId, loopId, turnId, ctx };
};

// Seed with literal (possibly multiline) content — the EDIT heredoc body can't carry raw
// newlines, so build the statement then set the real body before dispatching to the scheme.
const seedRaw = async (ctx: ReturnType<typeof makeSchemeCtx>, name: string, content: string): Promise<void> => {
    const k = new Worker();
    const stmt = parseOp<EditStatement>(`<<EDIT(worker:///${name}):x:EDIT`, "EDIT");
    await k.edit({ ...stmt, body: content }, ctx);
};

type StoredRead = {
    content?: string;
    startLine?: number | null;
    status?: number;
    matches?: Array<{ lineStart: number; lineEnd: number; rowStart: number; rowEnd: number; path?: string }>;
};

// Dispatch an op and collect every resource delivery's stored result.
const dispatchRows = async (
    db: Db, engine: Engine, ids: { workspaceId: number; workerId: number; loopId: number; turnId: number },
    statement: PlurnkStatement,
): Promise<{ result: { status: number; rowsWritten?: number }; rows: StoredRead[] }> => {
    const result = await engine.dispatch({ statement, ...ids, sequence: 1, origin: "model" }) as { status: number; rowsWritten?: number };
    const rows: StoredRead[] = [];
    for (let s = 1; s <= (result.rowsWritten ?? 1); s++) {
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({ worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence: s });
        if (row !== undefined) rows.push(JSON.parse(row.rx) as StoredRead);
    }
    return { result, rows };
};

// --- READ honors FIND: one row per resource, coordinates as evidence ----------

test("READ recognizes shell character-class paths as fan-out globs, not only patterns containing `*`", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a1.md", "one");
        await seedRaw(ctx, "a2.md", "two");
        await seedRaw(ctx, "nested/a3.md", "three");
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///a[12].md)::READ", "READ"));
        assert.equal(result.rowsWritten, 2);
        assert.deepEqual(rows.map((row) => row.content), ["one", "two"], "the character class selects both direct entries");
    } finally { await db.close(); }
});

test("glob READ returns one resource with every matched line in metadata", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target\ndelta target");
        const { rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///log.md):*target*:READ", "READ"));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, "alpha target\nbeta\ngamma target\ndelta target");
        assert.deepEqual(rows[0].matches?.map(({ lineStart }) => lineStart), [1, 3, 4]);
    } finally { await db.close(); }
});

test("regex READ returns one whole body per selected resource", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "intro\nerror: one\ntail");
        await seedRaw(ctx, "b.md", "error: two\nmore");
        await seedRaw(ctx, "c.md", "clean");
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///**):/error: \\w+/:READ", "READ"));
        assert.equal(result.rowsWritten, 2);
        assert.deepEqual(rows.map((r) => r.content).toSorted(), [
            "error: two\nmore",
            "intro\nerror: one\ntail",
        ]);
        assert.deepEqual(rows.flatMap((row) => row.matches ?? []).map(({ lineStart }) => lineStart).toSorted(), [1, 2]);
    } finally { await db.close(); }
});

test("jsonpath READ returns one JSON resource with path and row coordinates", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "team.json", '{\n  "users": [\n    { "name": "Alice" },\n    { "name": "Bob" },\n    { "name": "Carol" }\n  ]\n}');
        const { rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///team.json):$.users[*].name:READ", "READ"));
        assert.equal(rows.length, 1);
        assert.match(rows[0].content ?? "", /Alice.*Bob.*Carol/s);
        assert.deepEqual(rows[0].matches?.map(({ lineStart }) => lineStart), [3, 4, 5]);
        assert.deepEqual(rows[0].matches?.map(({ path }) => path), [
            "$['users'][0]['name']",
            "$['users'][1]['name']",
            "$['users'][2]['name']",
        ]);
    } finally { await db.close(); }
});

test("two structural matches on one source line remain distinguishable by path", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "one.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}');
        const { rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///one.json):$.users[*].name:READ", "READ"));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].matches?.length, 2);
        assert.notEqual(rows[0].matches?.[0]?.path, rows[0].matches?.[1]?.path);
    } finally { await db.close(); }
});

test("[#286] a matcher READ with zero matches writes a single 204 row, never silence", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "nothing here");
        const { result } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///**):*absent*:READ", "READ"));
        assert.equal(result.status, 204);
        assert.equal(result.rowsWritten, 1);
    } finally { await db.close(); }
});

test("semantic READ uses ranking to select resources and returns their bodies", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "db.md", "the database connection failed with a timeout error");
        await seedRaw(ctx, "cake.md", "preheat the oven and frost the birthday cake");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///**):~database connection error:READ", "READ"));
        assert.equal(result.status, 200);
        assert.equal(rows.length, 2, "top-3 exhaustively ranks the two-document corpus");
        assert.match(rows[0].content ?? "", /database connection/, "the closest chunk ranks first");
    } finally { await db.close(); }
});

test("xpath READ returns one HTML resource with node coordinates", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "page.html", "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>");
        const { rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///page.html)://li:READ", "READ"));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].content, "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>");
        assert.deepEqual(rows[0].matches?.map(({ lineStart }) => lineStart), [2, 3]);
    } finally { await db.close(); }
});

test("@graph READ returns each selected resource with reference coordinates", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///**):@<foo:READ", "READ"));
        assert.equal(result.status, 200);
        assert.ok((result.rowsWritten ?? 0) >= 1);
        assert.ok(rows.some((r) => /foo\(\)/.test(r.content ?? "")), "a reference line is delivered as content");
        assert.ok(rows.some((r) => (r.matches?.length ?? 0) >= 1));
    } finally { await db.close(); }
});

test("@graph FIND groups reference coordinates by resource", async () => {
    const { db, workspaceId, workerId, mimetypes, ctx, loopId, turnId } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, mimetypes }));
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///**):@<foo:FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length >= 1);
        assert.ok(r.results.every((x) => (x.matches?.length ?? 0) >= 1));
    } finally { await db.close(); }
});

// --- The target contract: bare = exact, folder/glob = scope — uniform for FIND and READ ------

test("[#286] FIND(bare entry) is the ONE entry — never a prefix that pulls siblings", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "config.md", "the config");
        await seedRaw(ctx, "config.md.bak", "the backup");
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///config.md)::FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results.map((x) => x.path), ["worker:///config.md"], "bare = exact: config.md.bak is NOT pulled in");
    } finally { await db.close(); }
});

test("[#286] FIND(folder/) returns the folder's contents; a glob is a scope", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "docs/a.md", "alpha");
        await seedRaw(ctx, "docs/b.md", "beta");
        await seedRaw(ctx, "top.md", "top");
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///docs/)::FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results.map((x) => x.path).toSorted(), ["worker:///docs/a.md", "worker:///docs/b.md"], "folder/ = its contents, not top.md");
    } finally { await db.close(); }
});

test("[#286] READ(folder/) reads the folder's contents — one row per entry, whole", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "docs/a.md", "alpha body");
        await seedRaw(ctx, "docs/b.md", "beta body");
        await seedRaw(ctx, "top.md", "top body");
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///docs/)::READ", "READ"));
        assert.equal(result.rowsWritten, 2);
        assert.deepEqual(rows.map((r) => r.content).toSorted(), ["alpha body", "beta body"], "each row is an entry's whole content");
    } finally { await db.close(); }
});

// --- FIND emits one resource row with coordinate evidence --------------------

test("FIND with a matcher emits one item per resource with all coordinates", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target");
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///**):*target*:FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 1);
        assert.deepEqual(r.results[0].matches, [
            { lineStart: 1, lineEnd: 1, rowStart: 1, rowEnd: 1 },
            { lineStart: 3, lineEnd: 3, rowStart: 3, rowEnd: 3 },
        ]);
    } finally { await db.close(); }
});

test("FIND pagination counts selected resources, not match occurrences", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "target one\ntarget two\ntarget three");
        await seedRaw(ctx, "b.md", "target four");
        const result = await new Worker().find(
            parseOp<FindStatement>("<<FIND(worker:///**)<2>:*target*:FIND", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(result.results.map(({ path }) => path), ["worker:///b.md"]);
        assert.deepEqual(result.results[0]?.matches, [
            { lineStart: 1, lineEnd: 1, rowStart: 1, rowEnd: 1 },
        ]);
    } finally { await db.close(); }
});

test("FIND coordinates compose into scoped READ for structured JSON", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "users.json", [
            "[",
            "  {",
            '    "name": "Alice",',
            '    "role": "admin"',
            "  },",
            "  {",
            '    "name": "Bob",',
            '    "role": "user"',
            "  }",
            "]",
        ].join("\n"));
        const worker = new Worker();
        const found = await worker.find(
            parseOp<FindStatement>('<<FIND(worker:///users.json):$[?(@.role=="admin")]:FIND', "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(found.results[0]?.matches, [{
            lineStart: 2,
            lineEnd: 5,
            rowStart: 1,
            rowEnd: 1,
            path: "$[0]",
        }]);
        const span = found.results[0]?.matches?.[0];
        assert.ok(span);
        const read = await worker.read(
            {
                ...parseOp<ReadStatement>("<<READ(worker:///users.json)<1,1>::READ", "READ"),
                lineMarker: { marks: [span.rowStart, span.rowEnd] },
            },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(read.status, 200);
        assert.deepEqual(JSON.parse(read.content ?? ""), [{ name: "Alice", role: "admin" }]);
    } finally { await db.close(); }
});

test("body-less FIND is the catalog without match metadata", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "alpha");
        await seedRaw(ctx, "b.md", "beta");
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///**)::FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.results.length, 2, "two entries → two catalog rows");
        assert.ok(r.results.every((x) => x.matches === undefined));
    } finally { await db.close(); }
});

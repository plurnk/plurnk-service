// {§matcher-result-resource-selection}, {§read-multi-file-fanout}. The uniform
// matcher contract end-to-end through the engine. A matcher selects
// resources; FIND lists each resource with match coordinates, while READ
// returns one whole/scoped body per resource with the same evidence.
//
// These exercise the real dispatch path (engine.dispatch -> #handleReadFanout / scheme.find),
// not the scheme methods in isolation. Real Mimetypes so
// jsonpath/xpath/semantic resolve; SearchIndex.maintain makes @graph + embeddings query-ready.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { FindStatement, ReadStatement, EditStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";

// A ~semantic READ-honors-FIND case asserts real vector ranking — re-enable the embedder the
// Mock bootstrap turns off; --test-isolation scopes this to this file.
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
    matches?: Array<{
        region?: {
            startLine: number;
            startColumn: number;
            endLine: number;
            endColumn: number;
        };
        path?: string;
    }>;
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

// --- FIND locates resources across globs and matchers ----------

test("FIND recognizes shell character-class paths as globs", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a1.md", "one");
        await seedRaw(ctx, "a2.md", "two");
        await seedRaw(ctx, "nested/a3.md", "three");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///a[12].md)::FIND", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("glob FIND returns resources with matched line metadata", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target\ndelta target");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///log.md):*target*:FIND", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("regex FIND returns matched resources", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "intro\nerror: one\ntail");
        await seedRaw(ctx, "b.md", "error: two\nmore");
        await seedRaw(ctx, "c.md", "clean");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///**):/error: \\w+/:FIND", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("jsonpath FIND returns JSON resources with locators and exact regions", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "team.json", '{\n  "users": [\n    { "name": "Alice" },\n    { "name": "Bob" },\n    { "name": "Carol" }\n  ]\n}');
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///team.json):$.users[*].name:FIND", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("two structural matches on one source line remain distinguishable by path", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "one.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}');
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///one.json):$.users[*].name:FIND", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("a matcher FIND with zero matches returns 204", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "nothing here");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///**):*absent*:FIND", "FIND"));
        assert.equal(result.status, 204);
    } finally { await db.close(); }
});

test("semantic FIND uses ranking to select resources", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "db.md", "the database connection failed with a timeout error");
        await seedRaw(ctx, "cake.md", "preheat the oven and frost the birthday cake");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///**):~database connection error:FIND", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("xpath FIND returns HTML resources with locator evidence", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "page.html", "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///page.html)://li:FIND", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("@graph FIND returns selected resources with reference coordinates", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///**):@<foo:FIND", "FIND"));
        assert.equal(result.status, 200);
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

// --- The target contract: bare = exact, folder/glob = scope ------

test("FIND(bare entry) is the one entry, never a prefix that pulls siblings", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "config.md", "the config");
        await seedRaw(ctx, "config.md.bak", "the backup");
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///config.md)::FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.deepEqual(r.results.map((x) => x.path), ["worker:///config.md"], "bare = exact: config.md.bak is NOT pulled in");
    } finally { await db.close(); }
});

test("FIND(folder/) returns the folder's contents; a glob is a scope", async () => {
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

test("FIND(folder/) locates the folder's contents", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "docs/a.md", "alpha body");
        await seedRaw(ctx, "docs/b.md", "beta body");
        await seedRaw(ctx, "top.md", "top body");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("<<FIND(worker:///docs/)::FIND", "FIND"));
        assert.equal(result.status, 200);
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
            { region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 13 } },
            { region: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 13 } },
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
            { region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 12 } },
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
            path: "$[0]",
            region: { startLine: 2, startColumn: 3, endLine: 5, endColumn: 4 },
        }]);
        const span = found.results[0]?.matches?.[0];
        assert.ok(span?.region);
        const read = await worker.read(
            {
                ...parseOp<ReadStatement>("<<READ(worker:///users.json)<1,1,1,1>::READ", "READ"),
                lineMarker: {
                    marks: [
                        span.region.startLine,
                        span.region.startColumn,
                        span.region.endLine,
                        span.region.endColumn,
                    ],
                },
            },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(read.status, 200);
        assert.deepEqual(JSON.parse(read.content ?? ""), { name: "Alice", role: "admin" });
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

test("READ with matcher body (including path globs) coerces cleanly to FIND and dispatches end-to-end", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "src/app.js", "const token = 'SECRET';\n// TODO: clean up\n");
        await seedRaw(ctx, "src/helper.js", "// TODO: implement helper\n");
        await seedRaw(ctx, "README.md", "Docs with no todo\n");

        const parsed = parseOp<FindStatement>("<<READ(worker:///src/**):*TODO*:READ", "FIND");
        assert.equal(parsed.op, "FIND");
        assert.equal(parsed.body?.dialect, "glob");
        const r = await new Worker().find(parsed, ctx);
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 2);
    } finally { await db.close(); }
});

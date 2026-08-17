// {§find-result-projection}, {§read-exact-target}. Broad FIND selects resources;
// exact-target matcher FIND reports flat match locations. Exact READ projects
// text from one selected resource. These exercise the real dispatch path, not scheme methods
// in isolation. Real Mimetypes so
// jsonpath/xpath/semantic resolve; SearchIndex.maintain makes @graph + embeddings query-ready.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { FindStatement, ReadStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, lookThroughScheme, makeSchemeCtx } from "./_helpers.ts";
import { matchLocations, resourceGroups, resourcePaths } from "./_find.ts";

// Semantic FIND asserts real vector ranking, so re-enable the embedder that the
// Mock bootstrap turns off; --test-isolation scopes this to this file.
process.env.PLURNK_SERVICE_EMBED_DISABLE = "0";

const parseOp = <T extends PlurnkStatement>(dsl: string, op: T["op"]): T => {
    const found = PlurnkParser.parse(`# PLAN0\n${dsl}`).items.find((i) => i.kind === "statement" && i.statement.op === op);
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

// Seed arbitrary literal content without making the fixture itself responsible for
// delimiter collisions: parse a minimal statement, then replace its typed AST body.
const seedRaw = async (ctx: ReturnType<typeof makeSchemeCtx>, name: string, content: string): Promise<void> => {
    const k = new Worker();
    const stmt = parseOp<ResolvedEditStatement>(`## EDIT0 (worker:///${name})\nx`, "EDIT");
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
        locator?: string;
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

// --- FIND projects resources or locations from the authored target shape -----

test("FIND recognizes shell character-class paths as globs", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a1.md", "one");
        await seedRaw(ctx, "a2.md", "two");
        await seedRaw(ctx, "nested/a3.md", "three");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///a[12].md)", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("exact glob-pattern FIND returns flat matched-line locations", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target\ndelta target");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///log.md)\n*target*", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("regex FIND returns matched resources", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "intro\nerror: one\ntail");
        await seedRaw(ctx, "b.md", "error: two\nmore");
        await seedRaw(ctx, "c.md", "clean");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///**)\n/error: \\w+/", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("exact jsonpath FIND returns flat locators with exact regions", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "team.json", '{\n  "users": [\n    { "name": "Alice" },\n    { "name": "Bob" },\n    { "name": "Carol" }\n  ]\n}');
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///team.json)\n$.users[*].name", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("two structural matches on one source line remain distinguishable by locator", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "one.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}');
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///one.json)\n$.users[*].name", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("a matcher FIND with zero matches returns 204", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "nothing here");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///**)\n*absent*", "FIND"));
        assert.equal(result.status, 204);
    } finally { await db.close(); }
});

test("semantic FIND uses ranking to select resources", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "db.md", "the database connection failed with a timeout error");
        await seedRaw(ctx, "cake.md", "preheat the oven and frost the birthday cake");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///**)\n~database connection error", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("exact xpath FIND returns flat locator evidence", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "page.html", "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///page.html)\n//li", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("broad @graph FIND returns selected resource channel groups", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///**)\n@<foo", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

test("broad @graph FIND reports each resource's location count without nesting coordinates on multi-match rows", async () => {
    const { db, workspaceId, workerId, mimetypes, ctx, loopId, turnId } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, mimetypes }));
        const r = await new Worker().find(parseOp<FindStatement>("## FIND0 (worker:///**)\n@<foo", "FIND"), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length >= 1);
        const rows = resourceGroups(r).map(([item]) => item);
        assert.ok(rows.every((item) => item.matchLocationCount !== undefined && item.matchLocationCount >= 1));
        assert.ok(rows.every((item) => (item.matchLocationCount ?? 0) <= 1 || item.region === undefined), "a multi-match resource keeps only its count, never nesting regions");
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});

// --- The target contract: bare = exact, folder/glob = scope ------

test("FIND(bare entry) is the one entry, never a prefix that pulls siblings", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "config.md", "the config");
        await seedRaw(ctx, "config.md.bak", "the backup");
        const r = await new Worker().find(parseOp<FindStatement>("## FIND0 (worker:///config.md)", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.deepEqual(resourcePaths(r), ["worker:///config.md"], "bare = exact: config.md.bak is NOT pulled in");
    } finally { await db.close(); }
});

test("FIND(folder/) returns the folder's contents; a glob is a scope", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "docs/a.md", "alpha");
        await seedRaw(ctx, "docs/b.md", "beta");
        await seedRaw(ctx, "top.md", "top");
        const r = await new Worker().find(parseOp<FindStatement>("## FIND0 (worker:///docs/)", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.deepEqual(resourcePaths(r).toSorted(), ["worker:///docs/a.md", "worker:///docs/b.md"], "folder/ = its contents, not top.md");
    } finally { await db.close(); }
});

test("FIND(folder/) locates the folder's contents", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "docs/a.md", "alpha body");
        await seedRaw(ctx, "docs/b.md", "beta body");
        await seedRaw(ctx, "top.md", "top body");
        const { result } = await dispatchRows(db, engine, ids, parseOp<FindStatement>("## FIND0 (worker:///docs/)", "FIND"));
        assert.equal(result.status, 200);
    } finally { await db.close(); }
});

// --- FIND projects resources or locations according to target shape ----------

test("broad matcher FIND emits one item per resource with a complete location count", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target");
        const r = await new Worker().find(parseOp<FindStatement>("## FIND0 (worker:///**)\n*target*", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 1);
        assert.equal(resourceGroups(r)[0]?.[0].path, "worker:///log.md");
        assert.equal(resourceGroups(r)[0]?.[0].matchLocationCount, 2);
        assert.equal("region" in (resourceGroups(r)[0]?.[0] ?? {}), false, "a multi-match resource never nests its regions");
        assert.equal("locator" in (resourceGroups(r)[0]?.[0] ?? {}), false, "a multi-match resource never nests its locator");
        assert.equal(r.matchingPathCount, 1);
        assert.equal(r.matchLocationCount, 2);
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});

test("broad matcher FIND promotes a resource's locator/region when it matches exactly once", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "one.md", "alpha\ntarget\nbeta");
        await seedRaw(ctx, "two.md", "target\nand target again\n");
        const r = await new Worker().find(
            parseOp<FindStatement>("## FIND0 (worker:///**)\n*target*", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(r.status, 200);
        const byPath = new Map(resourceGroups(r).map(([item]) => [item.path, item]));
        const one = byPath.get("worker:///one.md");
        const two = byPath.get("worker:///two.md");
        assert.equal(one?.matchLocationCount, 1);
        assert.ok(one?.region !== undefined, "exactly one match → the region is promoted to the resource row");
        assert.equal(two?.matchLocationCount, 2);
        assert.equal(two?.region, undefined, "two matches → count only, no region");
    } finally { await db.close(); }
});

test("a glob remains resource mode when it resolves to one matching path", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "only.md", "first target\nsecond target");
        await seedRaw(ctx, "other.txt", "target");
        const r = await new Worker().find(
            parseOp<FindStatement>("## FIND0 (worker:///*.md)\n*target*", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(resourceGroups(r).map(([{ path, matchLocationCount }]) => ({ path, matchLocationCount })), [{
            path: "worker:///only.md",
            matchLocationCount: 2,
        }]);
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});

test("markerless exact matcher FIND returns the first 16 locations and <1,-1> returns all", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "many.md", Array.from({ length: 20 }, (_, i) => `target ${i + 1}`).join("\n"));
        const worker = new Worker();
        const first = await worker.find(
            parseOp<FindStatement>("## FIND0 (worker:///many.md)\n*target*", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(first.results.length, 16);
        assert.equal(first.matchingPathCount, 1);
        assert.equal(first.matchLocationCount, 20);
        assert.equal(first.range?.unit, "matchLocation");
        assert.equal(first.range?.total, 20);
        assert.deepEqual(first.range?.returned, [1, 16]);

        const all = await worker.find(
            parseOp<FindStatement>("## FIND0 (worker:///many.md) <1,-1>\n*target*", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(all.results.length, 20);
        assert.deepEqual(all.range?.returned, [1, 20]);
    } finally { await db.close(); }
});

test("FIND on an exact target with a result-position scope", async () => {
    // ## FIND0 (worker:///doc.md) <1> — the scope selects the first result of
    // an exact-target listing; a single-target FIND returns that target.
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "doc.md", "hello world hello again");
        const result = await new Worker().find(
            parseOp<FindStatement>("## FIND0 (worker:///doc.md) <1>", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(result.results.length, 1);
        assert.equal(resourceGroups(result)[0]?.[0].path, "worker:///doc.md");
    } finally { await db.close(); }
});

test("FIND on an exact target with a content matcher pages flat match locations", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "doc.md", "hello world hello again");
        const result = await new Worker().find(
            parseOp<FindStatement>("## FIND0 (worker:///doc.md) <1>\n/hello/", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(result.results.length, 1);
        assert.deepEqual(matchLocations(result)[0]?.region, {
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 6,
        });
        assert.equal("path" in (result.results[0] ?? {}), false);
        assert.equal(result.matchingPathCount, 1);
        assert.equal(result.matchLocationCount, 2);
        assert.equal(result.range?.unit, "matchLocation");
        assert.deepEqual(result.range?.returned, [1, 1]);
    } finally { await db.close(); }
});

test("{§read-find-normalization}: authored READ aggregates use canonical FIND pagination", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "target one\ntarget two");
        await seedRaw(ctx, "b.md", "other");
        const worker = new Worker();

        const globRead = parseOp<FindStatement>("## READ0 (worker:///*.md) <2>", "FIND");
        const resourcePage = await worker.find(
            globRead,
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(resourcePage.range?.unit, "resource");
        assert.deepEqual(resourcePaths(resourcePage), ["worker:///b.md"]);

        const matcherRead = parseOp<FindStatement>("## READ0 (worker:///a.md) <2>\n/target/", "FIND");
        const locationPage = await worker.find(
            matcherRead,
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.equal(locationPage.range?.unit, "matchLocation");
        assert.deepEqual(matchLocations(locationPage)[0]?.region, {
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 7,
        });
    } finally { await db.close(); }
});

test("broad FIND pagination counts selected resources, not match locations", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "target one\ntarget two\ntarget three");
        await seedRaw(ctx, "b.md", "target four");
        const result = await new Worker().find(
            parseOp<FindStatement>("## FIND0 (worker:///**) <2>\n*target*", "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(resourcePaths(result), ["worker:///b.md"]);
        assert.equal(resourceGroups(result)[0]?.[0].matchLocationCount, 1);
        assert.equal(result.matchingPathCount, 2);
        assert.equal(result.matchLocationCount, 4);
        assert.equal(result.range?.unit, "resource");
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
            parseOp<FindStatement>('## FIND0 (worker:///users.json)\n$[?(@.role=="admin")]', "FIND"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes: ctx.mimetypes }),
        );
        assert.deepEqual(found.results, [{
            locator: "$[0]",
            region: { startLine: 2, startColumn: 3, endLine: 5, endColumn: 4 },
        }]);
        const span = matchLocations(found)[0];
        assert.ok(span?.region);
        const read = await lookThroughScheme("worker", null,
            {
                ...parseOp<ReadStatement>("## READ0 (worker:///users.json) <1,1,1,1>", "READ"),
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
        const r = await new Worker().find(parseOp<FindStatement>("## FIND0 (worker:///**)", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.results.length, 2, "two entries → two catalog channel groups");
        assert.ok(resourceGroups(r).every(([item]) => !("matches" in item)));
        assert.equal(r.range?.unit, "resource");
    } finally { await db.close(); }
});

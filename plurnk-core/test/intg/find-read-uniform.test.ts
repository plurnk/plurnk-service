// #286 — the uniform matcher contract, end-to-end through the engine. The promise: ONE
// paradigm, zero per-dialect exceptions. A matcher resolves to (file, span) ITEMS; FIND lists
// them, READ delivers them (one log row per match, the span's content). The target contract is
// shared with READ: bare = the entry (exact), trailing-slash/glob = a scope that fans out.
//
// These exercise the real dispatch path (engine.dispatch → #handleReadFanout / scheme.find),
// not the scheme methods in isolation — that's where per-match fan-out lives. Real Mimetypes so
// jsonpath/xpath/semantic resolve; maintainDerivations so @graph + embeddings are indexed.

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { FindStatement, ReadStatement, EditStatement, PlurnkStatement } from "@plurnk/plurnk-grammar";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
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

// Dispatch an op and collect the per-match log rows' stored rx (content + startLine), in order.
const dispatchRows = async (
    db: Db, engine: Engine, ids: { workspaceId: number; workerId: number; loopId: number; turnId: number },
    statement: PlurnkStatement,
): Promise<{ result: { status: number; rowsWritten?: number }; rows: Array<{ content?: string; startLine?: number | null; status?: number }> }> => {
    const result = await engine.dispatch({ statement, ...ids, sequence: 1, origin: "model" }) as { status: number; rowsWritten?: number };
    // rows = the DELIVERIES: sequence 1 is the FIND selection-summary row (§matcher-selection-signal).
    const rows: Array<{ content?: string; startLine?: number | null; status?: number }> = [];
    for (let s = 2; s <= (result.rowsWritten ?? 0); s++) {
        const row = await (db.log_read_by_coordinate as PrepMethod).get<{ rx: string }>({ worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence: s });
        if (row !== undefined) rows.push(JSON.parse(row.rx) as { content?: string; startLine?: number | null; status?: number });
    }
    return { result, rows };
};

// --- READ honors FIND: one row per match, the span's content, every dialect -----------------

test("[#286] glob READ — multiple matches in ONE file fan out to multiple rows (per-match, not per-file)", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target\ndelta target");
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///log.md):*target*:READ", "READ"));
        assert.equal(result.rowsWritten, 4, "the FIND summary + three matching lines in one file");
        assert.deepEqual(rows.map((r) => `${r.startLine}:${r.content}`), ["1:alpha target", "3:gamma target", "4:delta target"]);
    } finally { await db.close(); }
});

test("[#286] regex READ across files — one row per match, each at its (file, span)", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.md", "intro\nerror: one\ntail");
        await seedRaw(ctx, "b.md", "error: two\nmore");
        await seedRaw(ctx, "c.md", "clean");
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///**):#error: \\w+#:READ", "READ"));
        assert.equal(result.rowsWritten, 3, "the FIND summary + two matches across two files (c excluded)");
        assert.deepEqual(rows.map((r) => r.content).toSorted(), ["error: one", "error: two"]);
    } finally { await db.close(); }
});

test("[#286] jsonpath READ over JSON — per-match rows, each the SOURCE LINE (not item-index mis-slice)", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "team.json", '{\n  "users": [\n    { "name": "Alice" },\n    { "name": "Bob" },\n    { "name": "Carol" }\n  ]\n}');
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///team.json):$.users[*].name:READ", "READ"));
        assert.equal(result.rowsWritten, 4, "the FIND summary + three name rows (a structural mimetype does NOT collapse to item-index)");
        assert.deepEqual(rows.map((r) => r.startLine), [3, 4, 5], "each row at its source line");
        assert.match(rows[1].content ?? "", /Bob/);
    } finally { await db.close(); }
});

test("[#286] dedup by span — two matches on one source line collapse to a single row", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "one.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}');
        const { result } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///one.json):$.users[*].name:READ", "READ"));
        assert.equal(result.rowsWritten, 2, "the FIND summary + ONE delivery — both hits on line 1 dedup to one row");
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

test("[#286] ~semantic READ honors FIND — the ranked chunks come back as rows (READ delivers what FIND selects)", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "db.md", "the database connection failed with a timeout error");
        await seedRaw(ctx, "cake.md", "preheat the oven and frost the birthday cake");
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///**)<3>:~database connection error:READ", "READ"));
        assert.equal(result.status, 200);
        assert.equal(rows.length, 2, "top-3 exhaustively ranks the two-document corpus");
        assert.match(rows[0].content ?? "", /database connection/, "the closest chunk ranks first");
    } finally { await db.close(); }
});

test("[#286] xpath READ over HTML — per-match rows, each the source line of the matched node", async () => {
    const { db, engine, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "page.html", "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>");
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///page.html)://li:READ", "READ"));
        assert.equal(result.rowsWritten, 3, "the FIND summary + two <li> rows");
        assert.deepEqual(rows.map((r) => r.startLine), [2, 3], "each row at its node's source line");
    } finally { await db.close(); }
});

test("[#286] @graph READ honors FIND — references come back as rows, one per occurrence", async () => {
    const { db, engine, mimetypes, ctx, ...ids } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, ...ids, mimetypes }));
        const { result, rows } = await dispatchRows(db, engine, ids, parseOp<ReadStatement>("<<READ(worker:///**):@<foo:READ", "READ"));
        assert.equal(result.status, 200);
        assert.ok((result.rowsWritten ?? 0) >= 1, "@graph READ fans out the referencing occurrences");
        assert.ok(rows.some((r) => /foo\(\)/.test(r.content ?? "")), "a reference line is delivered as content");
    } finally { await db.close(); }
});

test("[#286] @graph FIND emits per-occurrence items carrying spans (uniform with content dialects)", async () => {
    const { db, workspaceId, workerId, mimetypes, ctx, loopId, turnId } = await setup();
    try {
        await seedRaw(ctx, "a.ts", "export function foo() {}\n");
        await seedRaw(ctx, "b.ts", "import { foo } from \"./a\";\nfoo();\nfoo();\n");
        await EntryManifest.maintainDerivations(makeSchemeCtx({ db, workspaceId, workerId, loopId, turnId, mimetypes }));
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///**):@<foo:FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));
        assert.equal(r.status, 200);
        assert.ok(r.results.length >= 1, "@graph FIND returns the referencing entries' occurrences");
        assert.ok(r.results.every((x) => x.matchSpan !== undefined), "each @graph item carries a (file, span)");
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
        assert.equal(result.rowsWritten, 3, "the FIND summary + two folder entries (top.md excluded)");
        assert.deepEqual(rows.map((r) => r.content).toSorted(), ["alpha body", "beta body"], "each row is an entry's whole content");
    } finally { await db.close(); }
});

// --- FIND emits per-match items carrying their span -----------------------------------------

test("[#286] FIND with a matcher emits one item per match, each carrying its (file, span)", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "log.md", "alpha target\nbeta\ngamma target");
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///**):*target*:FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200);
        assert.equal(r.results.length, 2, "two matches in one file → two items");
        assert.deepEqual(r.results.map((x) => x.matchSpan), [{ lineStart: 1, lineEnd: 1 }, { lineStart: 3, lineEnd: 3 }], "each item carries the span it matched");
    } finally { await db.close(); }
});

test("[#286] body-less FIND is the catalog — one item per entry, no span", async () => {
    const { db, workspaceId, workerId, ctx } = await setup();
    try {
        await seedRaw(ctx, "a.md", "alpha");
        await seedRaw(ctx, "b.md", "beta");
        const r = await new Worker().find(parseOp<FindStatement>("<<FIND(worker:///**)::FIND", "FIND"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.results.length, 2, "two entries → two catalog rows");
        assert.ok(r.results.every((x) => x.matchSpan === undefined), "the catalog carries no match span");
    } finally { await db.close(); }
});

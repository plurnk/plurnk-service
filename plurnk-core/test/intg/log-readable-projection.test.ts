import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import Log from "../../src/schemes/Log.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx, openMigrated, readLog, seedEntryWithChannel, seedEnvelope } from "./_helpers.ts";
import { findStmt, readStmt, urlPath } from "./_dsl.ts";

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `log-readable-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const dispatch = async (source: string) => {
        const { items } = PlurnkParser.parseClient(source);
        assert.equal(items.length, 1, source);
        const item = items[0];
        assert.equal(item?.kind, "statement", source);
        if (item?.kind !== "statement") throw new Error("test operation did not parse");
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement as PlurnkStatement });
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence,
        });
        assert.ok(row);
        return JSON.parse(row.rx);
    };
    return { db, ids, dispatch, reserve: () => ++sequence };
};

test("{§log-readable-projection}: READ and COPY omit deliberate trims in original coordinates", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    assert.equal((await dispatch("```EDIT (worker:///source.txt)\none\ntwo\nsecret\nfour\nfive\n```")).status, 201);
    assert.equal((await dispatch("```READ (worker:///source.txt) <1,-1>```")).status, 200);
    const target = "log:///1/1/2/READ";
    assert.equal((await dispatch(`\`\`\`KILL (${target}) <3>\`\`\``)).status, 200);
    const read = await dispatch(`\`\`\`READ (${target}) <2,4>\`\`\``);
    assert.equal(read.status, 200);
    assert.equal(read.content, "two\nfour");
    assert.deepEqual(read.lineOrdinals, [2, 4]);
    assert.equal((await dispatch(`\`\`\`COPY (log:///1/1/2) <${read.lineAnchors[1]}> (worker:///anchored.txt)\`\`\``)).status, 201);
    assert.equal((await dispatch("```READ (worker:///anchored.txt) <1,-1>```")).content, "four", "canonical leaf aliases share anchor identity");
    assert.equal((await dispatch(`\`\`\`COPY (${target}) <2,4> (worker:///copy.txt)\`\`\``)).status, 201);
    assert.equal((await dispatch("```READ (worker:///copy.txt) <1,-1>```")).content, "two\nfour");
    assert.equal((await dispatch(`\`\`\`FIND (${target})
/secret/
\`\`\``)).status, 204);
    const found = await dispatch(`\`\`\`FIND (${target})
/four/
\`\`\``);
    assert.equal(found.status, 200);
    assert.equal(JSON.parse(found.content)[0].region.startLine, 4);
    assert.equal((await dispatch(`\`\`\`READ (${target}) <3>\`\`\``)).status, 204);
    assert.equal((await dispatch(`\`\`\`COPY (${target}) (log:///1/1/2/READ)\`\`\``)).status, 400, "the log is never a write target");
    // {§move-decomposition}: MOVE from a log region is the COPY above plus the same scoped KILL —
    // the destination receives the readable lines, the projection trims them, the evidence stays.
    const moved = await dispatch(`\`\`\`MOVE (${target}) <2,4> (worker:///moved.txt)\`\`\``);
    assert.equal(moved.status, 201, JSON.stringify(moved));
    assert.deepEqual(
        (moved.effects as Array<{ target: string; action: string }>).map(({ target: t, action }) => `${action} ${t}`),
        ["create worker:///moved.txt", `update ${target}`],
    );
    assert.equal((await dispatch("```READ (worker:///moved.txt) <1,-1>```")).content, "two\nfour", "the destination holds exactly the readable region");
    assert.equal((await dispatch(`\`\`\`READ (${target}) <1,-1>\`\`\``)).content, "one\nfive", "the moved lines left the readable projection");
    const whole = await dispatch(`\`\`\`MOVE (${target}) (worker:///rest.txt)\`\`\``);
    assert.equal(whole.status, 201, JSON.stringify(whole));
    assert.deepEqual(
        (whole.effects as Array<{ target: string; action: string }>).map(({ target: t, action }) => `${action} ${t}`),
        ["create worker:///rest.txt", `delete ${target}`],
        "an unscoped MOVE retires the row exactly as an unscoped KILL does",
    );
    assert.equal((await dispatch("```READ (worker:///rest.txt) <1,-1>```")).content, "one\nfive");
    const original = (await db.test_log_entries_by_loop.all<{ sequence: number; rx: string; active: number }>({ loop_id: ids.loopId }))
        .find((row) => row.sequence === 2);
    assert.ok(original, "the recorded row is still there");
    assert.equal(original.active, 0, "retired from the active projection");
    assert.equal(JSON.parse(original.rx).content, "one\ntwo\nsecret\nfour\nfive", "curation never rewrites recorded evidence");
});

test("{§log-readable-projection}: FIND prices retained bodies consistently in rows and folders", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    const content = "apple\nsecret\npear";
    await dispatch(`\`\`\`EDIT (worker:///source.txt)
${content}
\`\`\``);
    await dispatch("```READ (worker:///source.txt) <1,-1>```");
    const log = new Log();
    const ctx = makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES });
    const weigh = ctx.weigh ?? contentWeight;
    const folderWeight = async () => {
        const result = await log.find(findStmt(urlPath("log", "/*")), ctx);
        assert.equal(result.status, 200);
        const folder = result.results.find((item) => Array.isArray(item) && item[0].path === "log:///1/**");
        assert.ok(Array.isArray(folder) && "items" in folder[0]);
        return folder[0].weight;
    };
    const before = await folderWeight();
    assert.equal((await dispatch("```KILL (log:///1/1/2/READ) <2>```")).status, 200);
    const result = await log.find(findStmt(urlPath("log", "/1/1/2/READ")), ctx);
    assert.equal(result.status, 200);
    const item = result.results[0];
    assert.ok(Array.isArray(item));
    assert.ok("lines" in item[0]);
    assert.equal(item[0].lines, 3, "scope planning still uses the original physical line domain");
    assert.equal(item[0].weight, weigh("apple\npear"));
    assert.equal(await folderWeight(), before - weigh(content) + item[0].weight, "folder weight excludes the trimmed line too");
});

test("{§log-readable-projection}: a byte-view receipt is readable text, not a second binary resource", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    await seedEntryWithChannel(db, {
        workspaceId: ids.workspaceId, pathname: "/data.bin",
        content: Buffer.from([0, 1, 2, 3]).toString("base64"), mimetype: "application/octet-stream",
    });
    const sourceRead = await dispatch("```READ (worker:///data.bin) <1,-1>```");
    assert.equal(sourceRead.status, 200);
    assert.equal(sourceRead.projection, "hex");
    assert.equal(sourceRead.mimetype, "application/octet-stream");
    const target = "log:///1/1/1/READ";
    const complete = await dispatch(`\`\`\`READ (${target}) <1,-1>\`\`\``);
    assert.equal(complete.status, 200, JSON.stringify(complete));
    assert.equal(complete.content, sourceRead.content);
    assert.equal((await dispatch(`\`\`\`KILL (${target}) <2>\`\`\``)).status, 200);
    const found = await dispatch(`\`\`\`FIND (${target})
/02/
\`\`\``);
    assert.equal(found.status, 200);
    assert.equal(JSON.parse(found.content)[0].region.startLine, 3);
    await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES }));
    assert.equal((await dispatch(`\`\`\`FIND (${target})
~02
\`\`\``)).status, 200, "hex receipt text participates in FTS");
    assert.equal((await dispatch(`\`\`\`FIND (${target})
~01
\`\`\``)).status, 204, "FTS omits the trimmed byte-view line");
    assert.equal((await dispatch(`\`\`\`COPY (${target}) (worker:///hex.txt)\`\`\``)).status, 201);
    const copied = await dispatch("```READ (worker:///hex.txt) <1,-1>```");
    assert.equal(copied.content, "00\n02\n03");
    const repeatedSource = await dispatch("```READ (worker:///data.bin) <1,-1>```");
    assert.equal(repeatedSource.content, sourceRead.content, "the binary source still contains every original byte");
    const original = await db.log_read_by_coordinate.get<{ rx: string }>({ worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence: 1 });
    assert.deepEqual(JSON.parse(original!.rx), sourceRead, "the source mimetype and original byte receipt remain intact in forensic history");
});

test("{§log-readable-projection}: initially suppressed programs remain readable until explicitly trimmed, and forks preserve both facts", async (t) => {
    const { db, ids, dispatch, reserve } = await runtime(t);
    const content = "```TASK\n[{\"content\":\"continue\",\"status\":\"in_progress\"}]\n```";
    const sequence = reserve();
    await db.engine_insert_log_entry.get({
        worker_id: ids.workerId, loop_id: ids.loopId, turn_id: ids.turnId, sequence,
        origin: "model", source: null, model_call_id: null, op: null,
        scheme: null, username: null, password: null, hostname: null, port: null,
        pathname: null, query: null, fragment: null, lineMarker: null,
        tx: "", mimetype_tx: "text/vnd.plurnk", rx: JSON.stringify({ content, mimetype: "text/vnd.plurnk" }),
        mimetype_rx: "application/json", status_rx: 200, weight: contentWeight(content),
        state: "resolved", outcome: null, attrs: JSON.stringify({ kind: "turnOps" }), initial_folded: "[[1,-1]]",
    });
    const target = "log:///1/1/1/ops";
    assert.equal((await dispatch(`\`\`\`READ (${target}) <1,-1>\`\`\``)).content, content);
    await t.test("COPY of a textual program into plain text remains verbatim", async () => {
        const copied = await dispatch(`\`\`\`COPY (${target}) (worker:///program.txt)\`\`\``);
        assert.equal(copied.status, 201, JSON.stringify(copied));
    });
    assert.equal((await dispatch(`\`\`\`KILL (${target}) <2>\`\`\``)).status, 200);
    const branch = await Fork.fork(db, ids.workerId, "branch");
    const forkRead = await readLog({ ...readStmt(urlPath("log", "/1/1/1/ops")), lineMarker: { marks: [1, -1] } }, makeSchemeCtx({ db, workspaceId: ids.workspaceId, workerId: branch }));
    assert.equal(forkRead.content, "```TASK\n```");
    const forkRows = await db.fork_get_log_entries.all<{ initial_folded: string; projection_folded: string }>({ worker_id: branch });
    assert.equal(forkRows[0]?.initial_folded, "[[1,-1]]");
    assert.equal(forkRows[0]?.projection_folded, "[[2,2]]");
    assert.equal((await dispatch(`\`\`\`KILL (${target}) <1,-1>\`\`\``)).status, 200);
    assert.equal((await dispatch(`\`\`\`READ (${target}) <1,-1>\`\`\``)).status, 204);
    const stillReadable = await readLog({ ...readStmt(urlPath("log", "/1/1/1/ops")), lineMarker: { marks: [1, -1] } }, makeSchemeCtx({ db, workspaceId: ids.workspaceId, workerId: branch }));
    assert.equal(stillReadable.content, forkRead.content, "parent curation does not change the branch's projection");
    const original = await db.log_read_by_coordinate.get<{ rx: string }>({ worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence });
    assert.equal(JSON.parse(original!.rx).content, content);
    assert.equal((await dispatch(`\`\`\`KILL (${target})\`\`\``)).status, 200);
    assert.equal((await dispatch(`\`\`\`READ (${target})\`\`\``)).status, 404);
    assert.equal((await dispatch(`\`\`\`COPY (${target}) (worker:///retired.txt)\`\`\``)).status, 404);
});

test("{§log-readable-projection}: trimming invalidates search and a racing derivation cannot reattach old content", { timeout: 10_000 }, async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    await dispatch("```EDIT (worker:///source.txt)\napple\nsecret\npear\n```");
    await dispatch("```READ (worker:///source.txt) <1,-1>```");
    await dispatch("```KILL (worker:///source.txt)```");
    const ctx = makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES });
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const process = DEFAULT_MIMETYPES.process.bind(DEFAULT_MIMETYPES);
    t.mock.method(DEFAULT_MIMETYPES, "process", async (...args: Parameters<typeof process>) => {
        if (args[0].path === "1/1/2/READ") {
            started.resolve();
            await resume.promise;
        }
        return process(...args);
    });
    const inFlight = SearchIndex.maintain(ctx);
    try {
        await started.promise;
        assert.equal((await dispatch("```KILL (log:///1/1/2/READ) <2>```")).status, 200);
    } finally { resume.resolve(); }
    await inFlight;
    const candidates = await db.log_find_candidates.all<{ coordinate: string; deep_hash: string | null }>({ worker_id: ids.workerId, scope_prefix: null, max_id: null });
    assert.equal(candidates.find((row) => row.coordinate === "1/1/2")?.deep_hash, null, "stale in-flight derivation was not attached");
    await SearchIndex.maintain(ctx);
    assert.equal((await dispatch("```FIND (log:///1/1/2/READ)\n~secret\n```")).status, 204);
    const retained = await dispatch("```FIND (log:///1/1/2/READ)\n~pear\n```");
    assert.equal(retained.status, 200);
    assert.equal(JSON.parse(retained.content)[0].region.startLine, 3);
    assert.equal((await dispatch("```KILL (log:///1/1/2/READ) <3>```")).status, 200);
    await SearchIndex.maintain(ctx);
    assert.equal((await dispatch("```FIND (log:///1/1/2/READ)\n~pear\n```")).status, 204, "later curation also invalidates an already attached artifact");
    const read = await dispatch("```READ (log:///1/1/2/READ) <1,-1>```");
    const wire = PacketWire.renderLog([{ coordinate: "1/1/99", op: "READ", origin: "model", status: read.status, rx: read, lineAnchors: read.lineAnchors, lineNumberWidth: read.lineNumberWidth }], contentWeight);
    assert.match(wire, /1:apple/);
    assert.doesNotMatch(wire, /secret|pear/);
});

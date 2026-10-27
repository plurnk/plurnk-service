import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import Log from "../../src/schemes/Log.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import Fork from "../../src/core/fork.ts";
import LogEntry from "../../src/server/logEntry.ts";
import Turn from "../../src/core/Turn.ts";
import { testExecutors, quiesceExecs } from "./_execs.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEnvelope, rootWorkspace, seedEntryWithChannel } from "./_db.ts";
import { makeSchemeCtx, readLog, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { urlPath, findStmt, readStmt } from "./_dsl.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { fixtureExecutors } from "./_mock.ts";
import { serverProposals } from "./_approval.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyPatch, parsePatch, reversePatch } from "diff";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { type Db } from "../../src/core/Db.ts";


describe("log-mutation-patch", () => {
// {§log-wire-format} — a settled file mutation's row keeps the unified diff of what it did, served
// as the row's `patch` channel; a byte write keeps none; a fork copies it; the diff reverses exactly.

















const execFileP = promisify(execFile);
type Row = { status_rx: number; rx: string; patch: string | null };
const ORIGINAL = "one\ntwo\nthree\n";
// A real PNG header: NUL-bearing bytes the mimetype registry classifies as binary.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const runtime = async (t: TestContext) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "log-mutation-patch-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, "a.md"), ORIGINAL);
    await writeFile(join(root, "bin.png"), PNG);
    await git(["add", "a.md", "bin.png"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    const db = await openMigrated();
    const ids = await seedEnvelope(db, `log-mutation-patch-${crypto.randomUUID()}`);
    await rootWorkspace(db, ids.workspaceId, root);
    const schemes = new SchemeRegistry();
    const executors = await testExecutors();
    schemes.registerRuntimeSchemes(executors);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(executors);
    // Git membership: the tracked files become members, as the first turn's pass makes them.
    await engine.warmWorkspaceDerivations(ids.workspaceId);
    t.after(async () => {
        await quiesceExecs(schemes);
        db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    let sequence = 0;
    const row = (sessionId: number, seq: number) => db.log_read_by_coordinate.get<Row>({ session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence: seq });
    const dispatch = async (source: string): Promise<Row & { sequence: number; content: string }> => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const written = await row(ids.sessionId, sequence);
        assert.ok(written, source);
        const parsed = JSON.parse(written.rx) as { content?: unknown };
        return { ...written, sequence, content: typeof parsed.content === "string" ? parsed.content : "" };
    };
    return { db, ids, root, dispatch, row };
};

test("{§log-wire-format} every settled text mutation keeps its diff on its row; a byte write keeps none; the diff reverses exactly", async (t) => {
    const { db, ids, root, dispatch, row } = await runtime(t);

    // A READ materializes the member and its revision, as every real turn does before an EDIT.
    assert.equal((await dispatch("````READ (a.md) <1,-1>````")).status_rx, 200);
    const edited = await dispatch("````EDIT (a.md) <2>\nTWO\n````");
    assert.equal(edited.status_rx, 200, `the line edit lands: ${edited.rx.slice(0, 200)}`);
    assert.ok(edited.patch, "an EDIT of a text member keeps its patch");
    assert.match(edited.patch, /^Index: a\.md\n=+\n--- a\.md\tcurrent\n\+\+\+ a\.md\tproposed\n@@ -1,3 \+1,3 @@\n one\n-two\n\+TWO\n three\n$/u, "the patch is the unified diff, current to proposed");
    assert.equal(await readFile(join(root, "a.md"), "utf8"), "one\nTWO\nthree\n");
    // The diff is exact enough to undo: reverse-apply it to the written file and the original returns.
    const [hunk] = parsePatch(edited.patch);
    assert.equal(applyPatch("one\nTWO\nthree\n", reversePatch(hunk)), ORIGINAL, "reverse-applying the row's patch restores the original text");
    assert.doesNotMatch(edited.rx, /current\n\+\+\+/u, "the receipt carries no patch");

    const created = await dispatch("````EDIT (new.md)\nhello\n````");
    assert.ok(created.status_rx < 300, `create: ${created.rx.slice(0, 200)}`);
    assert.match(created.patch ?? "", /--- new\.md\tcurrent\n\+\+\+ new\.md\tproposed\n@@ -0,0 \+1,1 @@\n\+hello\n/u, "a creation's patch adds every line from nothing");

    const copied = await dispatch("````COPY (a.md) (copy.md)````");
    assert.ok(copied.status_rx < 300, `COPY: ${copied.rx.slice(0, 200)}`);
    assert.match(copied.patch ?? "", /\+\+\+ copy\.md\tproposed\n@@ -0,0 \+1,3 @@\n\+one\n\+TWO\n\+three\n$/u, "a COPY into a new file keeps the destination's patch");

    const moved = await dispatch("````MOVE (copy.md) (moved.md)````");
    assert.ok(moved.status_rx < 300, `MOVE: ${moved.rx.slice(0, 200)}`);
    const movedPatch = moved.patch ?? "";
    assert.match(movedPatch, /\+\+\+ moved\.md\tproposed\n@@ -0,0 \+1,3 @@\n\+one\n\+TWO\n\+three\n/u, "a MOVE keeps the destination write");
    assert.match(movedPatch, /--- copy\.md\tcurrent\n\+\+\+ copy\.md\tproposed\n@@ -1,3 \+0,0 @@\n-one\n-TWO\n-three\n$/u, "and the source removal, in application order");
    assert.ok(movedPatch.indexOf("moved.md\tproposed") < movedPatch.indexOf("copy.md\tcurrent"), "destination before source");

    const killed = await dispatch("````KILL (moved.md)````");
    assert.ok(killed.status_rx < 300, `KILL: ${killed.rx.slice(0, 200)}`);
    assert.match(killed.patch ?? "", /^Index: moved\.md\n=+\n--- moved\.md\tcurrent\n\+\+\+ moved\.md\tproposed\n@@ -1,3 \+0,0 @@\n-one\n-TWO\n-three\n$/u, "a KILL keeps every removed line");

    const bytes = await dispatch("````COPY (bin.png) (bin2.png)````");
    assert.ok(bytes.status_rx < 300, `binary COPY: ${bytes.rx.slice(0, 200)}`);
    assert.equal(bytes.patch, null, "a byte write keeps no patch");

    // The row serves its diff as the `patch` channel; a row without one has no such channel.
    const read = await dispatch(`\`\`\`\`READ (log:///1/1/${edited.sequence}/EDIT#patch) <1,-1>\`\`\`\``);
    assert.equal(read.status_rx, 200, `READ #patch: ${read.rx.slice(0, 200)}`);
    assert.match(read.content, /-two/u);
    assert.match(read.content, /\+TWO/u);
    const missing = await dispatch(`\`\`\`\`READ (log:///1/1/${bytes.sequence}/COPY#patch) <1,-1>\`\`\`\``);
    assert.equal(missing.status_rx, 404, `a patchless row has no patch channel: ${missing.rx.slice(0, 200)}`);

    // A fork copies the row with its patch.
    const branch = await Fork.fork(db, ids.sessionId, "branch");
    assert.equal((await row(branch, edited.sequence))?.patch, edited.patch, "the fork's copy of the EDIT row carries the same patch");
    assert.equal((await row(branch, bytes.sequence))?.patch, null, "and the patchless row stays patchless");
});
});

describe("log-readable-projection", () => {
const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `log-readable-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const dispatch = async (source: string) => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        assert.equal(items.length, 1, source);
        const item = items[0];
        assert.equal(item?.kind, "statement", source);
        if (item?.kind !== "statement") throw new Error("test operation did not parse");
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence,
        });
        assert.ok(row);
        return JSON.parse(row.rx);
    };
    return { db, ids, dispatch, reserve: () => ++sequence };
};

test("{§log-kill-scope}: READ and COPY omit deliberate trims in original coordinates", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    assert.equal((await dispatch("````EDIT (workspace:///source.txt)\none\ntwo\nsecret\nfour\nfive\n````")).status, 201);
    assert.equal((await dispatch("````READ (workspace:///source.txt) <1,-1>````")).status, 200);
    const target = "log:///1/1/2/READ";
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <3>\`\`\`\``)).status, 200);
    const read = await dispatch(`\`\`\`\`READ (${target}) <2,4>\`\`\`\``);
    assert.equal(read.status, 200);
    assert.equal(read.content, "two\nfour");
    assert.deepEqual(read.lineOrdinals, [2, 4]);
    assert.equal((await dispatch(`\`\`\`\`COPY (log:///1/1/2) <${read.lineAnchors[1]}> (workspace:///anchored.txt)\`\`\`\``)).status, 201);
    assert.equal((await dispatch("````READ (workspace:///anchored.txt) <1,-1>````")).content, "four", "canonical leaf aliases share anchor identity");
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) <2,4> (workspace:///copy.txt)\`\`\`\``)).status, 201);
    assert.equal((await dispatch("````READ (workspace:///copy.txt) <1,-1>````")).content, "two\nfour");
    assert.equal((await dispatch(`\`\`\`\`FIND (${target}) /secret/\`\`\`\``)).status, 204);
    const found = await dispatch(`\`\`\`\`FIND (${target}) /four/\`\`\`\``);
    assert.equal(found.status, 200);
    assert.match(JSON.parse(found.content)[0].region, /^<4,/u);
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <3>\`\`\`\``)).status, 204);
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) (log:///1/1/2/READ)\`\`\`\``)).status, 400, "the log is never a write target");
    // {§move}: MOVE from a log region is the COPY above plus the same scoped KILL —
    // the destination receives the readable lines, the projection trims them, the evidence stays.
    const moved = await dispatch(`\`\`\`\`MOVE (${target}) <2,4> (workspace:///moved.txt)\`\`\`\``);
    assert.equal(moved.status, 201, JSON.stringify(moved));
    assert.deepEqual(
        (moved.effects as Array<{ target: string; action: string }>).map(({ target: effectTarget, action }) => `${action} ${effectTarget}`),
        ["create workspace:///moved.txt", `update ${target}`],
    );
    assert.equal((await dispatch("````READ (workspace:///moved.txt) <1,-1>````")).content, "two\nfour", "the destination holds exactly the readable region");
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``)).content, "one\nfive", "the moved lines left the readable projection");
    const whole = await dispatch(`\`\`\`\`MOVE (${target}) (workspace:///rest.txt)\`\`\`\``);
    assert.equal(whole.status, 201, JSON.stringify(whole));
    assert.deepEqual(
        (whole.effects as Array<{ target: string; action: string }>).map(({ target: effectTarget, action }) => `${action} ${effectTarget}`),
        ["create workspace:///rest.txt", `delete ${target}`],
        "an unscoped MOVE retires the row exactly as an unscoped KILL does",
    );
    assert.equal((await dispatch("````READ (workspace:///rest.txt) <1,-1>````")).content, "one\nfive");
    const original = (await db.test_log_entries_by_loop.all<{ sequence: number; rx: string; active: number }>({ loop_id: ids.loopId }))
        .find((row) => row.sequence === 2);
    assert.ok(original, "the recorded row is still there");
    assert.equal(original.active, 0, "retired from the active projection");
    assert.equal(JSON.parse(original.rx).content, "one\ntwo\nsecret\nfour\nfive", "curation never rewrites recorded evidence");
});

test("{§log-wire-format}: a stored source slice and its curated log resource retain their own extents", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    const content = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, pathname: "/source.txt", content, mimetype: "text/plain" });
    const original = await dispatch("````READ (workspace:///source.txt) <17,18>````");
    assert.equal(original.content, "line 17\nline 18");
    assert.equal((await dispatch("````KILL (log:///1/1/1/READ) <1>````")).status, 200);
    const reread = await dispatch("````READ (log:///1/1/1/READ) <1,-1>````");
    assert.equal(reread.content, "line 18");
    assert.deepEqual(reread.range, { unit: "line", total: 2, requested: [1, -1], returned: [2, 2] });
    const recorded = await db.log_read_by_coordinate.get<{ rx: string; folded: string; status_rx: number }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 });
    assert.ok(recorded);
    assert.deepEqual(JSON.parse(recorded.rx), original, "curation did not modify the recorded acquisition");
    const [row] = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/1/1", op: "READ", status: recorded.status_rx,
        target: { scheme: "workspace", pathname: "/source.txt" }, rx: JSON.parse(recorded.rx), folded: recorded.folded,
    }], contentWeight));
    assert.equal(row?.range, "<17,18> of 30 lines");
    assert.deepEqual(row?.trimmed, ["<1>"]);
    assert.equal(row?.body, "18:line 18\n");
    assert.equal((await dispatch("````READ (workspace:///source.txt) <1,-1>````")).content, content, "the source still has every line");
});

test("{§log-kill-scope}: a multiline pattern never copies a curated gap", async (t) => {
    const { dispatch } = await runtime(t);
    await dispatch("````EDIT (workspace:///source.txt)\nalpha\nsecret\nomega\n````");
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
    const target = "log:///1/1/2/READ";
    await dispatch(`\`\`\`\`KILL (${target}) <2>\`\`\`\``);
    const pattern = "/alpha\\nomega/";
    const found = await dispatch(`\`\`\`\`FIND (${target}) ${pattern}\`\`\`\``);
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.deepEqual(JSON.parse(found.content).map(({ region }: { region: unknown }) => region), [
        "<1,1,2,1>",
        "<3,1,3,6>",
    ]);
    const read = await dispatch(`\`\`\`\`READ (${target}) <1,-1> ${pattern}\`\`\`\``);
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.content, "alpha\nomega");
    const copied = await dispatch(`\`\`\`\`COPY (${target}) <1,3> (workspace:///copy.txt)\`\`\`\``);
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.equal((await dispatch("````READ (workspace:///copy.txt) <1,-1>````")).content, "alpha\nomega");
});

test("{§log-kill-scope}: FIND prices retained bodies consistently in rows and folders", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    const content = "apple\nsecret\npear";
    await dispatch(`\`\`\`\`EDIT (workspace:///source.txt)
${content}
\`\`\`\``);
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
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
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <2>````")).status, 200);
    const result = await log.find(findStmt(urlPath("log", "/1/1/2/READ")), ctx);
    assert.equal(result.status, 200);
    const item = result.results[0];
    assert.ok(Array.isArray(item));
    assert.ok("lines" in item[0]);
    assert.equal(item[0].lines, 3, "scope planning still uses the original physical line domain");
    assert.equal(item[0].weight, weigh("apple\npear"));
    assert.equal(await folderWeight(), before - weigh(content) + item[0].weight, "folder weight excludes the trimmed line too");
});

test("{§log-kill-scope}: a byte-view receipt is readable text, not a second binary resource", async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    await seedEntryWithChannel(db, {
        workspaceId: ids.workspaceId, pathname: "/data.bin",
        content: Buffer.from([0, 1, 2, 3]).toString("base64"), mimetype: "application/octet-stream",
    });
    const sourceRead = await dispatch("````READ (workspace:///data.bin) <1,-1>````");
    assert.equal(sourceRead.status, 200);
    assert.equal(sourceRead.projection, "hex");
    assert.equal(sourceRead.mimetype, "application/octet-stream");
    const target = "log:///1/1/1/READ";
    const complete = await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``);
    assert.equal(complete.status, 200, JSON.stringify(complete));
    assert.equal(complete.content, sourceRead.content);
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <2>\`\`\`\``)).status, 200);
    const found = await dispatch(`\`\`\`\`FIND (${target}) /02/\`\`\`\``);
    assert.equal(found.status, 200);
    assert.match(JSON.parse(found.content)[0].region, /^<3,/u);
    await SearchIndex.maintain(makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES }));
    assert.equal((await dispatch(`\`\`\`\`FIND (${target}) ~02\`\`\`\``)).status, 200, "hex receipt text participates in FTS");
    assert.equal((await dispatch(`\`\`\`\`FIND (${target}) ~01\`\`\`\``)).status, 204, "FTS omits the trimmed byte-view line");
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) (workspace:///hex.txt)\`\`\`\``)).status, 201);
    const copied = await dispatch("````READ (workspace:///hex.txt) <1,-1>````");
    assert.equal(copied.content, "00\n02\n03");
    const repeatedSource = await dispatch("````READ (workspace:///data.bin) <1,-1>````");
    assert.equal(repeatedSource.content, sourceRead.content, "the binary source still contains every original byte");
    const original = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 });
    assert.deepEqual(JSON.parse(original!.rx), sourceRead, "the source mimetype and original byte receipt remain intact in forensic history");
});

test("{§log-kill-scope}: initially suppressed program READ receipts remain readable until explicitly trimmed, and forks preserve both facts", async (t) => {
    const { db, ids, dispatch, reserve } = await runtime(t);
    const content = "````NOTE\ncontinue\n````";
    const sequence = reserve();
    await db.engine_insert_log_entry.get({
        session_id: ids.sessionId, loop_id: ids.loopId, turn_id: ids.turnId, sequence,
        origin: "model", source: null, model_call_id: null, op: "READ",
        scheme: null, username: null, password: null, hostname: null, port: null,
        pathname: null, query: null, fragment: null, lineMarker: null,
        tx: "", mimetype_tx: "text/vnd.plurnk", rx: JSON.stringify({ content, mimetype: "text/vnd.plurnk" }),
        mimetype_rx: "application/json", status_rx: 200, weight: contentWeight(content),
        state: "resolved", outcome: null, attrs: "{}", initial_folded: "[[1,-1]]",
    });
    const target = "log:///1/1/1/READ";
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``)).content, content);
    await t.test("{§log-kill-scope} COPY of a textual program into plain text remains verbatim", async () => {
        const copied = await dispatch(`\`\`\`\`COPY (${target}) (workspace:///program.txt)\`\`\`\``);
        assert.equal(copied.status, 201, JSON.stringify(copied));
    });
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <2>\`\`\`\``)).status, 200);
    const branch = await Fork.fork(db, ids.sessionId, "branch");
    const forkRead = await readLog({ ...readStmt(urlPath("log", "/1/1/1/READ")), lineMarker: { marks: [1, -1] } }, makeSchemeCtx({ db, workspaceId: ids.workspaceId, sessionId: branch }));
    assert.equal(forkRead.content, "````NOTE\n````");
    const forkRows = await db.test_fork_log_entries.all<{ initial_folded: string; projection_folded: string }>({ session_id: branch });
    assert.equal(forkRows[0]?.initial_folded, "[[1,-1]]");
    assert.equal(forkRows[0]?.projection_folded, "[[2,2]]");
    assert.equal((await dispatch(`\`\`\`\`KILL (${target}) <1,-1>\`\`\`\``)).status, 200);
    assert.equal((await dispatch(`\`\`\`\`READ (${target}) <1,-1>\`\`\`\``)).status, 204);
    const stillReadable = await readLog({ ...readStmt(urlPath("log", "/1/1/1/READ")), lineMarker: { marks: [1, -1] } }, makeSchemeCtx({ db, workspaceId: ids.workspaceId, sessionId: branch }));
    assert.equal(stillReadable.content, forkRead.content, "parent curation does not change the branch's projection");
    const original = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence });
    assert.equal(JSON.parse(original!.rx).content, content);
    assert.equal((await dispatch(`\`\`\`\`KILL (${target})\`\`\`\``)).status, 200);
    assert.equal((await dispatch(`\`\`\`\`READ (${target})\`\`\`\``)).status, 404);
    assert.equal((await dispatch(`\`\`\`\`COPY (${target}) (workspace:///retired.txt)\`\`\`\``)).status, 404);
});

test("{§log-kill-scope}: trimming invalidates search and a racing derivation cannot reattach old content", { timeout: 10_000 }, async (t) => {
    const { db, ids, dispatch } = await runtime(t);
    await dispatch("````EDIT (workspace:///source.txt)\napple\nsecret\npear\n````");
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
    await dispatch("````KILL (workspace:///source.txt)````");
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
        assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <2>````")).status, 200);
    } finally { resume.resolve(); }
    await inFlight;
    const candidates = await db.log_find_candidates.all<{ coordinate: string; deep_hash: string | null }>({ session_id: ids.sessionId, scope_prefix: null, max_id: null });
    assert.equal(candidates.find((row) => row.coordinate === "1/1/2")?.deep_hash, null, "stale in-flight derivation was not attached");
    await SearchIndex.maintain(ctx);
    assert.equal((await dispatch("````FIND (log:///1/1/2/READ) ~secret````")).status, 204);
    const retained = await dispatch("````FIND (log:///1/1/2/READ) ~pear````");
    assert.equal(retained.status, 200);
    assert.match(JSON.parse(retained.content)[0].region, /^<3,/u);
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <3>````")).status, 200);
    await SearchIndex.maintain(ctx);
    assert.equal((await dispatch("````FIND (log:///1/1/2/READ) ~pear````")).status, 204, "later curation also invalidates an already attached artifact");
    const read = await dispatch("````READ (log:///1/1/2/READ) <1,-1>````");
    const wire = PacketWire.renderLog([{ coordinate: "1/1/99", op: "READ", origin: "model", status: read.status, rx: read, lineAnchors: read.lineAnchors, lineNumberWidth: read.lineNumberWidth }], contentWeight);
    assert.match(wire, /1(?:<@[0-9A-Za-z]{5}>|:)apple/);
    assert.doesNotMatch(wire, /secret|pear/);
});

// {§log-kill-scope} — the recorded emission replayed through the parser and the engine.
test("{§log-kill-scope} {§slicer-text-algebra}: `KILL (log:///…/READ) <0, -1>` is refused 416 with the forms a log body takes, which then work", async (t) => {
    const { dispatch } = await runtime(t);
    await dispatch("````EDIT (workspace:///source.txt)\none\ntwo\n````");
    await dispatch("````READ (workspace:///source.txt) <1,-1>````");
    const refused = await dispatch("````KILL (log:///1/1/2/READ) <0, -1>````");
    assert.equal(refused.status, 416);
    assert.match(refused.problem.type, /\/range-not-satisfiable$/);
    assert.equal(refused.problem.detail, "Range <0,-1> starts at 0, which is not a line; lines are numbered from 1."); // {§operation-results}
    assert.equal(refused.problem.recovery, "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/1/2/READ) with no scope retires the whole row."); // {§operation-results}
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ) <1,-1>````")).status, 200);
    assert.equal((await dispatch("````KILL (log:///1/1/2/READ)````")).status, 200);
});
});

describe("log_entries", () => {
type SqlValue = string | number | bigint | null;

const minimalLog = async (db: Db, ctx: { sessionId: number; loopId: number; turnId: number }, overrides: Record<string, SqlValue> = {}): Promise<number> => {
    const params: Record<string, SqlValue> = {
        session_id: ctx.sessionId, loop_id: ctx.loopId, turn_id: ctx.turnId,
        sequence: 1, origin: "model", op: "EDIT",
        source: null,
        signal: null,
        scheme: "workspace", pathname: "/meaning", port: null, query: null,
        lineMarker: null,
        tx: "````EDIT (workspace:///meaning)\n42\n````", mimetype_tx: "text/x-plurnk",
        rx: "", mimetype_rx: "text/plain", status_rx: 201,
        weight: 32, attrs: "{}",
        ...overrides,
    };
    const row = await db.test_log_entries_insert_full.get<{ id: number }>(params);
    if (row === undefined) throw new Error("log_entries insert returned no row");
    return row.id;
};

test("{§methods-invocation} fetchLogEntry surfaces loop_seq/turn_seq (ordinals), not just DB ids", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 3);   // loop ordinal 3
        const turnId = await insertTurn(db, loopId, 2);  // turn ordinal 2
        const id = await minimalLog(db, { sessionId, loopId, turnId }, { tx: JSON.stringify("in"), rx: JSON.stringify("out") });
        const wire = await LogEntry.fetchLogEntry(db, id);
        assert.equal(wire.loop_seq, 3, "loop ordinal on the wire");
        assert.equal(wire.turn_seq, 2, "turn ordinal on the wire");
        assert.equal(wire.loop_id, loopId, "DB loop id still present");
        assert.equal(wire.turn_id, turnId, "DB turn id still present");
    } finally { await db.close(); }
});

test("{§methods-invocation} fetchLogEntry preserves causal source and structured attributes", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, `wire-provenance-${crypto.randomUUID()}`);
        const id = await minimalLog(db, ctx, {
            origin: "_plurnk",
            source: "session://researcher",
            attrs: JSON.stringify({ kind: "entry_materialized" }),
            tx: JSON.stringify("in"),
            rx: JSON.stringify("out"),
        });
        const wire = await LogEntry.fetchLogEntry(db, id);
        assert.equal(wire.source, "session://researcher");
        assert.deepEqual(wire.attrs, { kind: "entry_materialized" });
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: sequence UNIQUE within turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionuniq");
        await minimalLog(db, ctx, { sequence: 1 });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 1 }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: sequence >= 1 enforced", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 0 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: origin enum", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-origin");
        for (const origin of ["model", "client", "_plurnk"] as const) {
            const turnId = origin === "model"
                ? ctx.turnId
                : (await Turn.open(db, { loopId: ctx.loopId, producer: origin, kind: "operation" })).id;
            await minimalLog(db, { ...ctx, turnId }, { origin });
        }
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 2, origin: "admin" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: session, loop, turn, producer, and model-call ownership are one chain", async () => {
    const db = await openMigrated();
    try {
        const first = await seedEnvelope(db, `ws-log-owner-a-${crypto.randomUUID()}`);
        const secondSession = await insertSession(db, first.workspaceId);
        const secondLoop = await insertLoop(db, secondSession, 1);
        const secondTurn = await Turn.open(db, { loopId: secondLoop, producer: "client", kind: "operation" });

        await assert.rejects(
            () => minimalLog(db, { ...first, turnId: secondTurn.id }),
            /log entry must match its turn ownership and producer/,
        );
        await assert.rejects(
            () => minimalLog(db, first, { origin: "client" }),
            /log entry must match its turn ownership and producer/,
        );

        const modelCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: first.turnId,
            kind: "emission",
            attributions: "[]",
            model: "mock/model",
        });
        assert.ok(modelCall !== undefined);
        await assert.rejects(
            () => db.engine_insert_log_entry.get({
                session_id: secondSession, loop_id: secondLoop, turn_id: secondTurn.id,
                sequence: 1, origin: "client", source: null, model_call_id: modelCall.id,
                op: "READ",
                scheme: "workspace", username: null, password: null, hostname: null, port: null,
                pathname: "/wrong-call", query: null, fragment: null, lineMarker: null,
                tx: "", mimetype_tx: "text/plain", rx: "", mimetype_rx: "text/plain",
                status_rx: 200, weight: 0, state: "resolved", outcome: null, attrs: "{}",
            }),
            /log entry model call does not match its represented result/,
        );
    } finally { await db.close(); }
});

test("{§turn-source-resources}: only rejected model attempts use actionless log rows", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionless-kinds");
        await minimalLog(db, ctx, {
            sequence: 1, origin: "model", op: null, attrs: JSON.stringify({ kind: "emissionAttempt" }),
        });
        for (const [sequence, origin, kind] of [
            [2, "model", "turnOps"],
            [3, "_plurnk", "turnOps"],
            [4, "_plurnk", "emissionAttempt"],
            [5, "model", "modelOutput"],
            [6, "model", "initialization"],
            [7, "model", "overflow"],
        ] as const) {
            await assert.rejects(
                () => minimalLog(db, ctx, { sequence, origin, op: null, attrs: JSON.stringify({ kind }) }),
                /(?:CHECK constraint failed|actionless log entry does not match its turn producer)/,
            );
        }
    } finally { await db.close(); }
});

// (No "op enum" test: log_entries.op does not CHECK-enumerate the grammar op set. Op validity lives at the parse
// (grammar) + type (PlurnkOp) layer; the column stores what the typed engine writes.)

test("{§db-migrations} log_entries: status_rx range 100..599", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-statusrx");
        for (const [i, s] of [100, 200, 499, 599].entries()) {
            await minimalLog(db, ctx, { sequence: i + 1, status_rx: s });
        }
        for (const bad of [99, 600, 0, -1]) {
            await assert.rejects(
                () => minimalLog(db, ctx, { sequence: 999, status_rx: bad }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: mimetype CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-mimetypes");
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_tx: "" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_rx: "" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: scheme nullable; non-empty CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tscheme");
        await minimalLog(db, ctx, { sequence: 1, scheme: null });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 2, scheme: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: port range", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tport");
        await minimalLog(db, ctx, { sequence: 1, port: 443 });
        await minimalLog(db, ctx, { sequence: 2, port: 0 });
        await minimalLog(db, ctx, { sequence: 3, port: 65535 });
        await minimalLog(db, ctx, { sequence: 4, port: null });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, port: 65536 }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 6, port: -1 }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("{§scheme-address} log_entries: serialized query preserves absence, empty, order, and duplicates", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-json");
        await minimalLog(db, ctx, { sequence: 1, query: null, lineMarker: null });
        await minimalLog(db, ctx, { sequence: 2, query: "", signal: '["+a","+b"]', lineMarker: '{"first":1,"last":10}' });
        await minimalLog(db, ctx, { sequence: 3, query: "b=2&a=1&a=3" });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 4, signal: "{bad" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, lineMarker: "broken" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: a malformed bound curation plan rolls back its row and every target change", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-curation-atomicity");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        for (const plan of [
            {
                targets: [{
                    id: targetId,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: [],
                    foldedAfter: [[0, -1]],
                }],
            },
            {
                targets: [{
                    id: targetId,
                    activeBefore: 1,
                    activeAfter: 1,
                    foldedBefore: [],
                    foldedAfter: [[5, 2]],
                }],
            },
        ]) {
            await assert.rejects(
                () => minimalLog(db, ctx, {
                    sequence: 2,
                    op: "KILL",
                    scheme: "log",
                    attrs: JSON.stringify({ __plurnk_curation: plan }),
                }),
                /invalid private log curation payload/,
            );
        }
        assert.equal(
            (await db.test_get_log_folded.get<{ folded: string }>({
                session_id: ctx.sessionId,
                loop_seq: 1,
                turn_seq: 1,
                sequence: 1,
            }))?.folded,
            "[]",
        );
        assert.equal(
            (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: ctx.turnId }))?.n,
            1,
            "the failed outer INSERT leaves no curation event row",
        );
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: folded body intervals are canonical and curation snapshots reject collisions", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-folded-intervals");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        await assert.rejects(
            () => db.log_set_folded_by_id.run({ id: targetId, folded: "[[1,2],[3,4]]" }),
            /folded ranges are invalid/,
            "adjacent intervals must be merged by the visibility owner",
        );
        await db.log_set_folded_by_id.run({ id: targetId, folded: "[[2,3]]" });
        await assert.rejects(
            () => minimalLog(db, ctx, {
                sequence: 2,
                op: "KILL",
                scheme: "log",
                attrs: JSON.stringify({
                    __plurnk_curation: {
                        targets: [{
                            id: targetId,
                            activeBefore: 1,
                            activeAfter: 1,
                            foldedBefore: [],
                            foldedAfter: [],
                        }],
                        add: [],
                        remove: [],
                    },
                }),
            }),
            /invalid private log curation payload/,
            "a stale before snapshot rejects the complete event",
        );
        assert.equal(
            (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: ctx.turnId }))?.n,
            1,
        );
    } finally { await db.close(); }
});

test("{§log-history-projection}: every event receives one projection and inactive is terminal", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-projection-lifecycle");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        assert.deepEqual(
            await db.test_get_log_projection.get({
                session_id: ctx.sessionId,
                loop_seq: 1,
                turn_seq: 1,
                sequence: 1,
            }),
            { id: targetId, active: 1, folded: "[]" },
            "the event and its initial active projection land together",
        );
        await assert.rejects(
            () => db.test_log_entry_projection_delete.run({ id: targetId }),
            /durable log event must retain its projection/,
            "the one-to-one current state cannot be detached from its evidence",
        );
        const plan = (targets: Array<{ id: number; activeBefore: 0 | 1; activeAfter: 0 | 1 }>): { targets: string } =>
            ({ targets: JSON.stringify(targets.map((t) => ({ ...t, foldedBefore: "[]", foldedAfter: "[]" }))) });
        assert.deepEqual(await db.log_apply_projection_plan.all(plan([{ id: targetId, activeBefore: 1, activeAfter: 0 }])), [{ id: targetId }]);
        await assert.rejects(
            () => db.log_apply_projection_plan.all(plan([{ id: targetId, activeBefore: 0, activeAfter: 1 }])),
            /killed log entry cannot re-enter the active projection/,
        );
        // {§log-history-projection} — a plan with one stale precondition lands nothing, including its
        // still-valid targets: the second row here is live, and stays live.
        const liveId = await minimalLog(db, ctx, { sequence: 2 });
        assert.deepEqual(await db.log_apply_projection_plan.all(plan([
            { id: liveId, activeBefore: 1, activeAfter: 0 },
            { id: targetId, activeBefore: 1, activeAfter: 0 },
        ])), [], "one stale target (already retired) withholds the whole plan");
        assert.equal((await db.test_get_log_projection.get<{ active: number }>({ session_id: ctx.sessionId, loop_seq: 1, turn_seq: 1, sequence: 2 }))?.active, 1, "the valid target was not touched");
        assert.deepEqual(await db.log_apply_projection_plan.all(plan([{ id: liveId, activeBefore: 1, activeAfter: 0 }])), [{ id: liveId }], "alone, the valid target lands");
        assert.equal(
            (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: ctx.turnId }))?.n,
            2,
            "projection retirement never deletes its durable event",
        );
    } finally { await db.close(); }
});

test("{§log-history-projection}: curation effects are immutable while their events survive", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-curation-effect-history");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        const operationId = await minimalLog(db, ctx, { sequence: 2, op: "KILL", scheme: "log" });
        await db.test_insert_log_curation_effect.run({
            operation_log_entry_id: operationId,
            target_log_entry_id: targetId,
            active_before: 1,
            active_after: 1,
            folded_before: "[]",
            folded_after: "[]",
        });
        await assert.rejects(
            () => db.test_log_curation_effect_update.run({
                operation_log_entry_id: operationId,
                target_log_entry_id: targetId,
                folded_after: "[]",
            }),
            /log curation effects are immutable execution evidence/,
        );
        await assert.rejects(
            () => db.test_log_curation_effect_delete.run({
                operation_log_entry_id: operationId,
                target_log_entry_id: targetId,
            }),
            /log curation effects can only be removed with their containing history/,
        );
        assert.equal(
            (await db.test_log_curation_effects_by_session.all({ session_id: ctx.sessionId })).length,
            1,
            "rejected mutation leaves the exact effect intact",
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: session_id NOT NULL", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-norun");
        await assert.rejects(
            () => db.test_log_entries_insert_no_session_id.run({ loop_id: ctx.loopId, turn_id: ctx.turnId }),
            /NOT NULL constraint failed: log_entries\.session_id/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: each FK rejection path", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fkpaths");
        await assert.rejects(() => minimalLog(db, ctx, { session_id: 99999 }),  /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { loop_id: 99999 }), /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { turn_id: 99999 }), /FOREIGN KEY constraint failed/);
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: ON DELETE CASCADE via turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-turncasc");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        const operationId = await minimalLog(db, ctx, { sequence: 2, op: "KILL", scheme: "log" });
        await db.test_insert_log_curation_effect.run({
            operation_log_entry_id: operationId,
            target_log_entry_id: targetId,
            active_before: 1,
            active_after: 1,
            folded_before: "[]",
            folded_after: "[]",
        });
        await db.test_log_entries_delete_turns.run({ id: ctx.turnId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
        assert.deepEqual(
            await db.test_log_curation_effects_by_session.all({ session_id: ctx.sessionId }),
            [],
            "containing-history teardown still cascades immutable effects",
        );
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: full CASCADE chain", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fullchain");
        await minimalLog(db, ctx);
        await db.test_workspaces_delete.run({ id: ctx.workspaceId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§turn-source-resources}: the schema admits an emission row only as one born-folded _plurnk announcement of its own turn's admitted ops source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `emission-row-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const content = "```READ (a.md)\n```";
        const emission = async (overrides: Record<string, SqlValue> = {}): Promise<number> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                session_id: sessionId, loop_id: loopId, turn_id: turn.id, sequence: 1,
                origin: "_plurnk", source: null, model_call_id: null, op: "READ", signal: null,
                scheme: "ops", username: null, password: null, hostname: "alice", port: null,
                pathname: `/1/${turn.sequence}`, query: null, fragment: null, lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content, mimetype: "text/vnd.plurnk" }), mimetype_rx: "application/json", status_rx: 200,
                weight: 8, state: "resolved", outcome: null, attrs: JSON.stringify({ kind: "emission" }), initial_folded: "[[1,-1]]",
                ...overrides,
            });
            if (row === undefined) throw new Error("emission insert returned no row");
            return row.id;
        };
        const refused = /an emission row is one born-folded _plurnk announcement of its own turn's admitted ops source/;
        await assert.rejects(() => emission(), refused, "a turn without an admitted ops source announces nothing");
        await Turn.recordSource(db, turn.id, "ops", content);
        const shapes: Array<[Record<string, SqlValue>, string]> = [
            [{ origin: "model" }, "only the harness writes the announcement"],
            [{ op: "FIND" }, "the announcement is a READ"],
            [{ scheme: "reasoning" }, "of the ops source"],
            [{ initial_folded: "[]" }, "born folded: the emission rides outside its record"],
            [{ rx: JSON.stringify({ status: 200, content: "", mimetype: "text/vnd.plurnk" }) }, "an admitted emission is never empty"],
            [{ pathname: `/1/${turn.sequence + 1}` }, "of its own turn"],
            [{ hostname: "bob" }, "a row the session wrote names the session"],
        ];
        for (const [overrides, reason] of shapes) await assert.rejects(() => emission(overrides), refused, reason);
        await minimalLog(db, { sessionId, loopId, turnId: turn.id }, { sequence: 5 });
        await assert.rejects(() => emission({ sequence: 3 }), refused, "written before the turn's operations, so never behind one");
        const id = await emission({ sequence: 6 });
        await assert.rejects(() => emission({ sequence: 7 }), /UNIQUE constraint failed: log_entries\.turn_id/, "one announcement per turn");
        await assert.rejects(() => db.test_log_entries_update_rx.run({ id, rx: JSON.stringify({ status: 200, content: "rewritten", mimetype: "text/vnd.plurnk" }) }), /an emission row is frozen/);
        await assert.rejects(() => db.test_log_entries_update_weight.run({ id, weight: 1 }), /an emission row is frozen/);
        const plan = (foldedAfter: string, activeAfter: 0 | 1) => ({ targets: JSON.stringify([{ id, activeBefore: 1, activeAfter, foldedBefore: "[]", foldedAfter }]) });
        await assert.rejects(() => db.log_apply_projection_plan.all(plan("[[1,1]]", 1)), /an emission row is curated whole/);
        await Turn.complete(db, turn.id, 200);
        const operation = await Turn.open(db, { loopId, producer: "_plurnk", kind: "operation" });
        await Turn.recordSource(db, operation.id, "ops", content);
        await assert.rejects(() => emission({ turn_id: operation.id, pathname: `/1/${operation.sequence}` }), refused, "a programmatic turn does not admit an emission");
        await Turn.complete(db, operation.id, 200);
        const branch = await Fork.fork(db, sessionId, "branch");
        assert.deepEqual(
            (await db.test_emission_rows_by_session.all<{ coordinate: string; hostname: string; pathname: string }>({ session_id: branch }))
                .map(({ coordinate, hostname, pathname }) => ({ coordinate, hostname, pathname })),
            [{ coordinate: `1/${turn.sequence}/6`, hostname: "alice", pathname: `/1/${turn.sequence}` }],
            "a fork's inherited copy keeps naming the session that wrote it",
        );
        assert.deepEqual(await db.log_apply_projection_plan.all(plan("[]", 0)), [{ id }], "a whole KILL retires it");
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: immutability trigger — UPDATE of core fields rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-immut");
        const id = await minimalLog(db, ctx);
        // Lifecycle columns (state/outcome/status_rx/rx) are updateable for
        // the proposal lifecycle, and the curation trigger may remove its
        // private attrs payload; the original action stays pinned forever.
        await assert.rejects(
            () => db.test_log_entries_update_tx.run({ tx: "tampered", id }),
            /log_entries core fields are immutable/,
        );
        const tx = (await db.test_log_entries_get_tx_by_id.get<{ tx: string }>({ id }))?.tx;
        assert.match(tx ?? "", /^````EDIT/);
    } finally { await db.close(); }
});

test("{§log-history-projection}: an individual log event cannot be deleted", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-append-only");
        const id = await minimalLog(db, ctx);
        await assert.rejects(
            () => db.test_log_entries_delete.run({ id }),
            /log entries can only be removed with their containing history/,
        );
        const count = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 1, "the rejected deletion leaves exact evidence intact");
    } finally { await db.close(); }
});

test("{§db-migrations} log_entries: weight negative rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-toksneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { weight: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§log-history-projection} log_entries: query log:///<L>/<T>/<A> address pattern", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-address");
        await minimalLog(db, ctx, { sequence: 1 });
        await minimalLog(db, ctx, { sequence: 2, op: "SEND" });
        const row = await db.test_log_entries_address_join.get<{ op: string; loop_seq: number; turn_seq: number; sequence: number }>({ loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(row?.op, "SEND");
        assert.equal(row?.loop_seq, 1);
        assert.equal(row?.turn_seq, 1);
        assert.equal(row?.sequence, 2);
    } finally { await db.close(); }
});
});


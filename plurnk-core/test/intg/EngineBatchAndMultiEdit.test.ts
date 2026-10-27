import test, { describe, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import SessionName from "../../src/core/SessionName.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { serverProposals } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, seedEnvelope, insertWorkspace, insertSession, insertLoop, seedEntryWithChannel, rootWorkspace } from "./_db.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { type AnchoredReadResult } from "../../src/content/read-projector.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { hermeticGitEnv } from "../../src/core/git-env.ts";


describe("Engine.contextual-anchors", () => {
const statements = (program: string) => PlurnkParser.parse(program).items.map((item) => {
    assert.equal(item.kind, "statement", program);
    if (item.kind !== "statement") throw new Error("Expected an operation");
    return item.statement;
});

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const env = await seedEnvelope(db, `context-anchors-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    let sequence = 0;
    const run = (program: string) => {
        const ops = statements(program);
        assert.equal(ops.length, 1);
        return engine.dispatch({ ...env, statement: ops[0], sequence: ++sequence, origin: "model" });
    };
    const batch = (program: string) => {
        const ops = statements(program);
        const fromSequence = sequence + 1;
        sequence += ops.length;
        return engine.executeAdmittedTurn({ ...env, statements: ops, source: null, emission: null, fromSequence, origin: "model" });
    };
    const read = async (path: string, scope = "1,-1") =>
        Results.assertReadResult(await run(`\`\`\`READ (${path}) <${scope}>\n\`\`\``)) as AnchoredReadResult;
    const write = (path: string, body: string, scope = "") => run(`\`\`\`EDIT (${path}) ${scope}\n${body}\n\`\`\``);
    return { run, batch, read, write };
};

const repeated = (body: string) => {
    const block = (label: string) => [label, "before-2", "before-1", body, "after-1", "after-2", `end-${label}`];
    return [
        ...Array.from({ length: 10 }, (_, i) => `head-${i}`),
        ...block("a"), ...block("b"),
        ...Array.from({ length: 10 }, (_, i) => `tail-${i}`),
    ];
};

for (const op of ["EDIT", "KILL", "COPY", "MOVE"] as const) {
    test(`{§line-anchors}: ${op} uses contextual READ handles after a separate operation shifts the resource`, async (t) => {
        const { run, read, write } = await runtime(t);
        const source = "workspace:///source.md";
        const destination = "workspace:///destination.md";
        const sourceLines = repeated("source-target");
        const destinationLines = repeated("destination-target");
        const selected = sourceLines.indexOf("source-target");
        const other = sourceLines.lastIndexOf("source-target");
        assert.equal((await write(source, sourceLines.join("\n"))).status, 201);
        assert.equal((await write(destination, destinationLines.join("\n"))).status, 201);
        const full = await read(source);
        assert.notEqual(full.lineAnchors![selected], full.lineAnchors![other]);
        const slice = await read(source, String(selected + 1));
        assert.equal(slice.content, "source-target");
        const anchor = slice.lineAnchors![0];
        assert.equal(anchor, full.lineAnchors![selected], "scope does not discard the distinguishing context");
        const destinationAnchor = (await read(destination, String(other + 1))).lineAnchors![0];

        assert.equal((await write(source, "prefix\nhead-0", "<1>")).status, 200);
        assert.equal((await write(destination, "prefix\nhead-0", "<1>")).status, 200);
        assert.equal((await read(source, anchor)).content, "source-target");
        const program = op === "EDIT"
            ? `\`\`\`EDIT (${source}) <${anchor}>\nchanged\n\`\`\``
            : op === "KILL"
                ? `\`\`\`KILL (${source}) <${anchor}>\n\`\`\``
                : `\`\`\`${op} (${source}) <${anchor}> (${destination}) <${destinationAnchor}>\n\`\`\``;
        const result = await run(program);
        assert.equal(result.status, 200, JSON.stringify(result));

        const expectedSource = ["prefix", ...sourceLines];
        const expectedDestination = ["prefix", ...destinationLines];
        if (op === "EDIT") expectedSource[selected + 1] = "changed";
        if (op === "KILL" || op === "MOVE") expectedSource.splice(selected + 1, 1);
        if (op === "COPY" || op === "MOVE") expectedDestination[other + 1] = "source-target";
        assert.equal((await read(source)).content, expectedSource.join("\n"), "only the selected copy is changed or removed");
        assert.equal((await read(destination)).content, expectedDestination.join("\n"), "the destination independently resolves its contextual anchor");
    });
}

test("{§line-anchors}: changed extended context refuses EDIT without changing either twin", async (t) => {
    const { read, write, run } = await runtime(t);
    const path = "workspace:///stale.md";
    const lines = repeated("target");
    const target = lines.indexOf("target");
    assert.equal((await write(path, lines.join("\n"))).status, 201);
    const anchor = (await read(path, String(target + 1))).lineAnchors![0];
    assert.equal((await write(path, "changed section", `<${target - 2}>`)).status, 200);
    const changed = lines.with(target - 3, "changed section").join("\n");
    const refused = await run(`\`\`\`EDIT (${path}) <${anchor}>\nwrong\n\`\`\``);
    assert.equal(refused.status, 409);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
    assert.equal(refused.problem?.retryable, false);
    assert.equal((await read(path)).content, changed);
    const current = (await read(path, String(target + 1))).lineAnchors![0];
    assert.notEqual(current, anchor);
    assert.equal((await run(`\`\`\`EDIT (${path}) <${current}>\ncorrect\n\`\`\``)).status, 200);
    assert.equal((await read(path)).content, lines.with(target - 3, "changed section").with(target, "correct").join("\n"));
});

test("{§op-methods-op-dispatch}: introducing a twin in one program retains the original binding through real EDIT dispatch", async (t) => {
    const { read, write, batch } = await runtime(t);
    const path = "workspace:///continuity.md";
    assert.equal((await write(path, "one\ntwo\nthree\nfour\nfive\nsix")).status, 201);
    const anchor = (await read(path, "3")).lineAnchors![0];
    const result = await batch(`\`\`\`EDIT (${path}) <6>
six
one
two
three
four
five
\`\`\`

\`\`\`EDIT (${path}) <${anchor}>
THREE
\`\`\``);
    assert.deepEqual(result.outcomes.map(({ status }) => status), [200, 200]);
    assert.equal((await read(path)).content, "one\ntwo\nTHREE\nfour\nfive\nsix\none\ntwo\nthree\nfour\nfive");
});
});

describe("Engine.edit-batch-merges", () => {
// {§op-methods-op-dispatch} {§op-methods-op-dispatch}: independent EDIT effects and verified prefix normalization.











const execFileP = promisify(execFile);
const SOURCE = "var x int\n\nfunc requireFn(a int) int {\n\treturn a\n}\n\nfunc other() {}\n";

const seeded = async (root: string): Promise<void> => {
    const env = hermeticGitEnv();
    await execFileP("git", ["init", "-q"], { cwd: root, env });
    await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
    await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
    await writeFile(join(root, "f.go"), SOURCE);
    await execFileP("git", ["add", "f.go"], { cwd: root, env });
    await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
};

type Row = { op: string; origin: string; status_rx: number; rx: string };
const editRows = (rows: Row[]): Array<{ status: number; rx: Record<string, unknown> }> =>
    rows.filter(({ op }) => op === "EDIT").map(({ status_rx, rx }) => ({ status: status_rx, rx: JSON.parse(rx) }));

test("{§op-methods-op-dispatch} separate numeric EDITs never negotiate a shared endpoint", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <2,3>\nfunc resolve() string {\n\treturn \"\"\n}\n\n````\n\n````EDIT (f.go) <3,5>\nfunc requireFn(a int) int {\n\treturn a + 1\n}\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "merge", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.equal(edits[0].rx.merged, undefined, "the requested region is not silently shrunk");
                assert.equal(edits[1].rx.merged, undefined, "the claiming row is an ordinary applied edit");
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\nfunc resolve() string {\nfunc requireFn(a int) int {\n\treturn a + 1\n}\n}\n\nfunc other() {}\n", "numeric coordinates name the current content, without reinterpretation");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a READ rendering pasted back as a body is stripped only when its anchors verify; a look-alike is written as authored", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const pending: { body: string | null; fake: string | null } = { body: null, fake: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (f.go) <1,-1>````\n````NOTE\nreading\n````", 50),
            makeMockResponse("````SEND [200]\nread\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`\`\`\`\`EDIT (f.go) <1,2>
${pending.body}
\`\`\`\`

\`\`\`\`EDIT (f.go) <7>
${pending.fake}
\`\`\`\`

\`\`\`\`NOTE
editing
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````SEND [200]\nedited\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "paste", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<Row>({ session_id: first.modelSessionId! })).find(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                const anchors = JSON.parse(readRow!.rx).lineAnchors as string[];
                assert.equal(anchors.length, 7);
                // Lines 1-2 pasted back exactly as rendered (right-aligned ordinal, the anchor as the delimiter, text);
                // line 7's "prefix" carries a hash that is not this resource's anchor.
                pending.body = `1<${anchors[0]}>var x int\n2<${anchors[1]}>`;
                pending.fake = "7<@zzzzz>func other() { /* kept */ }";
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit" });
                assert.equal(second.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: second.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [304, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.deepEqual(edits[0].rx.merged, [{ rule: "rendered-prefix-stripped", lines: 2, source: "current" }]);
                assert.deepEqual(edits[1].rx.merged, [{ rule: "rendered-prefix-unverified", lines: 1 }]);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\n\nfunc requireFn(a int) int {\n\treturn a\n}\n\n7<@zzzzz>func other() { /* kept */ }\n", "verified prefixes stripped; the look-alike written verbatim");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a paste from an older READ still verifies, against the anchors that READ published", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const pending: { body: string | null } = { body: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (f.go) <1,-1>````\n````NOTE\nreading\n````", 50),
            makeMockResponse("````SEND [200]\nread\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`\`\`\`\`EDIT (f.go) <1,2>
${pending.body}
\`\`\`\`

\`\`\`\`NOTE
editing
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````SEND [200]\nedited\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "stale-paste", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<Row>({ session_id: first.modelSessionId! })).find(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                const anchors = JSON.parse(readRow!.rx).lineAnchors as string[];
                // Line 4 changes out-of-band after the READ: line 2's neighbourhood now differs, so the
                // pasted prefixes no longer verify against the current anchors - only against the READ's.
                await writeFile(join(root, "f.go"), SOURCE.replace("\treturn a\n", "\treturn a // changed\n"));
                pending.body = `1<${anchors[0]}>var x int64\n2<${anchors[1]}>`;
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit" });
                assert.equal(second.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: second.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.deepEqual(edits[0].rx.merged, [{ rule: "rendered-prefix-stripped", lines: 2, source: "log" }]);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int64\n\nfunc requireFn(a int) int {\n\treturn a // changed\n}\n\nfunc other() {}\n", "stripped by the READ's own anchors; lines 1-2 replaced as rendered");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} an identical subsequent EDIT reports its own ordinary no-change result", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <1>\nvar x int64\n````\n\n````EDIT (f.go) <1>\nvar x int64\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "twin", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 304]);
                assert.ok(edits[0].rx.receipt !== undefined, "the first row carries the effect");
                assert.equal(edits[1].rx.merged, undefined);
                assert.equal(edits[1].rx.receipt, undefined, "the twin applied nothing and claims no effect");
                assert.match(await readFile(join(root, "f.go"), "utf8"), /^var x int64\n\nfunc requireFn/);
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a numeric EDIT can modify content introduced by an earlier EDIT", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        // The outer rewrites requireFn but keeps its return line verbatim; the inner edits that line.
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <3,5>\nfunc requireFn(a int, debug bool) int {\n\treturn a\n}\n````\n\n````EDIT (f.go) <4>\n\treturn a * 2\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "relocate", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.equal(edits[1].rx.merged, undefined);
                assert.ok(edits[1].rx.receipt !== undefined, "the later EDIT owns its own effect");
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\n\nfunc requireFn(a int, debug bool) int {\n\treturn a * 2\n}\n\nfunc other() {}\n", "the inner change landed inside the rewritten function");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§op-methods-op-dispatch} a shortened region does not secretly relocate a later numeric EDIT", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````EDIT (f.go) <3,5>\nfunc requireFn(a int) int { return a }\n````\n\n````EDIT (f.go) <4>\n\treturn a * 2\n````\n\n````NOTE\nediting\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "contain", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit" });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ session_id: result.modelSessionId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200]);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\n\nfunc requireFn(a int) int { return a }\n\treturn a * 2\nfunc other() {}\n", "the second EDIT names current line 4, not a former line inside the rewritten region");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});
});

describe("Engine.manifest", () => {
// SPEC {§packet} — the FIND-served catalog is the complete, unranked directory
// for one addressed owner. A real turn updates its search projection; this test
// reads the same catalog surface and asserts every selected entry is listed.











const indexingTurn = {
    assistant: {
        content: "\n````SEND\ndone\n````",
        reasoning: null,
    },
};

test("{§packet} the commons catalog is complete and unranked — every selected entry, no `shown`, never itself", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        // Two commons-owned entries the directory must enumerate.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/france/capital", channel: "body", content: "Paris", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/germany/capital", channel: "body", content: "Berlin\nis the capital", mimetype: "text/markdown" });

        // A real turn maintains the search index; the catalog is the
        // read-only render FIND serves — there is no manifest.json entry.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const paths = catalog.map(([channel]) => channel.path);

        // Completeness: every seeded entry is listed.
        assert.ok(paths.includes("workspace:///france/capital"), `catalog lists france; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("workspace:///germany/capital"), `catalog lists germany; got ${JSON.stringify(paths)}`);
        // It does not list itself.
        assert.ok(!paths.includes("workspace:///manifest.json"), "catalog has no synthetic manifest entry");
        // Unranked directory: NO `shown` (or any visibility/relevance) field anywhere.
        for (const [channel] of catalog) assert.equal("shown" in channel, false, `no \`shown\` field — the directory is unranked (offender: ${channel.path})`);

        // Shape: a non-empty, default-first array of channel metadata; exceptional
        // parser evidence is independently covered below.
        const germany = catalog.find(([channel]) => channel.path === "workspace:///germany/capital");
        assert.ok(germany !== undefined, "germany entry present");
        assert.equal(germany.length, 1);
        const [gbody] = germany;
        assert.equal(gbody.path, "workspace:///germany/capital", "the default channel carries the bare resource URI");
        assert.equal(gbody.mimetype, "text/markdown");
        assert.equal(gbody.weight, Math.ceil("Berlin\nis the capital".length / 2), "weight is the stored curation depth, never re-counted from a body");
        assert.equal(gbody.lines, 2, "lines is the stored extent: a trailing newline would terminate the last line");
    } finally { await db.close(); }
});

test("{§packet} catalog projection selects by literal authority, or the whole workspace when omitted", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-owner-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/shared.md",
            content: "commons",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            authority: await SessionName.forId(db, sessionId),
            scheme: "session",
            pathname: "/private.md",
            content: "session",
        });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx)).map(([channel]) => channel.path),
            ["workspace:///shared.md", "session://alice/private.md"],
            "an omitted authority includes every workspace namespace",
        );
        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx, undefined, "alice")).map(([channel]) => channel.path),
            ["session://alice/private.md"],
            "an explicit authority selects that literal namespace",
        );
        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx, "workspace", "")).map(([channel]) => channel.path),
            ["workspace:///shared.md"],
            "an empty authority is the commons, not an omitted filter",
        );
        assert.deepEqual(await EntryManifest.catalogRowsFor(ctx, "https", "alice"), [],
            "scheme and authority filters intersect");
    } finally { await db.close(); }
});

test("{§packet} manifest build survives a malformed application/json entry — degrades to a line count, never crashes the turn (-32603)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-badjson-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        // A valid JSON entry plus one whose body is malformed — the kind of imperfect
        // JSON a small model writes. buildManifestBody calls mimetypes.process() per
        // entry for its line count, and process() validates application/json and THROWS
        // SyntaxError on a parse error. Uncaught, that crashed the whole manifest build
        // (and the turn → daemon -32603). One bad entry must not take down everything.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/good.json", channel: "body", content: '{"ok":true}', mimetype: "application/json" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/bad.json", channel: "body", content: '{\n  "a": 1\n  "b": 2\n}', mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        // The turn's pump survived the malformed entry (no -32603); the catalog renders it degraded.
        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const paths = catalog.map(([channel]) => channel.path);
        assert.ok(paths.includes("workspace:///good.json"), `valid entry listed; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("workspace:///bad.json"), "malformed entry still listed (degraded, not crashed)");
        const bad = catalog.find(([channel]) => channel.path === "workspace:///bad.json");
        assert.ok(bad !== undefined && bad[0].lines >= 1, "malformed entry degraded to a line count");
    } finally { await db.close(); }
});

test("{§network-address} catalog quietly marks parser recovery without disabling the derivation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-parse-issues-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");
        const brokenId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/broken.ts",
            channel: "body",
            content: "const x = ;",
            mimetype: "text/typescript",
        });
        await db.test_seed_channel.run({
            entry_id: brokenId,
            name: "notes",
            content: "auxiliary channel",
            mimetype: "text/plain",
            state: "static",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/clean.ts",
            channel: "body",
            content: "const x = 1;",
            mimetype: "text/typescript",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const broken = catalog.find(([channel]) => channel.path === "workspace:///broken.ts");
        const clean = catalog.find(([channel]) => channel.path === "workspace:///clean.ts");
        assert.equal(broken?.[0].parseIssues, 1);
        const notes = broken?.find((channel) => channel.path === "workspace:///broken.ts#notes");
        assert.equal(notes !== undefined && "parseIssues" in notes, false, "one channel's parser issues never label a sibling channel");
        assert.equal(clean !== undefined && "parseIssues" in clean[0], false, "clean source carries no success badge");

        const derivation = await db.test_derivation_disposition.get<{ disposition: string }>({ entry_id: brokenId });
        assert.notEqual(derivation?.disposition, "failed", "advisory parser recovery leaves indexing available");
    } finally { await db.close(); }
});

test("{§find} catalog projects a bounded aside on only its exact markdown channel", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-summary-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");
        const long = "x".repeat(300);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/tool.md",
            channel: "body",
            content: `# Tool\n\n## Summary\n\n${long}\n\n## Example\n\nDetails.`,
            mimetype: "text/markdown",
        });
        await db.test_seed_channel.run({
            entry_id: entryId,
            name: "notes",
            content: "No summary here.",
            mimetype: "text/markdown",
            state: "static",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const tool = catalog.find(([channel]) => channel.path === "workspace:///tool.md");
        assert.equal(Array.from(tool![0].aside!).length, 256);
        assert.equal(tool![0].aside, `${"x".repeat(255)}…`);
        assert.equal("aside" in tool![1], false, "one channel's aside never labels a sibling channel");
    } finally { await db.close(); }
});

test("{§channel-selection} catalog names a projected channel and its differently typed source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-source-mimetype-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "file",
            pathname: "/picture.png",
            content: "PNG image, 640×640 px, 37022 bytes",
            mimetype: "text/markdown",
        });
        await db.test_set_entry_attributes.run({
            entry_id: entryId,
            attributes: JSON.stringify({ sourceProjection: { mimetype: "image/png" } }),
        });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const picture = catalog.find(([channel]) => channel.path.endsWith("picture.png"));
        assert.ok(picture !== undefined, `picture is cataloged; got ${JSON.stringify(catalog)}`);
        assert.equal(picture[0].mimetype, "text/markdown");
        assert.equal(picture[0].sourceMimetype, "image/png");
    } finally { await db.close(); }
});

test("{§persistent-search-index} a large JSON entry is indexed and cataloged before inference", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-json-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        const big = JSON.stringify(Object.fromEntries(
            Array.from({ length: 80 }, (_, i) => [`key_${i}`, `value number ${i} with several descriptive words here`]),
        ), null, 2);
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/big.json", channel: "body", content: big, mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.ok(catalog.some(([channel]) => channel.path === "workspace:///big.json"), "the large JSON entry is listed in the catalog");
    } finally { await db.close(); }
});

test("{§session-loop-lifecycle} catalog distinguishes active, closed, killed, failed, and static entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-stream-state-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");

        await seedEntryWithChannel(db, { workspaceId, authority: await SessionName.forId(db, sessionId), scheme: "session", pathname: "/static/note", channel: "body", content: "x", mimetype: "text/markdown" });
        const seedStream = async (pathname: string, result?: ReturnType<typeof Results.failure> | { status: number }): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "sh",
                pathname,
                channel: "stdout",
                content: result === undefined ? "running..." : "",
                mimetype: "text/stream",
            });
            const subscriptionId = await ChannelWrite.openSubscription(db, {
                sessionId,
                entryId,
                scheme: "sh",
                handle: `sh: ${pathname}`,
            });
            if (result !== undefined) await ChannelWrite.closeSubscription(db, { subscriptionId, result });
        };
        await seedStream("/1/1/1/sh");
        await seedStream("/1/1/2/sh", { status: 200 });
        await seedStream("/1/1/3/sh", Results.failure("executor:sh", "killed", 499, "killed"));
        await seedStream("/1/1/4/sh", Results.failure("executor:sh", "failed", 503, "failed"));

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({
            db,
            workspaceId,
            defaultChannelFor: (scheme) => scheme === "sh" ? "stdout" : "body",
        }));
        const active = catalog.find(([channel]) => channel.path === "sh:///1/1/1/sh");
        const closed = catalog.find(([channel]) => channel.path === "sh:///1/1/2/sh");
        const killed = catalog.find(([channel]) => channel.path === "sh:///1/1/3/sh");
        const failed = catalog.find(([channel]) => channel.path === "sh:///1/1/4/sh");
        const stat = catalog.find(([channel]) => channel.path === "session://alice/static/note");
        assert.ok(active !== undefined && closed !== undefined && killed !== undefined && failed !== undefined && stat !== undefined);
        assert.equal(active[0].stream?.state, "active");
        assert.equal(typeof (active[0].stream?.state === "active" ? active[0].stream.seconds : undefined), "number");
        assert.deepEqual(closed[0].stream, { state: "closed", status: 200 });
        assert.deepEqual(killed[0].stream, { state: "killed", status: 499 });
        assert.deepEqual(failed[0].stream, { state: "failed", status: 503 });
        assert.equal(stat[0].stream, undefined, "an entry with no subscription is not presented as a stream");
    } finally { await db.close(); }
});

test("{§packet} [note4] manifest groups addressable channels default-first — default bare, non-default #fragment", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `note4-${crypto.randomUUID()}`);
        await insertSession(db, workspaceId);
        // A multi-channel exec stream entry at sh:///1/1/2/sh (stdout is the default channel, + stderr).
        const id = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/2/sh", channel: "stdout", content: "out", mimetype: "text/stream" });
        await db.test_seed_channel.run({ entry_id: id, name: "stderr", content: "err", mimetype: "text/stream", state: "static" });
        await db.test_seed_channel.run({ entry_id: id, name: "preview(\\", content: "detail", mimetype: "text/stream", state: "static" });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "https",
            authority: "example.test",
            pathname: "/x?literal=)&encoded=%29",
            channel: "body",
            content: "network",
            mimetype: "text/plain",
        });
        // sh's default channel is stdout (the Exec handler) — resolve it so stdout is [0], stderr a #fragment.
        const ctx = makeSchemeCtx({ db, workspaceId, defaultChannelFor: (s) => (s === "sh" ? "stdout" : "body") });
        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const stream = catalog.find(([channel]) => channel.path === "sh:///1/1/2/sh");
        assert.ok(stream, "exec stream listed");
        assert.deepEqual(
            stream.map((channel) => channel.path),
            ["sh:///1/1/2/sh", "sh:///1/1/2/sh#preview\\(\\\\", "sh:///1/1/2/sh#stderr"],
            "the default is first and bare; non-default channels use target-slot spelling",
        );
        assert.ok(
            catalog.some(([channel]) => channel.path === "https://example.test/x?literal=\\)&encoded=%29"),
            "network catalog paths preserve literal and percent-encoded query identity",
        );
    } finally { await db.close(); }
});
});

describe("Engine.multi-edit", () => {
// {§op-methods-op-dispatch} {§op-methods-op-dispatch} {§op-methods-op-dispatch} {§line-anchors} {§op-methods-op-dispatch} — the
// multi-EDIT matrix through the model path on project files. Every coherent program lands exactly where its
// anchors were published, whatever its order and whatever its own earlier splices did to ordinals and
// neighbourhoods; the only refusals are attempts no runtime could resolve deterministically (a line this
// program already replaced or deleted, a never-issued or foreign anchor), each refused without touching
// its siblings. Across programs the receipts' anchors are current and the packet's old ones are stale.



beforeEach((t) => serverProposals(t as TestContext, "accept"));












const execFileP = promisify(execFile);

const DEBUG = "django/views/debug.py";
const HELPERS = "django/views/helpers.py";
const DEBUG_LINES = [
    "import functools", "import re", "import sys", "import types", "from pathlib import Path", "",
    "from django.conf import settings",
    "from django.http import HttpResponse, HttpResponseNotFound",
    "from django.template import Context, Engine, TemplateDoesNotExist",
    "from django.template.defaultfilters import pprint",
    "from django.urls import Resolver404, resolve",
    "from django.utils import timezone",
    "from django.utils.datastructures import MultiValueDict",
    "from django.utils.encoding import force_str",
    "from django.utils.module_loading import import_string",
    "from django.utils.version import get_docs_version",
    "", "",
    "def technical_404_response(request, exception):",
    "    caller = ''",
    "    try:",
    "        resolver_match = resolve(request.path)",
    "    except Resolver404:",
    "        pass",
    "    else:",
    "        obj = resolver_match.func",
    "",
    "        if hasattr(obj, '__name__'):",
    "            caller = obj.__name__",
];
const HELPERS_LINES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const HTTP_IMPORT = "from django.http import Http404, HttpResponse, HttpResponseNotFound";
const URLS_IMPORT = "from django.urls import resolve";
const EXCEPT_404 = "    except Http404:";

type Unresolved = { anchor: string; kind: "missing" | "ambiguous"; lines?: number[] };
type EditRow = { status: number; landed: string | null; unresolved: Unresolved[] | null; context: string[] | null };
type Ctx = { root: string; db: Awaited<ReturnType<typeof openMigrated>>; engine: Engine; workspaceId: number; sessionId: number };
type Anchors = (line: number) => string;

const withProject = async <T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-multi-edit-"));
    const db = await openMigrated();
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        for (const [file, lines] of [[DEBUG, DEBUG_LINES], [HELPERS, HELPERS_LINES]] as const) {
            await mkdir(dirname(join(root, file)), { recursive: true });
            await writeFile(join(root, file), `${lines.join("\n")}\n`);
        }
        await execFileP("git", ["add", "."], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `multi-edit-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        return await fn({ root, db, engine, workspaceId, sessionId });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

const edit = (file: string, scope: string, body: string | null): string => PlurnkParser.frame(`EDIT (${file}) <${scope}>`, body ?? "");

// The anchors the model's latest READ of each file published, indexed by one-based line: the packet is the
// only place a model learns an anchor, so the program takes them from there and nowhere else.
const anchorsFromLog = async ({ db, sessionId }: Ctx): Promise<[Anchors, Anchors]> => {
    const rows = await db.engine_render_log.all<{ op: string | null; origin: string; status_rx: number; pathname: string | null; rx: string }>({ session_id: sessionId });
    const latest = (file: string): Anchors => {
        const row = rows.findLast(({ op, origin, status_rx, pathname }) => op === "READ" && origin === "model" && status_rx === 200 && (pathname === file || pathname === `/${file}`));
        assert.ok(row, `the model READ ${file}`);
        const anchors = (JSON.parse(row.rx) as { lineAnchors?: string[] }).lineAnchors;
        assert.ok(Array.isArray(anchors) && anchors.length > 0, `the READ of ${file} published one anchor per line`);
        return (line: number) => {
            const anchor = anchors[line - 1];
            if (anchor === undefined) throw new Error(`no anchor for line ${line} of ${file}`);
            return anchor;
        };
    };
    return [latest(DEBUG), latest(HELPERS)];
};

// One loop of the same session under an accepting proposal policy: the model READs both files, then
// emits `frames` built from the anchors that READ published, then concludes.
const program = async (ctx: Ctx, sequence: number, frames: (a: Anchors, b: Anchors) => string[]): Promise<{ edits: EditRow[]; published: [Anchors, Anchors] }> => {
    const { db, engine, workspaceId, sessionId } = ctx;
    const loopId = await insertLoop(db, sessionId, sequence, "Apply the fix.");
    const reads = [DEBUG, HELPERS].map((file) => PlurnkParser.frame(`READ (${file}) <1,-1>`, null)).join("\n\n");
    const respond = async (content: string, args: Parameters<Mock["generate"]>[0]) =>
        await new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }).generate(args);
    let calls = 0;
    let published: [Anchors, Anchors] | null = null;
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    provider.generate = async (args) => {
        calls += 1;
        if (calls === 1) return await respond(reads, args);
        if (calls === 2) {
            published = await anchorsFromLog(ctx);
            return await respond(frames(...published).join("\n\n"), args);
        }
        return await respond(PlurnkParser.frame("SEND [200]", "Done."), args);
    };
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 6, maxStrikes: 3, messages: [{ role: "user", content: "Apply the fix." }] });
    assert.equal(result.result.status, 200, JSON.stringify(result.result).slice(0, 300));
    assert.ok(published, "the program ran");
    const rows = (await Promise.all(result.turnIds.map((id) => db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: id })))).flat();
    const edits = rows.filter(({ op, origin }) => op === "EDIT" && origin === "model").map(({ status_rx, rx }) => {
        const parsed = JSON.parse(rx) as { receipt?: { effect?: { result?: string; context?: string } }; problem?: { unresolvedAnchors?: Unresolved[] } };
        return {
            status: status_rx,
            landed: parsed.receipt?.effect?.result ?? null,
            unresolved: parsed.problem?.unresolvedAnchors ?? null,
            context: parsed.receipt?.effect?.context?.split("\n") ?? null,
        };
    });
    return { edits, published };
};

const fileLines = async ({ root }: Ctx, file: string): Promise<string[]> => (await readFile(join(root, file), "utf8")).replace(/\n$/u, "").split("\n");
const expectLines = (lines: readonly string[], mutate: (draft: string[]) => void): string[] => { const draft = [...lines]; mutate(draft); return draft; };
const set = (draft: string[], line: number, ...body: string[]): void => { draft.splice(line - 1, 1, ...body); };
const setRange = (draft: string[], from: number, to: number, ...body: string[]): void => { draft.splice(from - 1, to - from + 1, ...body); };

type Case = {
    name: string;
    frames: (a: Anchors, b: Anchors) => string[];
    outcomes: Array<[status: number, landed: string | null | undefined]>;
    debug?: (draft: string[]) => void;
    helpers?: (draft: string[]) => void;
    unresolved?: (a: Anchors, b: Anchors) => Array<Unresolved[] | null>;
};

// Every program below is one model turn on the seeded file. `landed` is the receipt's effect; `undefined`
// leaves it unchecked (a deletion's receipt names no result region).
const COHERENT: Case[] = [
    {
        name: "far apart: the rollout's fix with the anchors of the lines it meant",
        frames: (a) => [edit(DEBUG, a(8), HTTP_IMPORT), edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<8>"], [200, "<11>"], [200, "<23>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); set(d, 11, URLS_IMPORT); set(d, 23, EXCEPT_404); },
    },
    {
        name: "adjacent lines, ascending: the second anchor survives the first edit to its neighbour",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(12), "from django.utils import timezone  # kept")],
        outcomes: [[200, "<11>"], [200, "<12>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); },
    },
    {
        name: "adjacent lines, descending",
        frames: (a) => [edit(DEBUG, a(12), "from django.utils import timezone  # kept"), edit(DEBUG, a(11), URLS_IMPORT)],
        outcomes: [[200, "<12>"], [200, "<11>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); },
    },
    {
        name: "own insertion above, then a hash below: the anchor follows its line down",
        frames: (a) => [edit(DEBUG, a(7), "from django.conf import settings\nfrom django.core.exceptions import ImproperlyConfigured"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7,8>"], [200, "<24>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); set(d, 7, "from django.conf import settings", "from django.core.exceptions import ImproperlyConfigured"); },
    },
    {
        name: "own shrink above (two lines into one), then a hash below: the anchor follows its line up",
        frames: (a) => [edit(DEBUG, `${a(7)},${a(8)}`, "from django.conf import settings  # merged"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7>"], [200, "<22>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); setRange(d, 7, 8, "from django.conf import settings  # merged"); },
    },
    {
        name: "own deletion above, then a hash below",
        frames: (a) => [edit(DEBUG, a(6), null), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, undefined], [200, "<22>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); setRange(d, 6, 6); },
    },
    {
        name: "an enclosing range after an inner edit: both endpoints survive, the range rewrites the current lines",
        frames: (a) => [edit(DEBUG, a(22), "        resolver_match = resolve(request.path_info)"), edit(DEBUG, `${a(21)},${a(23)}`, "    try:\n        match = resolve(request.path)\n    except Http404:")],
        outcomes: [[200, "<22>"], [200, "<21,23>"]],
        debug: (d) => { setRange(d, 21, 23, "    try:", "        match = resolve(request.path)", "    except Http404:"); },
    },
    {
        name: "numeric insertion above, then a hash below: continuity is about splices, not about how they were addressed",
        frames: (a) => [edit(DEBUG, "7", "from django.conf import settings\nimport logging"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7,8>"], [200, "<24>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); set(d, 7, "from django.conf import settings", "import logging"); },
    },
    {
        name: "hash insertion above, then a numeric scope below: numbers address current coordinates ({§op-methods-op-dispatch})",
        frames: (a) => [edit(DEBUG, a(7), "from django.conf import settings\nimport logging"), edit(DEBUG, "23", "        resolver_match = resolve(request.path_info)")],
        outcomes: [[200, "<7,8>"], [200, "<23>"]],
        debug: (d) => { set(d, 22, "        resolver_match = resolve(request.path_info)"); set(d, 7, "from django.conf import settings", "import logging"); },
    },
    {
        name: "an offset anchor whose base line's neighbour was edited earlier: the base carries, the offset applies ({§op-methods-op-dispatch})",
        frames: (a) => [edit(DEBUG, a(21), "    try:  # guarded"), edit(DEBUG, `${a(22)}+1`, EXCEPT_404)],
        outcomes: [[200, "<21>"], [200, "<23>"]],
        debug: (d) => { set(d, 21, "    try:  # guarded"); set(d, 23, EXCEPT_404); },
    },
    {
        name: "two files in one program, each by its own anchors",
        frames: (a, b) => [edit(DEBUG, a(11), URLS_IMPORT), edit(HELPERS, b(3), "GAMMA")],
        outcomes: [[200, "<11>"], [200, "<3>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); },
        helpers: (d) => { set(d, 3, "GAMMA"); },
    },
    {
        name: "a failing middle EDIT leaves both neighbours applied and names only its own anchor",
        frames: (a) => [edit(DEBUG, a(8), HTTP_IMPORT), edit(DEBUG, "@451ok", "nope"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<8>"], [409, null], [200, "<23>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); set(d, 23, EXCEPT_404); },
        unresolved: () => [null, [{ anchor: "@451ok", kind: "missing" }], null],
    },
    {
        name: "the same line twice: the second edit addresses it by current coordinate",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, "11", `${URLS_IMPORT}  # confirmed`)],
        outcomes: [[200, "<11>"], [200, "<11>"]],
        debug: (d) => { set(d, 11, `${URLS_IMPORT}  # confirmed`); },
    },
    {
        name: "a twin neighbourhood created by this program does not detach the original line's anchor",
        frames: (a) => [
            edit(DEBUG, "29", [DEBUG_LINES[28], ...DEBUG_LINES.slice(19, 24)].join("\n")),
            edit(DEBUG, a(22), "        resolver_match = resolve(request.path_info)"),
        ],
        outcomes: [[200, "<29,34>"], [200, "<22>"]],
        debug: (d) => { set(d, 22, "        resolver_match = resolve(request.path_info)"); set(d, 29, DEBUG_LINES[28], ...DEBUG_LINES.slice(19, 24)); },
    },
];

const REFUSED: Case[] = [
    {
        name: "the old anchor of a line this program already replaced",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(11), "from django.urls import resolve, reverse")],
        outcomes: [[200, "<11>"], [409, null]],
        debug: (d) => { set(d, 11, URLS_IMPORT); },
        unresolved: (a) => [null, [{ anchor: a(11), kind: "missing" }]],
    },
    {
        name: "the old anchor of a line this program already deleted",
        frames: (a) => [edit(DEBUG, a(12), null), edit(DEBUG, a(12), "from django.utils import timezone")],
        outcomes: [[200, undefined], [409, null]],
        debug: (d) => { setRange(d, 12, 12); },
        unresolved: (a) => [null, [{ anchor: a(12), kind: "missing" }]],
    },
    {
        name: "a range whose one endpoint this program already replaced names that endpoint alone",
        frames: (a) => [edit(DEBUG, a(23), EXCEPT_404), edit(DEBUG, `${a(21)},${a(23)}`, "    try:\n        match = resolve(request.path)\n    except Http404:")],
        outcomes: [[200, "<23>"], [409, null]],
        debug: (d) => { set(d, 23, EXCEPT_404); },
        unresolved: (a) => [null, [{ anchor: a(23), kind: "missing" }]],
    },
    {
        name: "another file's anchor is foreign here; the sibling after it still applies",
        frames: (a, b) => [edit(DEBUG, b(3), "GAMMA"), edit(DEBUG, a(8), HTTP_IMPORT)],
        outcomes: [[409, null], [200, "<8>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); },
        unresolved: (_a, b) => [[{ anchor: b(3), kind: "missing" }], null],
    },
];

const check = async (ctx: Ctx, c: Case, edits: EditRow[], a: Anchors, b: Anchors): Promise<void> => {
    assert.deepEqual(
        edits.map(({ status, landed }, index) => [status, c.outcomes[index]?.[1] === undefined ? undefined : landed]),
        c.outcomes.map(([status, landed]) => [status, landed]),
        `${c.name}: outcomes ${JSON.stringify(edits.map(({ status, landed, unresolved }) => ({ status, landed, unresolved })))}`,
    );
    if (c.unresolved !== undefined) {
        assert.deepEqual(edits.map(({ unresolved }) => unresolved), c.unresolved(a, b), `${c.name}: each refusal names exactly its own unresolved anchors`);
    }
    assert.deepEqual(await fileLines(ctx, DEBUG), expectLines(DEBUG_LINES, c.debug ?? (() => {})), `${c.name}: ${DEBUG} after the program`);
    assert.deepEqual(await fileLines(ctx, HELPERS), expectLines(HELPERS_LINES, c.helpers ?? (() => {})), `${c.name}: ${HELPERS} after the program`);
};

for (const c of COHERENT) test(`{§op-methods-op-dispatch}: coherent program, ${c.name}`, async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, c.frames);
        await check(ctx, c, edits, published[0], published[1]);
    });
});

for (const c of REFUSED) test(`{§op-methods-op-dispatch}: refused attempt, ${c.name}`, async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, c.frames);
        await check(ctx, c, edits, published[0], published[1]);
    });
});

test("{§edit-result-receipt-projection}: every EDIT receipt carries its own padded window, and a later receipt supersedes a neighbour's anchor", async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(12), "from django.utils import timezone  # kept"), edit(DEBUG, a(23), EXCEPT_404)]);
        const [a] = published;
        assert.deepEqual(edits.map(({ status, landed }) => [status, landed]), [[200, "<11>"], [200, "<12>"], [200, "<23>"]]);
        const contexts = edits.map(({ context }) => context!);
        assert.deepEqual(contexts.map((lines) => lines.length), [9, 9, 9], "four lines above and four below each single-line change");
        const anchorAt = (lines: string[], line: number): string => {
            const match = lines.map((text) => /^ *(\d+)<(@[0-9A-Za-z]{5})>/u.exec(text)).find((m) => m !== null && Number(m[1]) === line);
            assert.ok(match, `line ${line} in ${JSON.stringify(lines)}`);
            return match[2];
        };
        assert.notEqual(anchorAt(contexts[0], 12), a(12), "after line 11 changed, the first receipt already shows line 12 under a new anchor (its neighbourhood changed)");
        assert.equal(edits[1].landed, "<12>", "yet the program's original anchor for line 12 still landed there ({§op-methods-op-dispatch})");
        assert.notEqual(anchorAt(contexts[1], 11), anchorAt(contexts[0], 11), "the second receipt supersedes the first receipt's anchor for line 11");
        assert.equal(anchorAt(contexts[2], 23), anchorAt(contexts[2], 23));
        assert.match(contexts[2][4], /^ *23<@[0-9A-Za-z]{5}>    except Http404:$/u, "the changed line sits in the middle of its window");
    });
});

test("{§op-methods-op-dispatch}: across programs, a neighbour's packet anchor is stale and refused; the receipt's anchor is current; a far anchor still holds", async () => {
    await withProject(async (ctx) => {
        const first = await program(ctx, 1, (a) => [edit(DEBUG, a(11), URLS_IMPORT)]);
        assert.deepEqual(first.edits.map(({ status, landed }) => [status, landed]), [[200, "<11>"]]);
        const [stale] = first.published;
        const second = await program(ctx, 2, (a) => {
            assert.notEqual(a(12), stale(12), "line 12's anchor changed with its neighbourhood");
            assert.equal(a(23), stale(23), "line 23's anchor did not");
            return [
                edit(DEBUG, stale(12), "from django.utils import timezone  # stale attempt"),
                edit(DEBUG, a(12), "from django.utils import timezone  # kept"),
                edit(DEBUG, stale(23), EXCEPT_404),
            ];
        });
        assert.deepEqual(second.edits.map(({ status, landed, unresolved }) => [status, landed, unresolved]), [
            [409, null, [{ anchor: stale(12), kind: "missing" }]],
            [200, "<12>", null],
            [200, "<23>", null],
        ]);
        assert.deepEqual(await fileLines(ctx, DEBUG), expectLines(DEBUG_LINES, (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); set(d, 23, EXCEPT_404); }));
    });
});

test("{§op-methods-op-dispatch}: after a whole-file rewrite, every earlier anchor is stale", async () => {
    await withProject(async (ctx) => {
        const first = await program(ctx, 1, () => [edit(DEBUG, "1,-1", "# rewritten\n")]);
        assert.equal(first.edits[0].status, 200);
        const [original] = first.published;
        const second = await program(ctx, 2, () => [edit(DEBUG, original(23), EXCEPT_404)]);
        assert.deepEqual(second.edits.map(({ status, unresolved }) => [status, unresolved]), [[409, [{ anchor: original(23), kind: "missing" }]]]);
        assert.deepEqual(await fileLines(ctx, DEBUG), ["# rewritten"]);
    });
});
});


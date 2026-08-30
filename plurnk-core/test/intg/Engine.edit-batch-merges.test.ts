// #428 phase 3 — {§edit-batch-merges}: the certain resolutions land and say so on the row; the
// rest stay refusals. Shapes from the 2026-08-29 runs: gemma's shared endpoint (run68 t34), a
// READ rendering pasted back as an EDIT body (run16), an identical twin, two insertions at one
// point, and the refusals that must survive (containment, an unevidenced shared endpoint).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

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

type Row = { op: string; status_rx: number; rx: string };
const editRows = (rows: Row[]): Array<{ status: number; rx: Record<string, unknown> }> =>
    rows.filter(({ op }) => op === "EDIT").map(({ status_rx, rx }) => ({ status: status_rx, rx: JSON.parse(rx) }));

test("{§edit-batch-merges} gemma's shape: the shared line goes to the body that reproduces it, both rows land, the shrunk row says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## EDIT0 (file:///f.go) <2,3>\nfunc resolve() string {\n\treturn \"\"\n}\n\n\n## EDIT0 (file:///f.go) <3,5>\nfunc requireFn(a int) int {\n\treturn a + 1\n}\n\n## SEND0 [102]\nediting", 50),
            makeMockResponse("## SEND0 [200]\ndone", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "merge", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ worker_id: result.modelWorkerId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.deepEqual(edits[0]!.rx.merged, [{ rule: "shared-endpoint", line: 3, text: "func requireFn(a int) int {", authored: [2, 3], applied: [2, 2], claimedBy: 1 }]);
                assert.equal(edits[1]!.rx.merged, undefined, "the claiming row is an ordinary applied edit");
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\nfunc resolve() string {\n\treturn \"\"\n}\nfunc requireFn(a int) int {\n\treturn a + 1\n}\n\nfunc other() {}\n", "resolve() lands on the blank line 2; requireFn keeps line 3");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§edit-batch-merges} a READ rendering pasted back as a body is stripped only when its anchors verify; a look-alike is written as authored", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const pending: { body: string | null; fake: string | null } = { body: null, fake: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## READ0 (file:///f.go) <1,-1>\n\n## SEND0 [102]\nreading", 50),
            makeMockResponse("## SEND0 [200]\nread", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`## EDIT0 (file:///f.go) <1,2>\n${pending.body}\n\n## EDIT0 (file:///f.go) <7>\n${pending.fake}\n\n## SEND0 [102]\nediting`, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("## SEND0 [200]\nedited", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "paste", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look", policy: { proposals: "accept" } });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<Row>({ worker_id: first.modelWorkerId! })).find(({ op, status_rx }) => op === "READ" && status_rx === 200);
                const anchors = JSON.parse(readRow!.rx).lineAnchors as string[];
                assert.equal(anchors.length, 7);
                // Lines 1-2 pasted back exactly as rendered (anchor, right-aligned ordinal, colon, text);
                // line 7's "prefix" carries a hash that is not this resource's anchor.
                pending.body = `${anchors[0]} 1:var x int\n${anchors[1]} 2:`;
                pending.fake = "@zzzzz 7:func other() { /* kept */ }";
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(second.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ worker_id: second.modelWorkerId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200], JSON.stringify(edits.map(({ rx }) => rx.problem ?? null)));
                assert.deepEqual(edits[0]!.rx.merged, [{ rule: "rendered-prefix-stripped", lines: 2 }]);
                assert.deepEqual(edits[1]!.rx.merged, [{ rule: "rendered-prefix-unverified", lines: 1 }]);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), "var x int\n\nfunc requireFn(a int) int {\n\treturn a\n}\n\n@zzzzz 7:func other() { /* kept */ }\n", "verified prefixes stripped; the look-alike written verbatim");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§edit-batch-merges} an identical twin applies once; its row carries the fact and no effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## EDIT0 (file:///f.go) <1>\nvar x int64\n\n## EDIT0 (file:///f.go) <1>\nvar x int64\n\n## SEND0 [102]\nediting", 50),
            makeMockResponse("## SEND0 [200]\ndone", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "twin", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ worker_id: result.modelWorkerId! }));
                assert.deepEqual(edits.map(({ status }) => status), [200, 200]);
                assert.ok(edits[0]!.rx.receipt !== undefined, "the first row carries the effect");
                assert.deepEqual(edits[1]!.rx.merged, [{ rule: "duplicate-of", of: 0 }]);
                assert.equal(edits[1]!.rx.receipt, undefined, "the twin applied nothing and claims no effect");
                assert.match(await readFile(join(root, "f.go"), "utf8"), /^var x int64\n\nfunc requireFn/);
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§edit-batch-merges} containment is still refused, naming the region to resubmit", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-merge-"));
    try {
        await seeded(root);
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## EDIT0 (file:///f.go) <3,5>\nfunc requireFn(a int) int { return a }\n\n## EDIT0 (file:///f.go) <4>\n\treturn a * 2\n\n## SEND0 [102]\nediting", 50),
            makeMockResponse("## SEND0 [200]\ndone", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "contain", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(result.result.status, 200);
                const edits = editRows(await db.engine_render_log.all<Row>({ worker_id: result.modelWorkerId! }));
                assert.deepEqual(edits.map(({ status }) => status), [409, 409]);
                const problem = edits[0]!.rx.problem as { conflicts: Array<{ relation: string }>; recovery: string };
                assert.equal(problem.conflicts[0]!.relation, "one contains the other");
                assert.match(problem.recovery, /Resubmit the outer region alone/);
                assert.equal(await readFile(join(root, "f.go"), "utf8"), SOURCE, "nothing applied");
            } finally { ws.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

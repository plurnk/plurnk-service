import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { observedScriptExecution, type ScriptReceipt } from "../demo/_script-oracle.ts";

const stream = "sh:///1/2/3/EXEC";
const execution = (target: string | null, body = ""): ScriptReceipt => ({
    scheme: "file", pathname: target, fragment: null,
    tx: JSON.stringify({ target: target === null ? null : { raw: target }, body }), rx: null,
    attrs: JSON.stringify({ stream }), status_rx: 200, origin: "model",
});

test("script oracle recognizes actual shell terminal receipts through the daemon", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-script-oracle-"));
    try {
        await writeFile(join(workspace, "greet.sh"), "#!/bin/sh\nprintf 'GREETING\\n'\n");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "## PLAN0\n[]\n### EXEC0 (greet.sh)\n### SEND0 (WAIT)\nWait for the script.", reasoning: null } },
            { assistant: { content: "## PLAN0\n[]\n### SEND0 (TERM)\nGREETING", reasoning: null } },
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "script-oracle", projectRoot: workspace });
                const result = await runLoopToTerminal(ws, 2, { prompt: "run greet.sh", policy: { proposals: "accept" } });
                assert.equal(result.finalStatus, 200);
                assert.ok(result.modelWorkerId);
                const execs = await db.test_log_entries_by_worker_op_full.all<ScriptReceipt>({ worker_id: result.modelWorkerId, op: "EXEC" });
                const reads = await db.test_log_entries_by_worker_op_full.all<ScriptReceipt>({ worker_id: result.modelWorkerId, op: "READ" });
                assert.equal(observedScriptExecution(execs, reads, "greet.sh", "GREETING"), true, JSON.stringify({ execs, reads }));
            } finally { ws.close(); }
        });
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
const receipt = (output = "GREETING\n", exitCode = 0, source = stream): ScriptReceipt => ({
    scheme: "sh", pathname: new URL(source).pathname, fragment: "stdout",
    tx: "{}", rx: JSON.stringify({ content: output, exitCode }),
    attrs: JSON.stringify({ streamEnd: output.length, terminal: true }), status_rx: 200, origin: "_plurnk",
});

test("script oracle accepts native script execution and shell commands with observed successful output", () => {
    for (const exec of [execution("greet.sh"), execution(null, "sh ./greet.sh"), execution(null, "chmod +x greet.sh && ./greet.sh")]) {
        assert.equal(observedScriptExecution([exec], [receipt()], "greet.sh", "GREETING"), true);
    }
});

test("script oracle rejects claimed, unobserved, failed, unrelated and mismatched executions", () => {
    const cases: Array<[ScriptReceipt[], ScriptReceipt[]]> = [
        [[], []],
        [[execution("greet.sh")], []],
        [[execution("greet.sh")], [receipt("GREETING\n", 1)]],
        [[execution("greet.sh")], [receipt("WRONG\n")]],
        [[execution(null, "printf GREETING")], [receipt()]],
        [[execution("greet.sh")], [receipt("GREETING\n", 0, "sh:///1/2/4/EXEC")]],
        [[{ ...execution("greet.sh"), status_rx: 403 }], [receipt()]],
        [[execution("greet.sh")], [{ ...receipt(), attrs: JSON.stringify({ terminal: false }) }]],
        [[execution("greet.sh")], [{ ...receipt(), fragment: "stderr" }]],
    ];
    for (const [execs, reads] of cases) assert.equal(observedScriptExecution(execs, reads, "greet.sh", "GREETING"), false);
});

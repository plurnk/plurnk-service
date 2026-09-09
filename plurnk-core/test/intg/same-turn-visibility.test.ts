// {§op-execution-order} {§edit-execution}
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import LineAnchors from "../../src/content/line-anchors.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("{§turn-ops-selection-snapshot}: log KILL selects the pre-program snapshot, not rows emitted earlier by its own program", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        { assistant: { content: "```FIND (worker:///*)```\n```KILL (log:///1/2/*)```\n```TASK\n[{\"content\":\"Continue after curating the observed pre-program row.\",\"status\":\"in_progress\"}]\n```", reasoning: null } },
        { assistant: { content: "```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", reasoning: null } },
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-selection-snapshot" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "Exercise current-turn log selection.", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{
                turn_id: number;
                op: string | null;
                origin: string;
                active: 0 | 1;
                attrs: string;
            }>({ loop_id: result.loopId });
            const firstModelTurnId = rows.find(({ origin, op }) => origin === "model" && op === "FIND")?.turn_id;
            assert.ok(firstModelTurnId !== undefined);
            const firstModelTurn = rows.filter(({ turn_id }) => turn_id === firstModelTurnId);
            const prompt = firstModelTurn.find(({ op }) => op === "prompt");
            assert.equal(prompt?.active, 0, "the pre-program prompt row was in the selected snapshot");
            for (const op of ["FIND", "KILL", "TASK"] as const) {
                assert.equal(
                    firstModelTurn.find((row) => row.op === op)?.active,
                    1,
                    `${op} was emitted by the executing program and cannot select itself`,
                );
            }
            const turnOps = firstModelTurn.find(({ op, attrs }) => op === null
                && (JSON.parse(attrs) as { kind?: string }).kind === "turnOps");
            assert.equal(turnOps?.active, 1, "the admitted program remains active evidence");
        } finally { ws.close(); }
    });
});

test("{§op-execution-order}: FIND observes an entry created by EDIT in the same turn", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Turn 1: write, then read-back in the same turn; NEXT (a same-turn DONE would
        // — correctly — trip the weigh-before-conclude 409; that gate is not under test here).
        makeMockResponse("\n```EDIT (worker:///abs/module-loader-spec.md)\nthe spec body\n```\n\n```FIND (worker:///**)```\n```TASK\n[{\"content\":\"wrote and listed\",\"status\":\"in_progress\"}]\n```", 10),
        makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "probe360" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: loopId });
            const modelFind = (rows ?? []).filter((r) => r.op === "FIND" && r.origin === "model");
            assert.ok(modelFind.length >= 1, "the model's FIND dispatched");
            const rx = JSON.parse(modelFind[0].rx ?? "{}") as { content?: string };
            assert.match(rx.content ?? "", /module-loader-spec/,
                "the just-EDITed entry is visible to the SAME-turn FIND — writes land before subsequent ops read");
        } finally { ws.close(); }
    });
});

test("{§edit-execution}: each EDIT records its own revision; an earlier READ retains its snapshot", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("\n```EDIT (worker:///mode.md)\none\ntwo\nthree\nfour\n```\n\n```TASK\n[{\"content\":\"fixture created\",\"status\":\"in_progress\"}]\n```", 10),
        makeMockResponse("\n```READ (worker:///mode.md)```\n```EDIT (worker:///mode.md) <4>\nFOUR\n```\n\n```EDIT (worker:///mode.md) <2>\nTWO\n2.5\n```\n\n```TASK\n[{\"content\":\"mutated and observed\",\"status\":\"in_progress\"}]\n```", 10),
        makeMockResponse("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-batch" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const reads = rows.filter((row) => row.op === "READ" && row.origin === "model");
            assert.equal(reads.length, 1);
            const receipt = JSON.parse(reads[0].rx) as { content?: string };
            assert.equal(receipt.content, "one\ntwo\nthree\nfour");
            const edits = rows
                .filter((row) => row.op === "EDIT" && row.origin === "model")
                .map((row) => JSON.parse(row.rx) as {
                    receipt?: { revision?: string; effect?: { requested?: string; source?: string; result?: string } };
                })
                .filter((row) => row.receipt?.effect?.requested === "<2>" || row.receipt?.effect?.requested === "<4>");
            assert.equal(edits.length, 2);
            assert.match(edits[0].receipt?.revision ?? "", /^[a-f0-9]{64}$/);
            assert.notEqual(edits[0].receipt?.revision, edits[1].receipt?.revision, "each EDIT identifies its own committed revision");
            const unanchored = (context: unknown): string => String(context).replace(/^@[0-9A-Za-z]{5} +/gm, "");
            assert.deepEqual(edits.map((row) => ({ ...(row.receipt?.effect ?? {}), context: unanchored((row.receipt?.effect as { context?: unknown } | undefined)?.context) })), [
                { requested: "<4>", source: "4", result: "4", removed: 1, inserted: 1, context: "2:two\n3:three\n4:FOUR" },
                { requested: "<2>", source: "2", result: "2-3", removed: 1, inserted: 2, context: "1:one\n2:TWO\n3:2.5\n4:three\n5:FOUR" },
            ]);
            for (const row of edits) assert.match(String((row.receipt?.effect as { context?: unknown } | undefined)?.context), /^@[0-9A-Za-z]{5} +[1-9]/, "{§edit-receipt-anchored-context}");
        } finally { ws.close(); }
    });
});

test("{§edit-execution}: overlapping numeric EDITs apply to successive resource states", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```EDIT (worker:///atomic.md)\none\ntwo\nthree\n```\n\n```TASK\n[{\"content\":\"fixture\",\"status\":\"in_progress\"}]\n```", 10),
        makeMockResponse("```EDIT (worker:///atomic.md) <1,2>\nchanged\n```\n\n```EDIT (worker:///atomic.md) <2,3>\nalso changed\n```\n\n```READ (worker:///atomic.md)```\n```TASK\n[{\"content\":\"checked\",\"status\":\"in_progress\"}]\n```", 10),
        makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-atomic-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const failedEdits = rows.filter((row) => row.op === "EDIT" && row.origin === "model"
                && (JSON.parse(row.rx) as { status?: number }).status === 200);
            assert.equal(failedEdits.length, 2);
            const read = rows.find((row) => row.op === "READ" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "changed\nalso changed");
        } finally { ws.close(); }
    });
});

test("{§edit-line-anchors}: a two-anchor whole-line range survives the composed EDIT path", async () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const [alpha, beta] = LineAnchors.tokens("worker:///anchored-range.md", content);
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("\n```EDIT (worker:///anchored-range.md)\nalpha\nbeta\ngamma\ndelta\n```\n\n```TASK\n[{\"content\":\"created\",\"status\":\"in_progress\"}]\n```", 10),
        makeMockResponse(`
\`\`\`EDIT (worker:///anchored-range.md) <${alpha},${beta}>\`\`\`
\`\`\`READ (worker:///anchored-range.md)\`\`\`
\`\`\`TASK
[{"content":"verify","status":"in_progress"}]
\`\`\``, 10),
        makeMockResponse("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "anchored-range" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const read = rows.findLast((row) => row.op === "READ" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "gamma\ndelta");
        } finally { ws.close(); }
    });
});

test("{§edit-execution}: an invalid anchored EDIT leaves the earlier effect intact", async () => {
    const content = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
    const [one, two, three, four, five, six, seven, eight] = LineAnchors.tokens(
        "worker:///anchor-batch.md",
        content,
    );
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse(`
\`\`\`EDIT (worker:///anchor-batch.md)
${content}
\`\`\`

\`\`\`TASK
[{"content":"created","status":"in_progress"}]
\`\`\``, 10),
        makeMockResponse(`
\`\`\`EDIT (worker:///anchor-batch.md) <${one},${two}>\`\`\`
\`\`\`EDIT (worker:///anchor-batch.md) <${three},${four},${five},${six},${seven},${eight}>
replacement
\`\`\`

\`\`\`READ (worker:///anchor-batch.md)\`\`\`
\`\`\`TASK
[{"content":"verify","status":"in_progress"}]
\`\`\``, 10),
        makeMockResponse("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "anchored-batch-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{
                annotation: string | null;
                op: string;
                origin: string;
                rx: string;
            }>({ loop_id: result.loopId });
            const edits = rows
                .filter((row) => row.op === "EDIT" && row.origin === "model")
                .map((row) => JSON.parse(row.rx) as {
                    problem?: { anchor?: string; type?: string };
                    status?: number;
                });
            assert.equal(edits.length, 3, "fixture creation plus the two authored batch members");
            assert.equal(edits[1]?.status, 200);
            assert.equal(edits[1]?.problem?.anchor, undefined);
            assert.equal(edits[1]?.problem, undefined);
            assert.equal(edits[2]?.status, 400);
            assert.equal(edits[2]?.problem?.anchor, three);
            assert.match(edits[2]?.problem?.type ?? "", /line-anchor-invalid$/);

            const read = rows.findLast((row) => row.op === "READ" && row.origin === "model");
            assert.equal(
                (JSON.parse(read?.rx ?? "{}") as { content?: string }).content,
                "three\nfour\nfive\nsix\nseven\neight",
                "the invalid operation does not reverse an earlier successful EDIT",
            );
        } finally { ws.close(); }
    });
});

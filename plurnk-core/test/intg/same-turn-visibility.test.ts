// {§op-mode-phases}, {§edit-batch}: observations see settled atomic mutations.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import LineAnchors from "../../src/content/line-anchors.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("{§op-mode-phases}: FIND observes an entry created by EDIT in the same turn", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Turn 1: write, then read-back in the same turn; SEND[102] (a same-turn SEND[200] would
        // — correctly — trip the weigh-before-conclude 409; that gate is not under test here).
        makeMockResponse("# PLAN0\nwrite then find\n\n## EDIT0 [+abs] (worker:///abs/module-loader-spec.md)\nthe spec body\n\n## FIND0 (worker:///**)\n\n## SEND0 [102]\nwrote and listed", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "probe360" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
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

test("{§edit-batch}: same-resource EDITs share one snapshot before READ", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("# PLAN0\ncreate fixture\n\n## EDIT0 (worker:///mode.md)\none\ntwo\nthree\nfour\n\n## SEND0 [102]\nfixture created", 10),
        makeMockResponse("# PLAN0\nobserve the settled edits\n\n## READ0 (worker:///mode.md)\n\n## EDIT0 (worker:///mode.md) <4>\nFOUR\n\n## EDIT0 (worker:///mode.md) <2>\nTWO\n2.5\n\n## SEND0 [102]\nmutated and observed", 10),
        makeMockResponse("# PLAN0\nconclude\n\n## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-batch" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const reads = rows.filter((row) => row.op === "READ" && row.origin === "model");
            assert.equal(reads.length, 1);
            const receipt = JSON.parse(reads[0].rx) as { content?: string };
            assert.equal(receipt.content, "one\nTWO\n2.5\nthree\nFOUR");
            const edits = rows
                .filter((row) => row.op === "EDIT" && row.origin === "model")
                .map((row) => JSON.parse(row.rx) as {
                    receipt?: { revision?: string; effect?: { requested?: string; source?: string; result?: string } };
                })
                .filter((row) => row.receipt?.effect?.requested === "<2>" || row.receipt?.effect?.requested === "<4>");
            assert.equal(edits.length, 2);
            assert.match(edits[0].receipt?.revision ?? "", /^[a-f0-9]{64}$/);
            assert.equal(edits[0].receipt?.revision, edits[1].receipt?.revision, "both rows identify the one committed resource revision");
            assert.deepEqual(edits.map((row) => row.receipt?.effect), [
                { requested: "<4>", source: "4", result: "5", removed: 1, inserted: 1, context: "3:2.5\n4:three\n5:FOUR" },
                { requested: "<2>", source: "2", result: "2-3", removed: 1, inserted: 2, context: "1:one\n2:TWO\n3:2.5\n4:three\n5:FOUR" },
            ]);
        } finally { ws.close(); }
    });
});

test("{§edit-batch}: an overlapping resource batch applies no EDIT", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("## EDIT0 (worker:///atomic.md)\none\ntwo\nthree\n\n## SEND0 [102]\nfixture", 10),
        makeMockResponse("## EDIT0 (worker:///atomic.md) <1,2>\nchanged\n\n## EDIT0 (worker:///atomic.md) <2,3>\nalso changed\n\n## READ0 (worker:///atomic.md)\n\n## SEND0 [102]\nchecked", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-atomic-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const failedEdits = rows.filter((row) => row.op === "EDIT" && row.origin === "model"
                && (JSON.parse(row.rx) as { status?: number }).status === 409);
            assert.equal(failedEdits.length, 2);
            const read = rows.find((row) => row.op === "READ" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "one\ntwo\nthree");
        } finally { ws.close(); }
    });
});

test("{§edit-line-anchors}: a two-anchor whole-line range survives the composed EDIT batch path", async () => {
    const content = "alpha\nbeta\ngamma\ndelta";
    const [alpha, beta] = LineAnchors.tokens("worker:///anchored-range.md", content);
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("# PLAN0\ncreate the fixture\n\n## EDIT0 (worker:///anchored-range.md)\nalpha\nbeta\ngamma\ndelta\n\n## SEND0 [102]\ncreated", 10),
        makeMockResponse(`# PLAN0\ndelete the first two lines\n\n## EDIT0 (worker:///anchored-range.md) <${alpha},${beta}>\n\n## READ0 (worker:///anchored-range.md)\n\n## SEND0 [102]\nverify`, 10),
        makeMockResponse("# PLAN0\nconclude\n\n## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "anchored-range" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const read = rows.findLast((row) => row.op === "READ" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "gamma\ndelta");
        } finally { ws.close(); }
    });
});

test("{§edit-batch}: an invalid anchored sibling is attributed only to its authored EDIT", async () => {
    const content = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight";
    const [one, two, three, four, five, six, seven, eight] = LineAnchors.tokens(
        "worker:///anchor-batch.md",
        content,
    );
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse(`# PLAN0\ncreate the fixture\n\n## EDIT0 (worker:///anchor-batch.md)\n${content}\n\n## SEND0 [102]\ncreated`, 10),
        makeMockResponse(`# PLAN0\nexercise one valid and one invalid anchored scope\n\n## EDIT0 (worker:///anchor-batch.md) <${one},${two}>\n\n## EDIT0 (worker:///anchor-batch.md) <${three},${four},${five},${six},${seven},${eight}>\nreplacement\n\n## READ0 (worker:///anchor-batch.md)\n\n## SEND0 [102]\nverify`, 10),
        makeMockResponse("# PLAN0\nconclude\n\n## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "anchored-batch-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
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
            assert.equal(edits[1]?.status, 424);
            assert.equal(edits[1]?.problem?.anchor, undefined);
            assert.match(edits[1]?.problem?.type ?? "", /edit-batch-rejected$/);
            assert.equal(edits[2]?.status, 400);
            assert.equal(edits[2]?.problem?.anchor, three);
            assert.match(edits[2]?.problem?.type ?? "", /line-anchor-invalid$/);

            const read = rows.findLast((row) => row.op === "READ" && row.origin === "model");
            assert.equal(
                (JSON.parse(read?.rx ?? "{}") as { content?: string }).content,
                content,
                "the invalid sibling rejects the same-resource batch without a partial write",
            );
        } finally { ws.close(); }
    });
});

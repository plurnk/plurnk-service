// {§op-mode-phases}, {§edit-batch}: observations see settled atomic mutations.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
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

// #360/#619 — the per-turn world model is synchronized: MODE schedules observations after
// settled mutations, irrespective of their authored position. Pinned
// after a requiem confabulated a desync (run39): the model stitched the turn-1 init-foist
// FIND (items:0, correct — pre-write) to its later EDIT[201] and testified they were one turn.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("same-turn visibility: an EDIT-created known entry is FINDable in the SAME turn (#360)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Turn 1: write, then read-back in the same turn; SEND[102] (a same-turn SEND[200] would
        // — correctly — trip the weigh-before-conclude 409; that gate is not under test here).
        makeMockResponse("<<PLAN:write then find:PLAN\n<<EDIT[abs](worker:///abs/module-loader-spec.md):the spec body:EDIT\n<<FIND(worker:///**)::FIND\n<<SEND[102]:wrote and listed:SEND", 10),
        makeMockResponse("<<SEND[200]:done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "probe360" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; origin: string; rx: string }>({ loop_id: 2 });
            const modelFind = (rows ?? []).filter((r) => r.op === "FIND" && r.origin === "model");
            assert.ok(modelFind.length >= 1, "the model's FIND dispatched");
            const rx = JSON.parse(modelFind[0].rx ?? "{}") as { content?: string };
            assert.match(rx.content ?? "", /module-loader-spec/,
                "the just-EDITed entry is visible to the SAME-turn FIND — writes land before subsequent ops read");
        } finally { ws.close(); }
    });
});

test("MODE batches same-resource EDITs against one snapshot before an authored-earlier READ (#619)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<PLAN:create fixture:PLAN\n<<EDIT(worker:///mode.md):one\ntwo\nthree\nfour:EDIT\n<<SEND[102]:fixture created:SEND", 10),
        makeMockResponse("<<PLAN:observe the settled edits:PLAN\n<<READ(worker:///mode.md)::READ\n<<EDIT(worker:///mode.md)<4>:FOUR:EDIT\n<<EDIT(worker:///mode.md)<2>:TWO\n2.5:EDIT\n<<SEND[102]:mutated and observed:SEND", 10),
        makeMockResponse("<<PLAN:conclude:PLAN\n<<SEND[200]:done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-batch" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(result.finalStatus, 200);
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
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

test("MODE rejects an overlapping resource batch without applying either EDIT (#619)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("<<EDIT(worker:///atomic.md):one\ntwo\nthree:EDIT\n<<SEND[102]:fixture:SEND", 10),
        makeMockResponse("<<EDIT(worker:///atomic.md)<1,2>:changed:EDIT\n<<EDIT(worker:///atomic.md)<2,3>:also changed:EDIT\n<<READ(worker:///atomic.md)::READ\n<<SEND[102]:checked:SEND", 10),
        makeMockResponse("<<SEND[200]:done:SEND", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "mode-atomic-failure" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "go", flags: { auto: true } });
            assert.equal(result.finalStatus, 200);
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId });
            const failedEdits = rows.filter((row) => row.op === "EDIT" && row.origin === "model"
                && (JSON.parse(row.rx) as { status?: number }).status === 409);
            assert.equal(failedEdits.length, 2);
            const read = rows.find((row) => row.op === "READ" && row.origin === "model");
            assert.equal((JSON.parse(read?.rx ?? "{}") as { content?: string }).content, "one\ntwo\nthree");
        } finally { ws.close(); }
    });
});

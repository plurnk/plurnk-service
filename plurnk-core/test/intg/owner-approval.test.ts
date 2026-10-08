// {§worker-owner-resolution} Server disposition and worker owners use one proposal lifecycle.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { EditStatement } from "@plurnk/plurnk-contracts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { viableWindow } from "./_provider.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, runLoopToTerminal, waitFor, flush } from "./_rpc.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { makeMockResponse } from "./_mock.ts";

class ProposingTest {
    readonly batches: number[] = [];
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
    };

    async editBatch(statements: readonly EditStatement[]): Promise<{ status: number; attrs: object; body: string }> {
        this.batches.push(statements.length);
        return {
            status: 202,
            body: "--- proposed-test\n+++ proposed-test\n@@ +x @@",
            attrs: { target: "/proposed-test" },
        };
    }
}

test("{§edit-execution}: each EDIT waits for its own proposal before preparing the next", async () => {
    const dsl = "````EDIT (proposing-test://x) <1>\none\n````\n\n````EDIT (proposing-test://x) <3>\nthree\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const scheme = new ProposingTest();
        daemon.schemes.register("proposing-test", scheme);
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "one-resource-proposal" });
            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "batch" });
            const pending = await waitFor(
                () => proposals() as Array<{ logEntryId: number }>,
                (items) => items.length === 1,
            );
            assert.deepEqual(scheme.batches, [1], "the second EDIT has not been prepared");
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "accept" });
            const next = await waitFor(
                () => proposals() as Array<{ logEntryId: number }>,
                (items) => items.length === 2,
            );
            await rpcCall(ws, 4, "loop.resolve", { logEntryId: next[1].logEntryId, decision: "accept" });
            const run = await loopPromise;
            const loopId = (run.result as { loopId: number }).loopId;
            await flush();
            assert.deepEqual(scheme.batches, [1, 1]);
            assert.equal(proposals().length, 2);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string; status_rx: number }>({ loop_id: loopId });
            const edits = rows.filter((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.equal(edits.length, 2);
            assert.ok(edits.every((row) => row.status_rx === 200));
        } finally { ws.close(); }
    });
});

test("{§worker-owner-resolution} server acceptance resolves through Core without a client resolver", async (t) => {
    serverProposals(t, "accept");
    const first = "````EDIT (proposing-test://x)\ny\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse(first, 50),
        makeMockResponse("````KILL\ndone\n````", 0),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-accept" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal",
            });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string }>({ loop_id: result.loopId });
            const edit = rows.find((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.ok(edit !== undefined);
            assert.notEqual(edit.status_rx, 202);
        } finally { ws.close(); }
    });
});

test("{§proposal-ownership-notification} server rejection settles the same admitted proposal without becoming a capability denial", async (t) => {
    serverProposals(t, "reject");
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````EDIT (proposing-test://x)\ny\n````\n\n````SEND\ndone\n````", 50),
        makeMockResponse("````KILL\nthe edit was declined; concluding\n````", 50),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-reject" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal",
            });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string; rx: string }>({ loop_id: result.loopId });
            const edit = rows.find((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.equal(edit?.status_rx, 400, "the admitted action was declined, not denied at capability admission");
            const refusal = JSON.parse(edit!.rx) as { outcome?: string };
            assert.equal(refusal.outcome, "policy_veto");
            const [proposal] = await waitFor(
                () => proposals() as Array<{ disposition?: unknown; owner?: string }>,
                (items) => items.length > 0,
            );
            assert.deepEqual(proposal.disposition, { decision: "reject", outcome: "policy_veto" });
            assert.equal(proposal.owner, TEST_OWNER);
        } finally { ws.close(); }
    });
});

test("{§notifications-loop-proposal} proposal notification projects the durable owner and selected disposition", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````EDIT (proposing-test://x)\ny\n````\n\n````SEND\ndone\n````", 50),
    ] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-review" });
            const run = rpcCall(ws, 2, "loop.run", {
                prompt: "trigger",
            });
            const [proposal] = await waitFor(
                () => proposals() as Array<{ logEntryId: number; workerId?: number; owner?: string; disposition?: unknown }>,
                (items) => items.length > 0,
            );
            assert.equal(typeof proposal.workerId, "number");
            assert.equal(proposal.owner, TEST_OWNER);
            assert.deepEqual(proposal.disposition, { decision: "review" });
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: proposal.logEntryId, decision: "accept" });
            await run;
        } finally { ws.close(); }
    });
});

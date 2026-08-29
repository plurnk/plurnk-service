// {§loop-policy} — loop.run persists one complete immutable policy. Capability
// admission and proposal disposition remain independent parts of that value;
// proposal review, acceptance, and rejection all use one lifecycle.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { EditStatement, LoopPolicy } from "@plurnk/plurnk-contracts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { viableWindow } from "./_helpers.ts";
import {
    rpcCall,
    rpcProblem,
    subscribeNotifications,
    connect,
    withDaemon,
    makeMockResponse,
    runLoopToTerminal,
    waitFor,
    flush,
} from "./_rpc.ts";

class ProposingTest {
    readonly batches: number[] = [];
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        entryOwner: "commons",
        inherit: "none",
        writableBy: ["model", "client", "plugin"],
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

test("{§edit-batch}: one proposal resolution governs every same-resource EDIT row", async () => {
    const dsl = "## EDIT0 (proposing-test://x) <1>\none\n\n## EDIT0 (proposing-test://x) <3>\nthree\n\n## SEND0 [200]\ndone";
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
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "accept" });
            const run = await loopPromise;
            const loopId = (run.result as { loopId: number }).loopId;
            await flush();
            assert.deepEqual(scheme.batches, [2]);
            assert.equal(proposals().length, 1);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string; status_rx: number }>({ loop_id: loopId });
            const edits = rows.filter((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.equal(edits.length, 2);
            assert.ok(edits.every((row) => row.status_rx === 200));
        } finally { ws.close(); }
    });
});

test("loop.run persists a complete canonical policy and omission uses the complete default", async () => {
    const response = "## SEND0 [200]\ndone";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse(response, 0),
        makeMockResponse(response, 0),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "policy-persist" });
            const selected = await runLoopToTerminal(ws, 2, {
                prompt: "selected",
                policy: {
                    capabilities: { deny: [{ runtime: "sh" }] },
                    proposals: "accept",
                },
            });
            const selectedId = selected.loopId;
            const selectedRow = await db.engine_get_loop_policy.get<{ policy: string }>({ loop_id: selectedId });
            assert.deepEqual(JSON.parse(selectedRow!.policy) as LoopPolicy, {
                capabilities: { deny: [{ runtime: "sh" }] },
                proposals: "accept",
            });

            const ordinary = await runLoopToTerminal(ws, 3, { prompt: "ordinary" });
            const ordinaryId = ordinary.loopId;
            const ordinaryRow = await db.engine_get_loop_policy.get<{ policy: string }>({ loop_id: ordinaryId });
            assert.deepEqual(JSON.parse(ordinaryRow!.policy) as LoopPolicy, {
                capabilities: {},
                proposals: "review",
            });
        } finally { ws.close(); }
    });
});

test("proposals=accept resolves through Core without a client resolver", async () => {
    const first = "## EDIT0 (proposing-test://x)\ny\n\n## SEND0 [200]\ndone";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse(first, 50),
        makeMockResponse("## SEND0 [200]\ndone", 0),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-accept" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal",
                policy: { proposals: "accept" },
            });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string }>({ loop_id: result.loopId });
            const edit = rows.find((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.ok(edit !== undefined);
            assert.notEqual(edit.status_rx, 202);
        } finally { ws.close(); }
    });
});

test("proposals=reject settles the same admitted proposal without becoming a capability denial", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("## EDIT0 (proposing-test://x)\ny\n\n## SEND0 [200]\ndone", 50),
        makeMockResponse("## SEND0 [200]\nthe edit was declined; concluding", 50),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-reject" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal",
                policy: { proposals: "reject" },
            });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string }>({ loop_id: result.loopId });
            const edit = rows.find((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.equal(edit?.status_rx, 400, "the admitted action was declined, not denied at capability admission");
            const [proposal] = await waitFor(
                () => proposals() as Array<{ disposition?: unknown; policy?: unknown }>,
                (items) => items.length > 0,
            );
            assert.deepEqual(proposal.disposition, {
                owner: "loop",
                decision: "reject",
                outcome: "no_review_channel",
            });
            assert.deepEqual(proposal.policy, { capabilities: {}, proposals: "reject" });
        } finally { ws.close(); }
    });
});

test("proposal notification projects the same durable policy and its derived disposition", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("## EDIT0 (proposing-test://x)\ny\n\n## SEND0 [200]\ndone", 50),
    ] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-review" });
            const run = rpcCall(ws, 2, "loop.run", {
                prompt: "trigger",
                policy: { capabilities: { deny: [{ runtime: "python3" }] }, proposals: "review" },
            });
            const [proposal] = await waitFor(
                () => proposals() as Array<{ logEntryId: number; workerId?: number; policy?: unknown; disposition?: unknown }>,
                (items) => items.length > 0,
            );
            assert.equal(typeof proposal.workerId, "number");
            assert.deepEqual(proposal.policy, {
                capabilities: { deny: [{ runtime: "python3" }] },
                proposals: "review",
            });
            assert.deepEqual(proposal.disposition, { owner: "client" });
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: proposal.logEntryId, decision: "accept" });
            await run;
        } finally { ws.close(); }
    });
});

test("loop.run rejects every malformed policy at the public boundary", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "bad-policy" });
            for (const policy of [
                { proposals: "sometimes" },
                { capabilities: { deny: [{}] } },
                { automatic: true },
                "accept",
            ]) {
                const response = await rpcCall(ws, 2, "loop.run", { prompt: "test", policy });
                const problem = rpcProblem(response);
                assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/loop-policy-invalid");
                assert.equal(problem.field, "policy");
                assert.equal(problem.retryable, false);
            }
        } finally { ws.close(); }
    });
});

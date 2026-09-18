import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { liveLoop } from "../_live-harness.ts";
import { connect, makeMockResponse, rpcCall, withDaemon } from "./_rpc.ts";

for (const cancelled of [false, true]) {
    test(`{§loop-response-messages} the live harness retains the last SEND across ${cancelled ? "cancellation" : "completion"}`, async () => {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse("````FIND (worker:///)\n````\n````SEND\nFirst answer.\n````"),
            makeMockResponse("````FIND (worker:///)\n````\n````SEND\nSecond answer.\n````"),
            makeMockResponse(cancelled ? "````KILL (worker://root)\n````" : "````NOTE\nThe observed results confirm the answer.\n````"),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspace = await rpcCall(ws, 1, "workspace.create", { name: `live-response-${cancelled}` });
                const { workerId } = await daemon.createConversationWorker({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
                const result = await liveLoop({ db, ws }, 2, { prompt: "Answer in two parts.", workerId, maxTurns: 5 });
                assert.equal(result.finalStatus, cancelled ? 499 : 200);
                assert.equal(provider.received.length, 3);
                assert.equal(result.lastContent, "Second answer.",
                    "the specimen evaluates the daemon's response: the last delivered message, not the terminal packet");
            } finally { ws.close(); }
        });
    });
}

test("{§loop-response-messages} the live harness does not invent text for blank SEND", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("````SEND\n````"),
    ] });
    await withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-response-silent" });
            const result = await liveLoop({ db, ws }, 2, { prompt: "What is the capital of France?" });
            assert.equal(result.finalStatus, 200);
            assert.equal(result.lastContent, "", "blank SEND delivers no response text");
        } finally { ws.close(); }
    });
});

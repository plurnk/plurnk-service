import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { liveLoop } from "../_live-harness.ts";
import { connect, makeMockResponse, rpcCall, withDaemon } from "./_rpc.ts";

for (const terminal of ["completed", "failed"] as const) {
    test(`{§loop-response-messages} the live harness retains earlier SENDs when TASK ends ${terminal} without a new message`, async () => {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse('```SEND\nFirst answer.\n```\n```TASK\n[{"content":"Continue the work.","status":"in_progress"}]\n```'),
            makeMockResponse('```SEND\nSecond answer.\n```\n```TASK\n[{"content":"Review the outcome.","status":"in_progress"}]\n```'),
            makeMockResponse(`\`\`\`TASK\n[{"content":"The outcome is recorded.","status":"${terminal}"}]\n\`\`\``),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `live-response-${terminal}` });
                const result = await liveLoop({ db, ws }, 2, { prompt: "Answer in two parts.", maxTurns: 5 });
                assert.equal(result.finalStatus, terminal === "completed" ? 200 : 499);
                assert.equal(result.lastContent, "First answer.\n\nSecond answer.",
                    "the specimen evaluates the daemon's complete response, not only the terminal packet");
            } finally { ws.close(); }
        });
    });
}

test("{§loop-response-messages} the live harness does not mistake a TASK description for a delivered answer", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse('```TASK\n[{"content":"The answer is Paris.","status":"completed"}]\n```'),
    ] });
    await withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-response-silent" });
            const result = await liveLoop({ db, ws }, 2, { prompt: "What is the capital of France?" });
            assert.equal(result.finalStatus, 200);
            assert.equal(result.lastContent, "", "TASK is inventory, not a response message");
        } finally { ws.close(); }
    });
});

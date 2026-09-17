import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { liveLoop } from "../_live-harness.ts";
import { connect, makeMockResponse, rpcCall, withDaemon } from "./_rpc.ts";

for (const terminal of ["DONE", "FAIL"] as const) {
    test(`{§loop-response-messages} the live harness delivers the last SEND when ${terminal} concludes without a new message`, async () => {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse("```SEND\nFirst answer.\n```\n```NOTE\nContinue the work.\n```"),
            makeMockResponse("```SEND\nSecond answer.\n```\n```NOTE\nReview the outcome.\n```"),
            makeMockResponse(`\`\`\`${terminal}\n\`\`\``),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `live-response-${terminal}` });
                const result = await liveLoop({ db, ws }, 2, { prompt: "Answer in two parts.", maxTurns: 5 });
                assert.equal(result.finalStatus, terminal === "DONE" ? 200 : 499);
                assert.equal(result.lastContent, "Second answer.",
                    "the specimen evaluates the daemon's response: the last delivered message, not the terminal packet");
            } finally { ws.close(); }
        });
    });
}

test("{§loop-response-messages} the live harness does not invent an answer for blank DONE", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("```DONE\n```"),
    ] });
    await withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-response-silent" });
            const result = await liveLoop({ db, ws }, 2, { prompt: "What is the capital of France?" });
            assert.equal(result.finalStatus, 200);
            assert.equal(result.lastContent, "", "blank DONE delivers no response message");
        } finally { ws.close(); }
    });
});

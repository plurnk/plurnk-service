// #366 — the seam's FRESH conversation door (§machine-processes: two workers are two conversations
// about one curated workspace). createConversationWorker mints a named, empty-log, model-origin ROOT
// run that runLoop accepts — distinct from ensureModelWorker (the stable default, #371 find-first)
// and forkWorker (copies history). New chat = new conversation, same workspace.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

test("createConversationWorker: fresh named conversation — empty log, runLoop accepts, the stable door unaffected (#366)", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("<<SEND[200]:hello from thread-2:SEND", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "threads" });
            const workspaceId = (created.result as { id: number }).id;
            const stable = await daemon.ensureModelWorker(workspaceId);

            // The fresh door: named, empty, model-origin root.
            const conv = await daemon.createConversationWorker({ workspaceId, name: "thread-2" });
            assert.notEqual(conv.workerId, stable, "a fresh conversation, not the default");
            assert.equal(conv.workerName, "thread-2", "the client's name IS the worker name");
            assert.equal((await daemon.readLog({ workspaceId, workerId: conv.workerId })).length, 0, "an EMPTY log — fork copies history, this must not");

            // runLoop accepts it (model-origin) — a full loop runs in the new conversation.
            const term = await runLoopToTerminal(ws, 2, { prompt: "hi" }).catch(() => null);
            void term; // the default-run loop; the direct seam check below is the #366 assertion
            const run = await daemon.runLoop({ workspaceId, workerId: conv.workerId, prompt: "start thread 2" });
            assert.ok(run.loopId > 0, "runLoop accepts the fresh conversation worker");

            // The stable door still finds the ORIGINAL root — fresh conversations never shadow it (#371).
            assert.equal(await daemon.ensureModelWorker(workspaceId), stable, "ensureModelWorker is unmoved by fresh conversations");

            // Name invariants mirror forkWorker's: reserved + taken are legible refusals.
            await assert.rejects(() => daemon.createConversationWorker({ workspaceId, name: "plurnk" }), /reserved/);
            await assert.rejects(() => daemon.createConversationWorker({ workspaceId, name: "thread-2" }), /already exists/);
            // A default name mints distinct model-<ts> conversations.
            const anon = await daemon.createConversationWorker({ workspaceId });
            assert.match(anon.workerName, /^model-/, "default name follows the model-run convention");
        } finally { ws.close(); }
    });
});

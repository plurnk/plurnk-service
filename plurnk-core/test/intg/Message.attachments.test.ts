import assert from "node:assert/strict";
import test from "node:test";
import { OutboundModule } from "@plurnk/plurnk-a2a";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { startDemoAgent } from "../../../plurnk-a2a/test/fixtures/DemoAgent.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated } from "./_helpers.ts";
import { waitForDb } from "./_rpc.ts";

const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const next = "```NOTE\nDeliver selected resources.\n```";
const done = "```DONE\n```";

test("{§send-resource-attachments}: outbound A2A snapshots only selected resources and a failed source sends nothing", async () => {
    const remote = await startDemoAgent("direct-message");
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [
        turn(`\`\`\`EDIT (worker:///selected.md)\noriginal\n\`\`\`\n\`\`\`EDIT (worker:///private.md)\nunselected\n\`\`\`\n${next}`),
        turn(`\`\`\`SEND (a2a://peer) [{"attachments":["worker:///selected.md","worker:///missing.md"]}]\nDo not deliver a partial message.\n\`\`\`\n${next}`),
        turn(`\`\`\`SEND (a2a://peer) [{"attachments":["worker:///selected.md"]}]\nReview this.\n\`\`\`\n\`\`\`EDIT (worker:///selected.md) <1,-1>\nchanged\n\`\`\`\n${next}`),
        turn(done),
    ] });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_PEER: remote.baseUrl, PLURNK_A2A_ENABLED: '["peer"]' }));
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "message-export", projectRoot: null });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Send only the selected report." });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await waitForDb(() => lifecycle.status(started.loopId), (status) => status === 200 || status >= 400), 200);
        assert.equal(remote.executor.received.length, 1, "no dispatch occurs on partial acquisition failure");
        const parts = remote.executor.received[0]!.userMessage.parts;
        assert.equal(parts.length, 2, "the unselected resource was never exported");
        assert.deepEqual(parts[0]!.content, { $case: "text", value: "Review this." });
        assert.equal(parts[1]!.content?.$case, "raw");
        assert.equal(parts[1]!.filename, "selected.md");
        assert.equal(parts[1]!.mediaType, "text/markdown");
        assert.deepEqual(parts[1]!.content?.value, new Uint8Array(Buffer.from("original")));
        const rows = await daemon.readLog({ workspaceId, workerId, loopId: started.loopId });
        const failed = rows.filter((row) => row.op === "SEND" && row.status_rx === 404);
        assert.equal(failed.length, 1, "the source failure is a visible ordinary SEND failure");
        const packet = provider.received.at(-1)!.map(chatMessageText).join("\n");
        assert.match(packet, /"attachments":\[\{"name":"selected.md","mediaType":"text\/markdown","target":"worker:\/\/\/selected.md"\}\]/u);
    } finally {
        await daemon.stop();
        await db.close();
        await remote.close();
    }
});

test("{§send-resource-attachments}: worker SEND carries a snapshot as a normal readable resource", async () => {
    class Reader extends Mock {
        override async generate(...args: Parameters<Mock["generate"]>) {
            const response = await super.generate(...args);
            if (!response.assistant.content.includes("$RESOURCE")) return response;
            const packet = args[0].messages.map(chatMessageText).join("\n");
            const path = /<(worker:\/\/receiver\/attachments\/[^>]+)>/u.exec(packet)?.[1];
            assert.ok(path, "the peer gets an ordinary attachment link");
            return { ...response, assistant: { ...response.assistant, content: response.assistant.content.replace("$RESOURCE", path) } };
        }
    }
    const provider = new Reader({ contextWindow: 100_000, responses: [turn(`\`\`\`READ ($RESOURCE) <1,-1>\n\`\`\`\n${next}`), turn(done)] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "worker-attachments", projectRoot: null });
        const sender = await daemon.createConversationWorker({ workspaceId, name: "sender" });
        const receiver = await daemon.createConversationWorker({ workspaceId, name: "receiver" });
        const program = PlurnkParser.parseStatements('```EDIT (worker:///report.md)\noriginal peer report\n```\n```SEND (worker://receiver) [{"attachments":42}]\nDo not deliver invalid input.\n```\n```SEND (worker://receiver) [{"attachments":["worker:///report.md"]}]\nInspect this.\n```\n```EDIT (worker:///report.md) <1,-1>\nchanged\n```');
        assert.ok(program.items.every((item) => item.kind === "statement"));
        const results = await daemon.dispatchClientAction({ workspaceId, workerId: sender.workerId,
            statements: program.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []) });
        assert.deepEqual(results.map(({ status }) => status), [201, 400, 200, 200], JSON.stringify(results));
        assert.match(JSON.stringify(results[1]), /attachments-invalid/u, "SEND metadata reaches its recipient for validation");
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: receiver.workerId }), (loops) => loops.some((loop) => loop.status === 200));
        const received = await daemon.readMessages({ workspaceId, workerId: receiver.workerId });
        assert.equal(received.length, 1, "invalid SEND metadata is not discarded to deliver a different message");
        assert.equal(received[0]!.attachments.length, 1);
        assert.equal(Buffer.from(received[0]!.attachments[0]!.bytes).toString(), "original peer report");
        assert.match(provider.received[1]!.map(chatMessageText).join("\n"), /original peer report/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

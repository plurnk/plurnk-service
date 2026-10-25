import { serverProposals, TEST_OWNER } from "./_approval.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated } from "./_db.ts";
import { waitForDb } from "./_rpc.ts";
import { namedModelWorker } from "./_workers.ts";

const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const next = "````NOTE\nDeliver selected resources.\n````";
const done = "````SEND [200]\nAttachment handling verified.\n````";

test("{§send-resource-attachments}: worker SEND snapshots only selected resources and a failed source sends nothing", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [
        turn(`\`\`\`\`EDIT (worker:///selected.md)\noriginal\n\`\`\`\`\n\`\`\`\`EDIT (worker:///private.md)\nunselected\n\`\`\`\`\n${next}`),
        turn(`\`\`\`\`SEND (worker://receiver) [{"attachments":["worker:///selected.md","worker:///missing.md"]}]\nDo not deliver a partial message.\n\`\`\`\`\n${next}`),
        turn(`\`\`\`\`SEND (worker://receiver) [{"attachments":["worker:///selected.md"]}]\nReview this.\n\`\`\`\`\n\`\`\`\`EDIT (worker:///selected.md) <1,-1>\nchanged\n\`\`\`\`\n\`\`\`\`WAIT\n\`\`\`\``),
        turn(done),
        turn(done),
    ] });
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "message-export", projectRoot: null });
        const workerId = await namedModelWorker(daemon, workspaceId, "main");
        const receiver = await daemon.createWorker({ workspaceId, name: "receiver" });
        const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Send only the selected report." });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await waitForDb(() => lifecycle.status(started.loopId), (status) => status === 200 || status >= 400), 200);
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: receiver.workerId }), (loops) => loops.some((loop) => loop.status === 200));
        const received = (await daemon.readMessages({ workspaceId, workerId: receiver.workerId })).filter(({ direction }) => direction === "inbound");
        assert.equal(received.length, 1, "no dispatch occurs on partial acquisition failure");
        assert.match(received[0].body, /^Review this\.\n\n<worker:\/\/receiver\/attachments\/[^/]+\/selected\.md>$/u);
        assert.equal(received[0].attachments.length, 1, "the unselected resource was never exported");
        assert.equal(received[0].attachments[0].name, "selected.md");
        assert.equal(received[0].attachments[0].mediaType, "text/markdown");
        assert.equal(Buffer.from(received[0].attachments[0].bytes).toString(), "original");
        const rows = await daemon.readLog({ workspaceId, workerId, loopId: started.loopId });
        const failed = rows.filter((row) => row.op === "SEND" && row.status_rx === 404);
        assert.equal(failed.length, 1, "the source failure is a visible ordinary SEND failure");
        const senderPackets = provider.received.map((messages) => messages.map(chatMessageText).join("\n")).join("\n");
        assert.match(senderPackets, /"attachments":\[\{"name":"selected\.md","mediaType":"text\/markdown","path":"worker:\/\/\/selected\.md"\}\]/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

for (const body of ["Inspect this.", ""]) test(`{§send-resource-attachments}: ${body ? "text and attachment" : "attachment-only"} worker SEND carries a snapshot as a normal readable resource`, async () => {
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
    const provider = new Reader({ contextWindow: 100_000, responses: [turn(`\`\`\`\`READ ($RESOURCE) <1,-1>\n\`\`\`\`\n${next}`), turn(done)] });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "worker-attachments", projectRoot: null });
        const receiver = await daemon.createWorker({ workspaceId, name: "receiver" });
        const program = PlurnkParser.parseStatements([
            PlurnkParser.frame("EDIT (worker:///report.md)", "original peer report"),
            PlurnkParser.frame('SEND (worker://receiver) [{"attachments":42}]', "Do not deliver invalid input."),
            PlurnkParser.frame('SEND (worker://receiver) [{"attachments":["worker:///report.md"]}]', body),
            PlurnkParser.frame("EDIT (worker:///report.md) <1,-1>", "changed"),
        ].join("\n\n"));
        assert.ok(program.items.every((item) => item.kind === "statement"));
        // A person's operation sends to the worker ({§connection-lifecycle}).
        const results = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER,
            statements: program.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []) });
        assert.deepEqual(results.map(({ status }) => status), [201, 400, 200, 200], JSON.stringify(results));
        assert.match(JSON.stringify(results[1]), /attachments-invalid/u, "SEND metadata reaches its recipient for validation");
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: receiver.workerId }), (loops) => loops.some((loop) => loop.status === 200));
        const received = (await daemon.readMessages({ workspaceId, workerId: receiver.workerId })).filter(({ direction }) => direction === "inbound");
        assert.equal(received.length, 1, "invalid SEND metadata is not discarded to deliver a different message");
        assert.equal(received[0].attachments.length, 1);
        assert.equal(Buffer.from(received[0].attachments[0].bytes).toString(), "original peer report");
        assert.match(provider.received[1].map(chatMessageText).join("\n"), /original peer report/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

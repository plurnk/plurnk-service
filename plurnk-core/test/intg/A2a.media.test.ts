import assert from "node:assert/strict";
import test from "node:test";
import { OutboundModule } from "@plurnk/plurnk-a2a";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { startDemoAgent } from "../../../plurnk-a2a/test/fixtures/DemoAgent.ts";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import { buildPdf } from "../../../plurnk-mimetypes-application-pdf/src/buildPdf.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated } from "./_helpers.ts";
import { waitForDb } from "./_rpc.ts";
import { parseLogRecords } from "../LogRecords.ts";

process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
const task = "````NOTE\nInspect the received media.\n````";
const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

for (const media of [
    { modality: "image", bytes: png, mimetype: "image/png", filename: "screen.png" },
    { modality: "audio", bytes: wav(), mimetype: "audio/wav", filename: "clip.wav" },
    { modality: "pdf", bytes: Buffer.from(buildPdf({ title: "A2A evidence" })), mimetype: "application/pdf", filename: "report.pdf" },
] as const) {
for (const mode of ["complete", "direct-message"] as const) {
for (const supported of [true, false]) {
test(`{§a2a-part-resources}: ${mode}/${media.modality}/${supported ? "native" : "text"} survives remote retirement and log curation`, { timeout: 15_000 }, async () => {
    const agent = await startDemoAgent(mode, [
        { content: { $case: "text", value: "Inspect the attached evidence." }, mediaType: "text/plain", filename: "", metadata: {} },
        { content: { $case: "raw", value: media.bytes }, mediaType: media.mimetype, filename: media.filename, metadata: {} },
    ]);
    let closing: Promise<void> | undefined;
    const retire = () => closing ??= agent.close();
    let parent: string | undefined;
    let resource: string | undefined;
    class Reader extends Mock {
        override async generate(...args: Parameters<Mock["generate"]>) {
            const response = await super.generate(...args);
            const packet = args[0].messages.map(chatMessageText).join("\n");
            let content = response.assistant.content;
            if (content.includes("$PARENT")) {
                const pattern = mode === "complete"
                    ? /a2a:\/\/remote\/tasks\/[^\s"<>]+\/artifacts\/[^\s"<>]+/gu
                    : /a2a:\/\/remote\/messages\/[^\s"<>]+/gu;
                parent = [...packet.matchAll(pattern)].at(-1)?.[0];
                assert.ok(parent, `the A2A receipt identifies its retained parent resource:\n${packet}`);
                await retire();
                content = content.replace("$PARENT", parent);
            }
            if (content.includes("$RESOURCE")) {
                resource ??= [...packet.matchAll(/<(a2a:\/\/remote\/[^>\s]+\/resources\/[^>\s]+)>/gu)].at(-1)?.[1];
                assert.ok(resource, "the parent links to an ordinary binary resource, not a base64 placeholder");
                content = content.replace("$RESOURCE", resource);
            }
            return { ...response, assistant: { ...response.assistant, content } };
        }
    }
    const provider = new Reader({
        contextWindow: 1_000_000,
        inputModalities: supported ? [media.modality] : [],
        responses: [
            turn("````SEND (a2a://remote)\nProvide the evidence.\n````\n````WAIT\nAwait evidence.\n````"),
            turn(`\`\`\`\`READ ($PARENT) <1,-1>\n\`\`\`\`\n${task}`),
            turn(`\`\`\`\`READ ($RESOURCE) <1,3>\n\`\`\`\`\n${task}`),
            turn(task),
            turn(`\`\`\`\`KILL (log:///*/*/*/READ) <1,-1>\n\`\`\`\`\n${task}`),
            turn(`\`\`\`\`READ ($RESOURCE#bytes) <1,3>\n\`\`\`\`\n${task}`),
            turn("````SEND\n````"),
        ],
    });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(OutboundModule.init({
        PLURNK_A2A_REMOTE: agent.baseUrl,
        PLURNK_A2A_ENABLED: '["remote"]',
        PLURNK_A2A_CONNECT_TIMEOUT: "5000",
        PLURNK_A2A_REQUEST_TIMEOUT: "5000",
    }));
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "a2a-media", projectRoot: null });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const started = await daemon.runLoop({ workspaceId, workerId, prompt: "Inspect the remote evidence.", policy: { proposals: "accept" } });
        const lifecycle = new LoopLifecycle(db);
        const result = await waitForDb(() => lifecycle.status(started.loopId), (status) => status === 200 || status >= 400, { timeoutMs: 10_000 });
        assert.equal(result, 200, "ordinary A2A/READ/KILL operations complete");
        assert.equal(provider.received.length, 7);
        assert.ok(resource?.endsWith(`/resources/${media.filename}`));
        const parts = provider.received.map((messages) => messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
        assert.deepEqual(parts.slice(0, 3).map((items) => items.length), [0, 0, 0], "discovery and parent READ do not attach media");
        for (const index of [3, 4, 6]) {
            assert.equal(parts[index]!.length, Number(supported));
            if (supported) {
                assert.equal(parts[index]![0]!.mediaType, media.mimetype);
                assert.ok(Buffer.from(parts[index]![0]!.data).equals(media.bytes), "READ transmits the exact complete original bytes");
            }
        }
        assert.equal(parts[5]!.length, 0, "curating the READ removes the attachment from context");
        const restoredText = provider.received[6]!.map(chatMessageText).join("\n");
        const log = /(?:^|\n)## Log\n\n([\s\S]*?)(?=\n\n## |$)/u.exec(restoredText)?.[1];
        assert.ok(log, "the provider packet contains the materialized Log section");
        const restoredRead = parseLogRecords(log).find((row) => row.path === `${resource}#bytes`);
        assert.ok(restoredRead, "the reacquired source has an ordinary byte READ receipt");
        assert.equal(restoredRead.body, Array.from(media.bytes.subarray(0, 3), (byte, index) =>
            `${index + 1}:${byte.toString(16).padStart(2, "0")}\n`).join(""), "text-only and native routes expose the same exact selected octets");
        assert.ok(provider.received.every((messages) => !messages.map(chatMessageText).join("\n").includes(media.bytes.toString("base64"))), "base64 stays out of ordinary model text");
        const evidence = await daemon.readEntry({ workspaceId, workerId, target: parent!, channel: "json" });
        assert.equal(evidence.status, 200);
        assert.ok(evidence.entry !== null);
        assert.equal(JSON.parse(evidence.entry.channels.json!.content).parts[1].raw, media.bytes.toString("base64"), "exact A2A evidence survives offline and after curation");
    } finally {
        await daemon.stop();
        await db.close();
        await retire();
    }
});
}
}
}

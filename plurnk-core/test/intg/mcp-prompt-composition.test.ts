import { PlurnkParser } from "@plurnk/plurnk-parser";
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText, type InputModality } from "@plurnk/plurnk-providers";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated } from "./_helpers.ts";
import { waitForDb } from "./_rpc.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");
const turn = (content: string) => ({ assistant: { content, reasoning: null } });

class PromptReader extends Mock {
    resource: string | undefined;

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$RESOURCE")) return response;
        const packet = args[0].messages.map(chatMessageText).join("\n");
        this.resource = [...packet.matchAll(/"uri":\s*"(fixture:[^"]+\/resources\/[^"]+)"/gu)].at(-1)?.[1];
        return { ...response, assistant: { ...response.assistant,
            content: response.assistant.content.replace("$RESOURCE", this.resource ?? "fixture:///missing-resource"),
        } };
    }
}

for (const media of [
    { kind: "image", bytes: png, mimeType: "image/png", hex: /1:89\n2:50\n3:4e/u },
    { kind: "audio", bytes: wav(), mimeType: "audio/wav", hex: /1:52\n2:49\n3:46/u },
] as const) {
for (const modalities of [[media.kind], []] as InputModality[][]) {
    test(`MCP prompt ${media.kind} READ reaches ${modalities.length ? "native provider input" : "text-only fallback"} without injecting prompt roles`, { timeout: 20_000 }, async (t) => {
        let promptGets = 0;
        const served = await serveMcpHttp(t, createMcpHandler(() => {
            const server = new McpServer({ name: "prompt-media", version: "1" });
            server.registerPrompt("inspect", {}, async () => {
                promptGets += 1;
                return { messages: [
                    { role: "user", content: { type: "text", text: "Inspect the attached media." } },
                    { role: "assistant", content: { type: media.kind, data: media.bytes.toString("base64"), mimeType: media.mimeType } },
                ] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }));
        const provider = new PromptReader({ contextWindow: 1_000_000, inputModalities: modalities, responses: [
            turn(`\`\`\`READ (fixture:///prompts/inspect) <1,-1>\n\`\`\`\n\n${step("NOTE")}`),
            turn(`\`\`\`READ ($RESOURCE#bytes) <1,3>\n\`\`\`\n\n${step("NOTE")}`),
            turn(step("NOTE")),
            turn(step("SEND")),
        ] });
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules") });
        daemon.registerModule(McpModule.init({ env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
            PLURNK_MCP_FIXTURE: served.url, PLURNK_MCP_ENABLED: '["fixture"]',
        } }));
        let identity: { workspaceId: number; workerId: number } | undefined;
        try {
            await daemon.start();
            const { workspaceId } = await daemon.createWorkspace({ name: "mcp-prompt-media" });
            identity = { workspaceId, workerId: await daemon.ensureModelWorker(workspaceId) };
            const run = await daemon.runLoop({ ...identity, prompt: "Inspect the MCP prompt media.", policy: { proposals: "accept" } });
            const lifecycle = new LoopLifecycle(db);
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200, { timeoutMs: 10_000 });
            assert.equal(provider.received.length, 4);
            assert.match(provider.resource ?? "", /fixture:\/\/[^\s]*\/prompts\/inspect\/resources\/[a-f0-9]{8}$/u);
            assert.equal(promptGets, 1, "READ of a prompt's media snapshot never re-fetches the prompt");
            const texts = provider.received.map((messages) => messages.map(chatMessageText).join("\n"));
            assert.ok(texts.every((text) => !text.includes(media.bytes.toString("base64"))));
            assert.match(texts[1]!, /"role": "assistant"/u, "the supplied role remains visible as prompt data");
            assert.ok(provider.received.every((messages) => messages.every((message) => message.role !== "assistant")), "MCP roles are data, not new conversation messages");
            const parts = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.equal(parts[1]!.length, 0, "retrieving a prompt lists its media without attaching it");
            assert.equal(parts[2]!.length, modalities.length);
            assert.equal(parts[3]!.length, modalities.length, "native data follows the ordinary READ retention lifecycle");
            if (modalities.length) {
                assert.equal(parts[2]![0]!.mediaType, media.mimeType);
                assert.deepEqual(Buffer.from(parts[2]![0]!.data), media.bytes);
            }
            assert.match(texts[2]!, media.hex);
            const raw = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/prompts/inspect", scheme: "fixture", name: "json" });
            assert.equal(JSON.parse(raw?.content ?? "{}").messages[1].content.data, media.bytes.toString("base64"));
        } finally {
            if (identity !== undefined) await daemon.cancelWorker(identity);
            await daemon.stop();
            await db.close();
        }
    });
}
}

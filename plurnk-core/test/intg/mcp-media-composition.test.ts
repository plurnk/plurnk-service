import { PlurnkParser } from "@plurnk/plurnk-parser";
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { McpServer, createMcpHandler, fromJsonSchema, type ContentBlock } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Mock, chatMessageText, type InputModality } from "@plurnk/plurnk-providers";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated } from "./_helpers.ts";
import { waitForDb } from "./_rpc.ts";

process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");

class ResourceReader extends Mock {
    resource: string | undefined;
    beforeFirstRead: (() => void) | undefined;

    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$RESOURCE")) return response;
        const packet = args[0].messages.map(chatMessageText).join("\n");
        if (this.resource === undefined) this.beforeFirstRead?.();
        this.resource = [...packet.matchAll(/<(fixture:\/\/[^>\s]+)>/gu)].at(-1)?.[1];
        return {
            ...response,
            assistant: { ...response.assistant, content: response.assistant.content.replace("$RESOURCE", this.resource ?? "fixture:///missing-resource") },
        };
    }
}

for (const media of [
    { kind: "image", bytes: PNG, mimeType: "image/png", name: "screenshot.png", hex: /1:89\n2:50\n3:4e/u },
    { kind: "audio", bytes: wav(), mimeType: "audio/wav", name: "clip.wav", hex: /1:52\n2:49\n3:46/u },
] as const) {
for (const form of ["inline", "embedded", "link", "multipart"] as const) {
for (const modalities of [[media.kind], []] as InputModality[][]) {
    test(`{§mcp-result-content} {§packet-attachment-parts} ${media.kind}/${form}: MCP completion wakes; resource READ delivers ${modalities.length ? "native bytes" : "text only"}`, { timeout: 20_000 }, async (t) => {
        const release = Promise.withResolvers<void>();
        const called = Promise.withResolvers<void>();
        const uri = `fixture://media/${media.name}`;
        let resourceReads = 0;
        const content: ContentBlock[] = form === "inline"
            ? [{ type: media.kind, data: media.bytes.toString("base64"), mimeType: media.mimeType }]
            : form === "embedded"
                ? [{ type: "resource", resource: { uri, blob: media.bytes.toString("base64"), mimeType: media.mimeType } }]
                : [{ type: "resource_link", uri, name: media.name, mimeType: media.mimeType }];
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: "media-witness", version: "1.0.0" });
            server.registerResource("observation", uri, { mimeType: media.mimeType, cacheHint: { ttlMs: 60_000, cacheScope: "public" } }, async () => {
                resourceReads += 1;
                return { contents: [
                    ...(form === "multipart" ? [{ uri: "fixture://media/note.txt", mimeType: "text/plain", text: "Media attached." }] : []),
                    { uri, mimeType: media.mimeType, blob: media.bytes.toString("base64") },
                ] };
            });
            server.registerTool("observe", {
                inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
                annotations: { readOnlyHint: true },
            }, async () => {
                called.resolve();
                await release.promise;
                return { content };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
        const served = await serveMcpHttp(t, handler);
        const provider = new ResourceReader({ contextWindow: 1_000_000, inputModalities: modalities, responses: [
            turn(`\`\`\`fixture (observe)\n{}\n\`\`\`\n\n${step("WAIT")}`),
            ...(form === "multipart" ? [turn(`\`\`\`READ ($RESOURCE)\`\`\`\n\n${step("NOTE")}`)] : []),
            turn(`\`\`\`READ ($RESOURCE${form === "inline" || form === "link" ? "#bytes" : ""}) <1,3>\`\`\`\n\n${step("NOTE")}`),
            turn(step("NOTE")),
            turn(step("DONE")),
        ] });
        provider.beforeFirstRead = () => assert.equal(resourceReads, 0, "listing a resource link does not acquire its bytes");
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules") });
        daemon.registerModule(McpModule.init({ env: {
            PLURNK_MCP_CONNECT_TIMEOUT: "5000",
            PLURNK_MCP_REQUEST_TIMEOUT: "10000",
            PLURNK_MCP_FIXTURE: served.url,
            PLURNK_MCP_ENABLED: '["fixture"]',
            PLURNK_MCP_FIXTURE_READ: '["observe"]',
        } }));
        let identity: { workspaceId: number; workerId: number } | undefined;
        try {
            await daemon.start();
            const { workspaceId } = await daemon.createWorkspace({ name: "mcp-media-composition" });
            identity = { workspaceId, workerId: await daemon.ensureModelWorker(workspaceId) };
            const run = await daemon.runLoop({ ...identity, prompt: "Inspect the MCP media.", policy: { proposals: "accept" } });
            const lifecycle = new LoopLifecycle(db);
            await called.promise;
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 202, { timeoutMs: 5000 });
            assert.equal(provider.received.length, 1, "the worker really parked before the MCP response");
            release.resolve();
            await waitForDb(() => lifecycle.status(run.loopId), (status) => status === 200, { timeoutMs: 8000 });
            const delivered = form === "multipart" ? 3 : 2;
            assert.equal(provider.received.length, delivered + 2, "completion woke exactly the waiting loop");
            assert.ok(provider.resource, "the result exposes an ordinary resource address");
            if (form === "inline") assert.match(provider.resource, /\/resources\/[a-f0-9]{8}$/u);
            if (form === "embedded" || form === "multipart") assert.ok(provider.resource.endsWith(`/resources/${media.name}`), "a supplied name survives");
            const texts = provider.received.map((messages) => messages.map(chatMessageText).join("\n"));
            assert.ok(texts.every((text) => !text.includes(media.bytes.toString("base64"))), "base64 evidence does not flood the ordinary body");
            const parts = provider.received.map((messages) => messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
            assert.equal(parts[1]!.length, 0, "listing a resource does not attach it");
            assert.equal(parts[delivered]!.length, modalities.length, "only READ creates supported native delivery");
            if (modalities.length) {
                assert.equal(parts[delivered]![0]!.mediaType, media.mimeType);
                assert.deepEqual(Buffer.from(parts[delivered]![0]!.data), media.bytes, "a scoped READ delivers the complete original media");
            }
            assert.doesNotMatch(texts[delivered]!, /has been ejected from context/u);
            assert.equal(parts[delivered + 1]!.length, modalities.length, "later turns retain the READ's native content");
            if (modalities.length) assert.deepEqual(Buffer.from(parts[delivered + 1]![0]!.data), media.bytes);
            if (form === "inline" || form === "link") assert.match(texts[delivered]!, media.hex, "byte scope still returns exactly the selected octets");
            assert.equal(resourceReads, form === "inline" || form === "embedded" ? 0 : 1, "embedded content needs no refetch; resource reads use the standard MCP cache");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; status_rx: number }>({ loop_id: run.loopId });
            assert.ok(rows.some((row) => row.op === "READ" && row.pathname.includes("/resources/") && row.status_rx === 200), "resource READ succeeded through the dispatcher");
            const output = rows.find((row) => row.op === "READ" && /^\/[a-f0-9]{8}$/.test(row.pathname));
            assert.ok(output, "the default channel has a terminal stream observation");
            const evidence = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: output.pathname, scheme: "fixture", name: "json" });
            assert.ok(evidence, "the original protocol result has an independently addressable #json channel");
            assert.deepEqual(JSON.parse(evidence.content).content, content, "the complete original protocol content remains in #json");
        } finally {
            release.resolve();
            if (identity !== undefined) await daemon.cancelWorker(identity);
            await daemon.stop();
            await db.close();
        }
    });
}
}
}

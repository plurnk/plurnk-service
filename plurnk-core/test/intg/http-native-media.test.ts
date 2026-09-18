import { PlurnkParser } from "@plurnk/plurnk-parser";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Mock, chatMessageText, type InputModality } from "@plurnk/plurnk-providers";
import { buildPdf } from "../../../plurnk-mimetypes-application-pdf/src/buildPdf.ts";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import { connect, rpcCall, waitForDb, withDaemon } from "./_rpc.ts";

process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = '["task"]';
process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "");
const media = [
    { kind: "image", mimetype: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), facts: /PNG image/u },
    { kind: "pdf", mimetype: "application/pdf", bytes: Buffer.from(buildPdf({ title: "Contract" })), facts: /PDF document/u },
    { kind: "audio", mimetype: "audio/wav", bytes: wav(), facts: /WAVE audio/u },
] as const;

const run = async (provider: Mock) => withDaemon(provider, async (db, _daemon, addr) => {
    const client = await connect(addr);
    try {
        await rpcCall(client, 1, "workspace.create", { name: "http-media" });
        const result = await rpcCall(client, 2, "loop.run", { prompt: "Inspect HTTP media.", policy: { proposals: "accept" } });
        const loopId = (result.result as { loopId: number }).loopId;
        await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20000 });
    } finally { client.close(); }
});

for (const sample of media) {
for (const enabled of [true, false]) {
    test(`{§http-binary-source} ${sample.kind} HTTP source/readable/bytes READs deliver ${enabled ? "native media" : "text only"}`, async (t) => {
        const requests: string[] = [];
        const server = createServer((req, res) => {
            requests.push(`${req.method} ${req.url}`);
            if (req.url !== "/media") { res.writeHead(404).end(); return; }
            res.writeHead(200, { "content-type": sample.mimetype, "cache-control": "max-age=600", etag: '"media-v1"' });
            res.end(sample.bytes);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/media`;
        const provider = new Mock({ contextWindow: 100_000, inputModalities: enabled ? [sample.kind as InputModality] : [], responses: [
            turn(`\`\`\`READ (${url}) <1,3>\`\`\`\n${step()}`),
            turn(`\`\`\`READ (${url}#readable)\`\`\`\n${step()}`),
            turn(`\`\`\`READ (${url}#bytes) <2,3>\`\`\`\n${step()}`),
            turn(`\`\`\`READ (${url}#header)\`\`\`\n${step()}`),
            turn(step("SEND")),
        ] });
        await run(provider);
        const parts = provider.received.map((messages) => messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
        assert.deepEqual(parts.map((files) => files.length), enabled ? [0, 1, 2, 3, 3] : [0, 0, 0, 0, 0],
            provider.received.at(-1)!.map(chatMessageText).join("\n").split("\n").filter((line) => line.includes('"overflow"') || line.startsWith('{"path":"http://')).join("\n"));
        for (const part of parts.flat()) {
            assert.equal(part.mediaType, sample.mimetype);
            assert.ok(Buffer.from(part.data).equals(sample.bytes), "HTTP native input preserves the exact source bytes");
        }
        const text = provider.received.map((messages) => messages.map(chatMessageText).join("\n"));
        assert.match(text[1]!, new RegExp(`1:${sample.bytes[0]!.toString(16).padStart(2, "0")}\\n2:`));
        assert.match(text[1]!, /"#readable":\d+/u, "the source READ advertises its readable projection");
        assert.match(text[2]!, sample.facts);
        assert.equal(requests.filter((value) => value === "GET /media").length, 1, "cached projections reuse the complete source");
    });
}
}

test("{§http-binary-source} 304 revalidation preserves bytes and later replacement leaves prior native observations intact", async (t) => {
    const original = wav();
    const updated = Buffer.from(original);
    updated.writeInt16LE(1000, 44);
    const validators: Array<string | undefined> = [];
    const server = createServer((req, res) => {
        if (req.url !== "/sound.wav") { res.writeHead(404).end(); return; }
        validators.push(req.headers["if-none-match"]);
        if (validators.length === 2) {
            res.writeHead(304, { etag: '"v1"', "cache-control": "no-cache" }).end();
            return;
        }
        res.writeHead(200, { "content-type": "audio/wav", etag: validators.length === 1 ? '"v1"' : '"v2"', "cache-control": "no-cache" });
        res.end(validators.length === 1 ? original : updated);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/sound.wav`;
    const provider = new Mock({ contextWindow: 100_000, inputModalities: ["audio"], responses: [
        turn(`\`\`\`READ (${url}) <1,2>\`\`\`\n${step()}`),
        turn(`\`\`\`READ (${url}#readable)\`\`\`\n${step()}`),
        turn(`\`\`\`READ (${url}#bytes) <1,2>\`\`\`\n${step()}`),
        turn(step("SEND")),
    ] });
    await run(provider);
    assert.deepEqual(validators, [undefined, '"v1"', '"v1"']);
    const files = provider.received.at(-1)!.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []);
    const expected = [original, original, updated];
    assert.equal(files.length, expected.length);
    for (const [index, part] of files.entries()) {
        assert.ok(Buffer.from(part.data).equals(expected[index]!), `observation ${index + 1} retains its exact source version`);
    }
    assert.ok(files.every((part) => part.mediaType === "audio/wav"));
});

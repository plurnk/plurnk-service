import { PlurnkParser } from "@plurnk/plurnk-parser";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http, { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { syncAmbientHttp } from "@plurnk/plurnk-meta";
import { ModelProvider, Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { Http, WebFetcher, Ws } from "@plurnk/plurnk-schemes-http";
import type { SchemeHandler } from "@plurnk/plurnk-schemes";
import { buildPdf } from "../../../plurnk-mimetypes-application-pdf/test/buildPdf.ts";
import { wav } from "../../../plurnk-mimetypes-audio/test/wav.ts";
import ServerConnection from "../../../plurnk-mcp/src/client.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { serverProposals } from "./_approval.ts";
import { openMigrated, seedEnvelope, seedEntryWithChannel } from "./_db.ts";
import { connect, rpcCall, waitForDb, withDaemon } from "./_rpc.ts";

process.env.PLURNK_MEMBERS_task = "**";
process.env.PLURNK_MEMBERS_ENABLED = "1";
process.env.PLURNK_SCHEMES_HTTP_TTL_MS = "60000";
const turn = (content: string) => ({ assistant: { content, reasoning: null } });
const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "Media inspection complete.");
const media = [
    { kind: "image", mimetype: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), facts: /PNG image/u },
    { kind: "pdf", mimetype: "application/pdf", bytes: Buffer.from(buildPdf({ title: "Contract" })), facts: /PDF document/u },
    { kind: "audio", mimetype: "audio/wav", bytes: wav(), facts: /WAVE audio/u },
] as const;

const run = async (provider: Mock) => withDaemon(provider, async (db, _daemon, addr) => {
    const client = await connect(addr);
    try {
        await rpcCall(client, 1, "workspace.create", { name: "http-media" });
        const result = await rpcCall(client, 2, "loop.run", { prompt: "Inspect HTTP media." });
        const loopId = (result.result as { loopId: number }).loopId;
        await waitForDb(() => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }), (row) => row?.status === 200, { timeoutMs: 20000 });
    } finally { client.close(); }
});

for (const sample of media) {
for (const enabled of [true, false]) {
    test(`{§http-lifecycle} ${sample.kind} HTTP source/readable/bytes READs deliver ${enabled ? "native media" : "text only"}`, async (t) => {
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
        const provider = new Mock({ contextWindow: 100_000, inputModalities: enabled ? [sample.kind] : [], responses: [
            turn(`\`\`\`\`READ (${url}) <1,3>\`\`\`\`\n${step()}`),
            turn(`\`\`\`\`READ (${url}#readable)\`\`\`\`\n${step()}`),
            turn(`\`\`\`\`READ (${url}#bytes) <2,3>\`\`\`\`\n${step()}`),
            turn(`\`\`\`\`READ (${url}#header)\`\`\`\`\n${step()}`),
            turn(step("SEND [200]")),
        ] });
        await run(provider);
        const parts = provider.received.map((messages) => messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
        assert.deepEqual(parts.map((files) => files.length), enabled ? [0, 1, 2, 3, 3] : [0, 0, 0, 0, 0],
            provider.received.at(-1)!.map(chatMessageText).join("\n").split("\n").filter((line) => line.includes('"overflow"') || /^### log:\/\/\/\S+\/READ \(http:\/\//.test(line)).join("\n"));
        for (const part of parts.flat()) {
            assert.equal(part.mediaType, sample.mimetype);
            assert.ok(Buffer.from(part.data).equals(sample.bytes), "HTTP native input preserves the exact source bytes");
        }
        const text = provider.received.map((messages) => messages.map(chatMessageText).join("\n"));
        assert.match(text[1], new RegExp(`1:${sample.bytes[0].toString(16).padStart(2, "0")}\\n2:`));
        assert.match(text[1], /"#readable":\d+/u, "the source READ advertises its readable projection");
        assert.match(text[2], sample.facts);
        assert.equal(requests.filter((value) => value === "GET /media").length, 1, "cached projections reuse the complete source");
    });
}
}

test("{§http-lifecycle} 304 revalidation preserves bytes and later replacement leaves prior native observations intact", async (t) => {
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
        turn(`\`\`\`\`READ (${url}) <1,2>\`\`\`\`\n${step()}`),
        turn(`\`\`\`\`READ (${url}#readable)\`\`\`\`\n${step()}`),
        turn(`\`\`\`\`READ (${url}#bytes) <1,2>\`\`\`\`\n${step()}`),
        turn(step("SEND [200]")),
    ] });
    await run(provider);
    assert.deepEqual(validators, [undefined, '"v1"', '"v1"']);
    const files = provider.received.at(-1)!.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []);
    const expected = [original, original, updated];
    assert.equal(files.length, expected.length);
    for (const [index, part] of files.entries()) {
        assert.ok(Buffer.from(part.data).equals(expected[index]), `observation ${index + 1} retains its exact source version`);
    }
    assert.ok(files.every((part) => part.mediaType === "audio/wav"));
});

const statement = (header: string) => {
    const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(header, null));
    assert.equal(parsed.items.length, 1);
    const item = parsed.items[0];
    assert.ok(item?.kind === "statement");
    return item.statement;
};

test("{§scheme-operation-dispatch}: KILL receives the authored statement and bound resource capabilities", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `scheme-kill-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    const requested = statement('KILL (owned://bucket/notes) <1,-1> [{"mode":"local"}] <!-- remove -->');
    let invoked = false;
    schemes.register("owned", {
        manifest: { name: "owned", authority: "resource", channels: { body: "text/plain" }, defaultChannel: "body", category: "data", writableBy: ["model"], volatile: false, modelVisible: true, metadataModifier: true },
        async kill(received, ctx) {
            assert.deepEqual(received, requested, "all authored KILL fields reach the owner");
            assert.equal(ctx.workspaceId, env.workspaceId);
            assert.equal(ctx.sessionId, env.sessionId);
            assert.equal(ctx.writer, "model");
            const prior = await ctx.entries.read("/notes");
            assert.equal(prior.entry?.channels.body.content, "selected namespace");
            invoked = true;
            return ctx.entries.delete("/notes");
        },
    } satisfies SchemeHandler);
    const engine = new Engine({ db, schemes });
    try {
        await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: "owned", authority: "bucket", pathname: "/notes", content: "selected namespace" });
        await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: "owned", pathname: "/notes", content: "other namespace" });
        const result = await engine.dispatch({ ...env, statement: requested, sequence: 1, origin: "model" });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(invoked, true);
        const survivor = await engine.dispatch({ ...env, statement: statement("READ (owned:///notes)"), sequence: 2, origin: "model" });
        assert.equal(survivor.content, "other namespace");
        const deleted = await engine.dispatch({ ...env, statement: statement("READ (owned://bucket/notes)"), sequence: 3, origin: "model" });
        assert.equal(deleted.status, 404);
    } finally {
        await schemes.close();
        await db.close();
    }
});

for (const protocol of ["https", "http"]) {
    test(`{§revalidation}: dispatched ${protocol} KILL separates local deletion from explicit remote DELETE`, async (t) => {
        serverProposals(t, "accept");
        const db = await openMigrated();
        const env = await seedEnvelope(db, `http-kill-${crypto.randomUUID()}`, {});
        const schemes = new SchemeRegistry();
        schemes.register("https", new Http());
        const engine = new Engine({ db, schemes });
        const requests: Array<{ method: string; condition: string | null; url: string }> = [];
        t.mock.method(globalThis, "fetch", async (url: URL | string, init?: RequestInit) => {
            requests.push({ method: init?.method ?? "GET", condition: new Headers(init?.headers).get("if-match"), url: String(url) });
            return new Response(null, { status: 204 });
        });
        try {
            const target = `${protocol}://93.184.216.34/record?revision=7`;
            await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: protocol, authority: "93.184.216.34", pathname: "/record?revision=7", content: "stored response" });
            const local = await engine.dispatch({ ...env, statement: statement(`KILL (${target})`), sequence: 1, origin: "model" });
            assert.equal(local.status, 200, JSON.stringify(local));
            assert.deepEqual(requests, [], "forgetting a response cannot perform a remote mutation");
            const repeated = await engine.dispatch({ ...env, statement: statement(`KILL (${target})`), sequence: 2, origin: "model" });
            assert.equal(repeated.status, 404, "the local representation was actually removed");
            const remote = await engine.dispatch({ ...env, statement: statement(`KILL (${target}) [{"remote":true,"If-Match":"revision-7"}]`), sequence: 3, origin: "model" });
            assert.equal(remote.status, 102, JSON.stringify(remote));
            assert.deepEqual(requests, [{ method: "DELETE", condition: "revision-7", url: target }]);
        } finally {
            await schemes.close();
            await db.close();
        }
    });
}

for (const protocol of ["wss", "ws"]) {
    test(`{§ws-lifecycle}: dispatched ${protocol} KILL closes the socket and settles its durable subscription`, async () => {
        const db = await openMigrated();
        const env = await seedEnvelope(db, `ws-kill-${crypto.randomUUID()}`);
        const schemes = new SchemeRegistry();
        const handlers = new Map<string, (event: { code?: number; reason?: string }) => void>();
        const closed: Array<{ code?: number; reason?: string }> = [];
        schemes.register("wss", new Ws(() => {
            setImmediate(() => handlers.get("open")?.({}));
            return {
                readyState: 1,
                addEventListener: (name, listener) => { handlers.set(name, listener); },
                send: () => { throw new Error("KILL does not send socket data"); },
                close: (code, reason) => {
                    closed.push({ code, reason });
                    handlers.get("close")?.({ code, reason });
                },
            };
        }));
        const engine = new Engine({ db, schemes });
        try {
            const target = `${protocol}://93.184.216.34/feed`;
            const opened = await engine.dispatch({ ...env, statement: statement(`READ (${target})`), sequence: 1, origin: "model" });
            assert.equal(opened.status, 102, JSON.stringify(opened));
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: protocol, pathname: "/feed" });
            assert.ok(entry);
            const live = await db.test_get_subscription_by_entry.get<{ closed_at: string | null }>({ session_id: env.sessionId, entry_id: entry.id });
            assert.equal(live?.closed_at, null);
            const killed = await engine.dispatch({ ...env, statement: statement(`KILL (${target})`), sequence: 2, origin: "model" });
            assert.equal(killed.status, 200, JSON.stringify(killed));
            assert.deepEqual(closed, [{ code: 1000, reason: "killed" }]);
            await schemes.close();
            const terminal = await db.test_get_subscription_by_entry.get<{ close_status: number; closed_at: string | null }>({ session_id: env.sessionId, entry_id: entry.id });
            assert.equal(terminal?.close_status, 200, "an opened socket's normal close is a successful terminal result");
            assert.ok(terminal?.closed_at);
        } finally {
            await schemes.close();
            await db.close();
        }
    });
}

const execFileAsync = promisify(execFile);
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"] as const;

const withCleanProxyEnv = async (fn: () => Promise<void>): Promise<void> => {
    const saved = new Map<string, string | undefined>();
    for (const key of PROXY_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
    syncAmbientHttp();
    try {
        await fn();
    } finally {
        for (const key of PROXY_KEYS) {
            const val = saved.get(key);
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
        syncAmbientHttp();
    }
};

test("{§ambient-http-transport}: WebFetcher, ModelProvider, and MCP streamable-http honor HTTPS_PROXY, NO_PROXY, and NODE_EXTRA_CA_CERTS", async () => {
    await withCleanProxyEnv(async () => {
        const dir = mkdtempSync(join(tmpdir(), "plurnk-intg-ambient-http-"));
        const keyPath = join(dir, "key.pem");
        const certPath = join(dir, "cert.pem");
        await execFileAsync("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", keyPath, "-out", certPath,
            "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ]);
        const key = readFileSync(keyPath, "utf8");
        const cert = readFileSync(certPath, "utf8");

        const mcpHandler = createMcpHandler(() => {
            const server = new McpServer({ name: "proxy-witness", version: "1.0.0" });
            server.registerResource("doc", "fixture://doc", {}, async () => ({
                contents: [{ uri: "fixture://doc", mimeType: "text/plain", text: "mcp-via-proxy" }],
            }));
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });

        const httpsOrigin = https.createServer({ key, cert }, (req, res) => {
            void (async () => {
                if (req.url === "/page") {
                    res.writeHead(200, { "content-type": "text/plain" });
                    res.end("web-read-via-proxy");
                    return;
                }
                if (req.url === "/v1/chat/completions") {
                    for await (const _chunk of req) { /* drain */ }
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    res.write(`data: ${JSON.stringify({
                        id: "chatcmpl-1",
                        object: "chat.completion.chunk",
                        created: 1,
                        model: "fixture",
                        choices: [{ index: 0, delta: { role: "assistant", content: "provider-via-proxy" }, finish_reason: null }],
                    })}\n\n`);
                    res.write(`data: ${JSON.stringify({
                        id: "chatcmpl-1",
                        object: "chat.completion.chunk",
                        created: 1,
                        model: "fixture",
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                    })}\n\ndata: [DONE]\n\n`);
                    res.end();
                    return;
                }
                if (req.url?.startsWith("/mcp")) {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    const body = Buffer.concat(chunks);
                    const request = new Request(new URL(req.url, `https://${req.headers.host}`).href, {
                        method: req.method,
                        headers: req.headers as HeadersInit,
                        ...(body.length === 0 ? {} : { body: body.toString("utf8") }),
                    });
                    const response = await mcpHandler.fetch(request);
                    res.writeHead(response.status, Object.fromEntries(response.headers));
                    if (response.body !== null) {
                        for await (const chunk of response.body) res.write(Buffer.from(chunk));
                    }
                    res.end();
                    return;
                }
                res.writeHead(404).end();
            })();
        });
        await new Promise<void>((resolve) => httpsOrigin.listen(0, "127.0.0.1", resolve));
        const originPort = (httpsOrigin.address() as net.AddressInfo).port;
        const originBase = `https://127.0.0.1:${originPort}`;

        let proxyConnectCount = 0;
        const proxy = http.createServer((_req, res) => { res.writeHead(502).end(); });
        proxy.on("connect", (req, clientSocket, head) => {
            proxyConnectCount += 1;
            const [host, portStr] = (req.url ?? "").split(":");
            const upstream = net.connect(Number(portStr), host, () => {
                clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length > 0) upstream.write(head);
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            });
            upstream.on("error", () => clientSocket.destroy());
            clientSocket.on("error", () => upstream.destroy());
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        const proxyPort = (proxy.address() as net.AddressInfo).port;

        try {
            process.env.NODE_EXTRA_CA_CERTS = certPath;
            process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;

            const webFetcher = new WebFetcher();
            const webResult = await webFetcher.fetch(`${originBase}/page`, { guarded: false });
            assert.ok(webResult !== null && !("originUnavailable" in webResult));
            assert.equal(typeof webResult.body === "string" ? webResult.body : await webResult.body.text(), "web-read-via-proxy");
            assert.ok(proxyConnectCount >= 1, "WebFetcher routed through HTTPS_PROXY");

            const countBeforeProvider = proxyConnectCount;
            const provider = new ModelProvider({
                model: "fixture",
                url: `${originBase}/v1/chat/completions`,
                contextWindow: 100_000,
                fetchTimeoutMs: 5000,
                operationTimeoutMs: 5000,
                temperature: null,
                repeatPenalty: null,
                retryAttempts: 0,
                effort: { mode: "off", budget: null },
            });
            const gen = await provider.generate({
                sessionId: "s-1",
                messages: [{ role: "user", content: "hi" }],
                signal: new AbortController().signal,
            });
            assert.equal(gen.assistant.content, "provider-via-proxy");
            assert.ok(proxyConnectCount > countBeforeProvider, "ModelProvider routed through HTTPS_PROXY");

            const countBeforeMcp = proxyConnectCount;
            const mcpConn = new ServerConnection({
                name: "remote",
                type: "streamable-http",
                url: `${originBase}/mcp`,
            });
            try {
                const catalog = await mcpConn.catalog();
                assert.equal(catalog.resources.length, 1);
                assert.equal(catalog.resources[0]?.uri, "fixture://doc");
                assert.ok(proxyConnectCount > countBeforeMcp, "MCP streamable-http routed through HTTPS_PROXY");
            } finally {
                await mcpConn.close();
            }

            process.env.NO_PROXY = "127.0.0.1";
            const countBeforeNoProxy = proxyConnectCount;
            const directWeb = await webFetcher.fetch(`${originBase}/page`, { guarded: false });
            assert.ok(directWeb !== null && !("originUnavailable" in directWeb));
            assert.equal(typeof directWeb.body === "string" ? directWeb.body : await directWeb.body.text(), "web-read-via-proxy");
            assert.equal(proxyConnectCount, countBeforeNoProxy, "NO_PROXY bypassed HTTPS_PROXY");
        } finally {
            await mcpHandler.close();
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            await new Promise<void>((resolve) => httpsOrigin.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

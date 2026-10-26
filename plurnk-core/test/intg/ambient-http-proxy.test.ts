import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { syncAmbientHttp } from "@plurnk/plurnk-meta";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import { WebFetcher } from "@plurnk/plurnk-schemes-http";
import ServerConnection from "../../../plurnk-mcp/src/client.ts";

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

test("{§ambient-http-transport}: WebFetcher, AiSdkProvider, and MCP streamable-http honor HTTPS_PROXY, NO_PROXY, and NODE_EXTRA_CA_CERTS", async () => {
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

            // 1. Web read (WebFetcher) through HTTPS_PROXY + NODE_EXTRA_CA_CERTS
            const webFetcher = new WebFetcher();
            const webResult = await webFetcher.fetch(`${originBase}/page`, { guarded: false });
            assert.ok(webResult !== null && !("originUnavailable" in webResult));
            assert.equal(typeof webResult.body === "string" ? webResult.body : await webResult.body.text(), "web-read-via-proxy");
            assert.ok(proxyConnectCount >= 1, "WebFetcher routed through HTTPS_PROXY");

            // 2. Provider request (AiSdkProvider) through HTTPS_PROXY + NODE_EXTRA_CA_CERTS
            const countBeforeProvider = proxyConnectCount;
            const provider = new AiSdkProvider({
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
            assert.ok(proxyConnectCount > countBeforeProvider, "AiSdkProvider routed through HTTPS_PROXY");

            // 3. MCP streamable-http (ServerConnection) through HTTPS_PROXY + NODE_EXTRA_CA_CERTS
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

            // 4. NO_PROXY bypasses the proxy while keeping NODE_EXTRA_CA_CERTS active
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

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { outboundFetch, syncAmbientHttp } from "./outbound-http.ts";

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

test("{§ambient-http-transport}: HTTP_PROXY, HTTPS_PROXY, NO_PROXY and NODE_EXTRA_CA_CERTS govern outboundFetch and restore cleanly when unset", async () => {
    await withCleanProxyEnv(async () => {
        const dir = mkdtempSync(join(tmpdir(), "plurnk-ambient-http-"));
        const keyPath = join(dir, "key.pem");
        const certPath = join(dir, "cert.pem");
        await execFileAsync("openssl", [
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", keyPath, "-out", certPath,
            "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ]);
        const key = await import("node:fs/promises").then((fs) => fs.readFile(keyPath, "utf8"));
        const cert = await import("node:fs/promises").then((fs) => fs.readFile(certPath, "utf8"));

        const httpsOrigin = https.createServer({ key, cert }, (_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("origin-https-ok");
        });
        await new Promise<void>((resolve) => httpsOrigin.listen(0, "127.0.0.1", resolve));
        const originPort = (httpsOrigin.address() as net.AddressInfo).port;

        let proxyConnectCount = 0;
        let proxyHttpCount = 0;
        const proxy = http.createServer((req, res) => {
            proxyHttpCount += 1;
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(`proxied:${req.url}`);
        });
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
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;

        try {
            // 1. Without NODE_EXTRA_CA_CERTS, self-signed HTTPS fails TLS verification.
            await assert.rejects(outboundFetch(`https://127.0.0.1:${originPort}/hello`));

            // 2. With NODE_EXTRA_CA_CERTS and HTTPS_PROXY, HTTPS tunnels through the proxy and verifies TLS.
            process.env.NODE_EXTRA_CA_CERTS = certPath;
            process.env.HTTPS_PROXY = proxyUrl;
            const proxiedRes = await outboundFetch(`https://127.0.0.1:${originPort}/hello`);
            assert.equal(proxiedRes.status, 200);
            assert.equal(await proxiedRes.text(), "origin-https-ok");
            assert.equal(proxyConnectCount, 1);

            // 3. NO_PROXY bypasses the proxy while keeping NODE_EXTRA_CA_CERTS active.
            process.env.NO_PROXY = "127.0.0.1";
            const bypassedRes = await outboundFetch(`https://127.0.0.1:${originPort}/hello`);
            assert.equal(bypassedRes.status, 200);
            assert.equal(await bypassedRes.text(), "origin-https-ok");
            assert.equal(proxyConnectCount, 1, "NO_PROXY bypassed the CONNECT proxy");

            // 4. Lowercase http_proxy routes plain HTTP requests.
            delete process.env.NO_PROXY;
            delete process.env.HTTPS_PROXY;
            process.env.http_proxy = proxyUrl;
            const httpRes = await outboundFetch(`http://127.0.0.1:${originPort}/plain`);
            assert.equal(httpRes.status, 200);
            assert.equal(await httpRes.text(), `proxied:http://127.0.0.1:${originPort}/plain`);
            assert.equal(proxyHttpCount, 1);

            // 5. Clearing NODE_EXTRA_CA_CERTS restores the default trust store.
            delete process.env.http_proxy;
            delete process.env.NODE_EXTRA_CA_CERTS;
            await assert.rejects(outboundFetch(`https://127.0.0.1:${originPort}/hello`));
        } finally {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            await new Promise<void>((resolve) => httpsOrigin.close(() => resolve()));
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

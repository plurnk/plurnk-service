import assert from "node:assert/strict";
import http from "node:http";
import test, { describe } from "node:test";
import LocalModelProbe from "./LocalModelProbe.ts";
import { OperationFailureError } from "./results.ts";

describe("LocalModelProbe", () => {
    test("{§operator-config-precedence}: discovers Ollama and llama-server loopback candidates and deduplicates entries", async (t) => {
        const ollamaServer = http.createServer((req, res) => {
            if (req.url === "/api/tags") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    models: [{ name: "qwen3:8b" }, { name: "qwen3:8b" }, { name: "gemma3:4b" }],
                }));
                return;
            }
            res.writeHead(404).end();
        });
        const llamaServer = http.createServer((req, res) => {
            if (req.url === "/v1/models") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    data: [{ id: "Qwen3.5-9B-GGUF" }, { id: "Qwen3.5-9B-GGUF" }],
                }));
                return;
            }
            res.writeHead(404).end();
        });
        await new Promise<void>((resolve) => ollamaServer.listen(0, "127.0.0.1", () => resolve()));
        await new Promise<void>((resolve) => llamaServer.listen(0, "127.0.0.1", () => resolve()));
        t.after(() => {
            ollamaServer.close();
            llamaServer.close();
        });
        const ollamaAddr = ollamaServer.address();
        const llamaAddr = llamaServer.address();
        assert.ok(ollamaAddr !== null && typeof ollamaAddr === "object");
        assert.ok(llamaAddr !== null && typeof llamaAddr === "object");
        const ollamaOrigin = `http://127.0.0.1:${ollamaAddr.port}`;
        const llamaOrigin = `http://127.0.0.1:${llamaAddr.port}`;

        const result = await LocalModelProbe.discover({
            ollamaOrigin,
            llamaServerOrigin: llamaOrigin,
            env: { PLURNK_SERVICE_LOCAL_PROBE_TIMEOUT_MS: "1500" },
        });
        assert.equal(result.candidates.length, 3);
        assert.deepEqual(result.candidates[0], {
            runtime: "ollama",
            label: `Local Ollama (qwen3:8b at ${ollamaOrigin})`,
            alias: "local",
            selector: "ollama/qwen3:8b",
            origin: ollamaOrigin,
            baseUrl: ollamaOrigin,
        });
        assert.equal(result.candidates[1]?.selector, "ollama/gemma3:4b");
        assert.deepEqual(result.candidates[2], {
            runtime: "llama-server",
            label: `Local llama-server (Qwen3.5-9B-GGUF at ${llamaOrigin})`,
            alias: "local",
            selector: "openai/Qwen3.5-9B-GGUF",
            origin: llamaOrigin,
            baseUrl: `${llamaOrigin}/v1`,
        });
    });

    test("{§operator-config-precedence}: omits baseUrl when Ollama responds on its standard 11434 loopback origin and degrades cleanly on network failure", async () => {
        const result = await LocalModelProbe.discover({
            env: { PLURNK_SERVICE_LOCAL_PROBE_TIMEOUT_MS: "1500" },
            fetch: async (input) => {
                const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
                if (url === "http://127.0.0.1:11434/api/tags") {
                    return new Response(JSON.stringify({ models: [{ name: "llama3.3" }] }), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    });
                }
                throw new Error("ECONNREFUSED");
            },
        });
        assert.deepEqual(result.candidates, [
            {
                runtime: "ollama",
                label: "Local Ollama (llama3.3 at http://127.0.0.1:11434)",
                alias: "local",
                selector: "ollama/llama3.3",
                origin: "http://127.0.0.1:11434",
            },
        ]);
    });

    test("{§operator-config-precedence}: refuses non-loopback, credential-bearing, path-bearing, or malformed origins", async () => {
        const env = { PLURNK_SERVICE_LOCAL_PROBE_TIMEOUT_MS: "1500" };
        for (const bad of [
            "http://192.168.1.50:11434",
            "https://example.com",
            "http://user:pass@127.0.0.1:11434",
            "http://127.0.0.1:11434/subpath",
            "http://127.0.0.1:11434?x=1",
            "ftp://127.0.0.1:11434",
            "not-a-url",
        ]) {
            await assert.rejects(
                () => LocalModelProbe.discover({ ollamaOrigin: bad, env }),
                (err: unknown) => {
                    if (!(err instanceof OperationFailureError)) return false;
                    const type = err.result.problem?.type ?? "";
                    return (
                        err.result.status === 400 &&
                        (type.endsWith("/non-loopback-origin") || type.endsWith("/invalid-probe-origin"))
                    );
                },
                `expected refusal for ${bad}`,
            );
        }
    });
});

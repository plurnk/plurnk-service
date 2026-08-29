import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import path from "node:path";
import { assertEmbeddingConformance } from "./test/conformance.js";

const pexec = promisify(execFile);
const indexPath = path.join(import.meta.dirname, "index.js");
const nodeEvalArgs = (source) => ["--conditions=plurnk-dev", "--input-type=module", "--eval", source];
const requests = [];
const requestAttempts = new Map();
let server;
let baseUrl;
let activeRequests = 0;
let maxActiveRequests = 0;

const vectorDimension = (model) => /qwen3-embedding-0[.-]6b/iu.test(model) ? 1024 : 8;

before(async () => {
    server = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
            const body = JSON.parse(raw);
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            requests.push({
                url: request.url,
                authorization: request.headers.authorization ?? null,
                body,
            });
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            const attemptKey = inputs.join("\u0000");
            const attempt = (requestAttempts.get(attemptKey) ?? 0) + 1;
            requestAttempts.set(attemptKey, attempt);
            let settled = false;
            const finish = (status, headers, value) => {
                if (settled) return;
                settled = true;
                activeRequests -= 1;
                response.writeHead(status, {
                    ...headers,
                    "x-embedding-request-id": `fixture-${requests.length}`,
                }).end(JSON.stringify(value));
            };
            response.on("close", () => {
                if (settled) return;
                settled = true;
                activeRequests -= 1;
            });
            if (inputs[0] === "retry-me" && attempt === 1) {
                finish(429, { "content-type": "application/json", "retry-after": "0" }, {
                    error: { message: "retry fixture", type: "rate_limit_error" },
                });
                return;
            }
            if (inputs[0] === "malformed-response") {
                finish(200, { "content-type": "application/json" }, {
                    object: "list",
                    model: body.model,
                    data: [{ object: "embedding", index: 0, embedding: "not-an-array" }],
                });
                return;
            }
            const dimension = vectorDimension(body.model);
            const data = inputs.map((text, index) => ({
                object: "embedding",
                index,
                embedding: [text.length, ...new Array(dimension - 1).fill(0)],
            }));
            const payload = {
                object: "list",
                model: body.model,
                data,
                usage: { prompt_tokens: inputs.length * 3, total_tokens: inputs.length * 3 },
                ...(inputs[0] === "provider-metadata"
                    ? { providerMetadata: { fixture: { requestId: "request-1" } } }
                    : {}),
            };
            const delay = inputs[0] === "slow-abort" ? 5_000 : inputs.length > 1 ? 30 : 0;
            setTimeout(
                () => finish(200, { "content-type": "application/json" }, payload),
                delay,
            ).unref?.();
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server.close());

const fixtureEnv = (extra = {}) => {
    const env = {
        ...process.env,
        PLURNK_EMBEDDING_MODEL: "fixture/private-embedder",
        PLURNK_EMBEDDING_CONCURRENCY: "2",
        PLURNK_EMBEDDING_DIMENSIONS: "8",
        PLURNK_EMBEDDING_CONTEXT_WINDOW: "8192",
        PLURNK_EMBEDDING_TOKENIZER: "bert",
        PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "2048",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_NPM: "@ai-sdk/openai-compatible",
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: baseUrl,
        PLURNK_PROVIDERS_PROVIDER_FIXTURE_API_KEY_ENV: "FIXTURE_API_KEY",
        FIXTURE_API_KEY: "fixture-secret",
        ...extra,
    };
    return env;
};

const runConfigured = async (snippet, envExtra = {}) => {
    const source = `import * as embedding from ${JSON.stringify(indexPath)};\n${snippet}`;
    const { stdout } = await pexec(process.execPath, nodeEvalArgs(source), {
        env: fixtureEnv(envExtra),
        timeout: 60_000,
    });
    return stdout;
};

const configuredAdapter = (envExtra = {}) => ({
    async embedQuery(text, { signal } = {}) {
        const stdout = await runConfigured(
            `const signal = ${signal?.aborted ? "AbortSignal.abort(new DOMException('conformance cancellation', 'AbortError'))" : "undefined"};\n`
            + `const result = await embedding.embedQuery(${JSON.stringify(text)}, { signal });\n`
            + `console.log(JSON.stringify({ vector: Buffer.from(result.vector).toString("base64"), metadata: result.metadata }));`,
            envExtra,
        );
        const result = JSON.parse(stdout);
        return { vector: new Uint8Array(Buffer.from(result.vector, "base64")), metadata: result.metadata };
    },
    async embedDocuments(texts, { onProgress, signal } = {}) {
        const stdout = await runConfigured(
            `const signal = ${signal?.aborted ? "AbortSignal.abort(new DOMException('conformance cancellation', 'AbortError'))" : "undefined"};\n`
            + `const progress = [];\n`
            + `const result = await embedding.embedDocuments(${JSON.stringify(texts)}, { signal, onProgress: (value) => progress.push(value) });\n`
            + `console.log(JSON.stringify({ vectors: result.vectors.map((value) => Buffer.from(value).toString("base64")), metadata: result.metadata, progress }));`,
            envExtra,
        );
        const result = JSON.parse(stdout);
        for (const value of result.progress) onProgress?.(value);
        return {
            vectors: result.vectors.map((value) => new Uint8Array(Buffer.from(value, "base64"))),
            metadata: result.metadata,
        };
    },
});

describe("standard configured embedding adapter ({§provider-embedding-resolution})", () => {
    it("passes the common conformance suite through a declared OpenAI-compatible provider", async () => {
        await assertEmbeddingConformance(configuredAdapter(), { dimension: 8, symmetric: true });
    });

    it("passes the same conformance suite through the cataloged Cloudflare route", async () => {
        const beforeCount = requests.length;
        const cloudflareEnv = {
            PLURNK_MODEL_cfembed: "cloudflare-workers-ai/@cf/qwen/qwen3-embedding-0.6b",
            PLURNK_BASEURL_cfembed: baseUrl,
            PLURNK_EMBEDDING_MODEL: "cfembed",
            PLURNK_EMBEDDING_DIMENSIONS: "",
            PLURNK_EMBEDDING_CONTEXT_WINDOW: "",
            PLURNK_EMBEDDING_TOKENIZER: "",
            PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "",
            CLOUDFLARE_ACCOUNT_ID: "fixture-account",
            CLOUDFLARE_API_KEY: "fixture-cloudflare-key",
        };
        await assertEmbeddingConformance(configuredAdapter(cloudflareEnv), { dimension: 1024, symmetric: false });
        const query = requests.slice(beforeCount).find(({ body }) => body.input?.[0]?.includes("Query:capital of France"));
        assert.ok(query, "Cloudflare route preserved the Qwen query role");
        assert.equal(query.authorization, "Bearer fixture-cloudflare-key");
    });

    it("constructs without a network request", async () => {
        const beforeCount = requests.length;
        const stdout = await runConfigured(
            `console.log(JSON.stringify({ d: embedding.dimension, cw: embedding.contextWindow, m: embedding.model }));`,
        );
        const result = JSON.parse(stdout);
        assert.equal(result.d, 8);
        assert.equal(result.cw, 8192);
        assert.match(result.m, /^fixture\/private-embedder@[0-9a-f]{16}$/);
        assert.equal(requests.length, beforeCount, "model construction must not infer dimensions through a paid probe");
    });

    it("inherits the declared provider endpoint and credential", async () => {
        const stdout = await runConfigured(
            `const result = await embedding.embedQuery("hello");\n`
            + `console.log(JSON.stringify({ bytes: result.vector.byteLength, metadata: result.metadata }));`,
        );
        const result = JSON.parse(stdout);
        assert.equal(result.bytes, 32);
        assert.equal(result.metadata.inputTokens, 3);
        assert.deepEqual(result.metadata.warnings, []);
        assert.match(result.metadata.responses[0].headers["x-embedding-request-id"], /^fixture-/u);
        const request = requests.at(-1);
        assert.equal(request.url, "/v1/embeddings");
        assert.equal(request.authorization, "Bearer fixture-secret");
        assert.equal(request.body.model, "private-embedder");
    });

    it("resolves an existing model alias including its endpoint override", async () => {
        const stdout = await runConfigured(
            `console.log(JSON.stringify({ d: embedding.dimension, cw: embedding.contextWindow }));`,
            {
                PLURNK_MODEL_embeds: "fixture/private-embedder",
                PLURNK_BASEURL_embeds: baseUrl,
                PLURNK_EMBEDDING_MODEL: "embeds",
            },
        );
        assert.deepEqual(JSON.parse(stdout), { d: 8, cw: 8192 });
    });

    it("applies the provider and embedding knob overlays for an alias", async () => {
        const stdout = await runConfigured(
            `console.log(JSON.stringify({ d: embedding.dimension, cw: embedding.contextWindow }));`,
            {
                PLURNK_MODEL_embeds: "fixture/private-embedder",
                PLURNK_EMBEDDING_MODEL: "embeds",
                PLURNK_PROVIDERS_RETRY_ATTEMPTS: "not-an-integer",
                PLURNK_PROVIDERS_RETRY_ATTEMPTS_embeds: "0",
                PLURNK_EMBEDDING_DIMENSIONS: "9",
                PLURNK_EMBEDDING_DIMENSIONS_embeds: "8",
            },
        );
        assert.deepEqual(JSON.parse(stdout), { d: 8, cw: 8192 });
    });

    it("partitions a corpus through the AI SDK limit while preserving order", async () => {
        const beforeCount = requests.length;
        maxActiveRequests = 0;
        const stdout = await runConfigured(
            `const texts = Array.from({ length: 2050 }, (_, index) => "x".repeat(index % 7 + 1));\n`
            + `const opened = []; const settled = [];\n`
            + `const observeRequest = async (identity) => { opened.push(identity); return async (accounting) => settled.push(accounting); };\n`
            + `const result = await embedding.embedDocuments(texts, { observeRequest });\n`
            + `const firsts = result.vectors.map((value) => new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat32(0, true));\n`
            + `console.log(JSON.stringify({ count: result.vectors.length, firsts: firsts.slice(0, 8), inputTokens: result.metadata.inputTokens, opened, settled, accounting: result.metadata.accounting }));`,
        );
        const result = JSON.parse(stdout);
        assert.deepEqual({ count: result.count, firsts: result.firsts, inputTokens: result.inputTokens }, {
            count: 2050,
            firsts: [1, 2, 3, 4, 5, 6, 7, 1],
            inputTokens: 6150,
        });
        assert.deepEqual(result.opened, [
            { provider: "fixture", model: "private-embedder" },
            { provider: "fixture", model: "private-embedder" },
        ], "each physical partition opens one canonical route identity before I/O");
        assert.deepEqual(result.accounting, result.settled, "returned accounting is the exact ordered settlement evidence");
        assert.deepEqual(result.accounting.map(({ outcome }) => outcome), ["response", "response"]);
        assert.equal(requests.length - beforeCount, 2, "the standard adapter's 2048-value limit must partition the request");
        assert.equal(maxActiveRequests, 2, "the configured bound permits both standard request partitions to overlap");
    });

    it("honors retryable provider failures without losing Retry-After handling", async () => {
        const beforeCount = requests.length;
        const stdout = await runConfigured(
            `const opened = []; const settled = [];\n`
            + `const observeRequest = async (identity) => { opened.push(identity); return async (accounting) => settled.push(accounting); };\n`
            + `const result = await embedding.embedQuery("retry-me", { observeRequest });\n`
            + `console.log(JSON.stringify({ bytes: result.vector.byteLength, usage: result.metadata.inputTokens, opened, settled, accounting: result.metadata.accounting }));`,
            { PLURNK_PROVIDERS_RETRY_ATTEMPTS: "1" },
        );
        const result = JSON.parse(stdout);
        assert.deepEqual({ bytes: result.bytes, usage: result.usage }, { bytes: 32, usage: 3 });
        assert.deepEqual(result.opened, [
            { provider: "fixture", model: "private-embedder" },
            { provider: "fixture", model: "private-embedder" },
        ]);
        assert.deepEqual(result.accounting, result.settled);
        assert.deepEqual(
            result.accounting.map(({ outcome }) => outcome),
            ["error", "response"],
            "retry evidence retains one settlement per physical request in issued order",
        );
        assert.equal(result.accounting[0].status, 429);
        assert.equal("status" in result.accounting[1], false);
        assert.equal(requests.length - beforeCount, 2, "one 429 is retried exactly once");
    });

    it("preserves provider metadata through the public result", async () => {
        const stdout = await runConfigured(
            `const result = await embedding.embedQuery("provider-metadata");\n`
            + `console.log(JSON.stringify(result.metadata));`,
        );
        const metadata = JSON.parse(stdout);
        assert.equal(metadata.inputTokens, 3);
        assert.deepEqual(metadata.warnings, []);
        assert.deepEqual(metadata.providerMetadata, { fixture: { requestId: "request-1" } });
        assert.match(metadata.responses[0].headers["x-embedding-request-id"], /^fixture-/u);
    });

    it("cancels an in-flight provider request", async () => {
        await assert.rejects(
            () => runConfigured(
                `await embedding.embedQuery("slow-abort", { signal: AbortSignal.timeout(25) });`,
            ),
            /AbortError|aborted|timed out/i,
        );
    });

    it("surfaces a malformed provider response as a precise boundary failure", async () => {
        await assert.rejects(
            () => runConfigured(`await embedding.embedQuery("malformed-response");`),
            /response.*validation|schema|embedding/i,
        );
    });

    it("keeps Qwen query and document roles distinct without a Cloudflare-only path", async () => {
        const beforeCount = requests.length;
        await runConfigured(
            `await embedding.embedQuery("capital of France");\n`
            + `await embedding.embedDocuments(["Paris is the capital of France."]);`,
            {
                PLURNK_EMBEDDING_MODEL: "fixture/Qwen/Qwen3-Embedding-0.6B",
                PLURNK_EMBEDDING_DIMENSIONS: "",
                PLURNK_EMBEDDING_CONTEXT_WINDOW: "",
                PLURNK_EMBEDDING_TOKENIZER: "",
                PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "",
            },
        );
        const [query, documents] = requests.slice(beforeCount);
        assert.equal(
            query.body.input[0],
            "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:capital of France",
        );
        assert.equal(documents.body.input[0], "Paris is the capital of France.");
    });

    it("rejects a vector dimension mismatch on the first requested inference", async () => {
        await assert.rejects(
            () => runConfigured(`await embedding.embedQuery("hello");`, {
                PLURNK_EMBEDDING_DIMENSIONS: "9",
            }),
            /dimension 9 requires 9 values, got 8 values/i,
        );
    });

    it("preserves physical accounting when output validation fails after provider I/O", async () => {
        const stdout = await runConfigured(
            `const settled = [];\n`
            + `const observeRequest = async () => async (accounting) => settled.push(accounting);\n`
            + `try {\n`
            + `  await embedding.embedQuery("hello", { observeRequest });\n`
            + `} catch (error) {\n`
            + `  console.log(JSON.stringify({ name: error.name, message: error.message, accounting: error.accounting, settled }));\n`
            + `}`,
            { PLURNK_EMBEDDING_DIMENSIONS: "9" },
        );
        const result = JSON.parse(stdout);
        assert.equal(result.name, "EmbeddingInferenceError");
        assert.match(result.message, /embedding inference failed/i);
        assert.deepEqual(result.accounting, result.settled);
        assert.equal(result.accounting.length, 1);
        assert.equal(result.accounting[0].outcome, "response");
    });
});

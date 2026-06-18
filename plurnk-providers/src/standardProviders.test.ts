import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { STANDARD_PROVIDERS, isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

const baseEnv = Object.freeze({ PLURNK_FETCH_TIMEOUT: "600000", PLURNK_PROVIDERS_REASONING_BUDGET: "0", PLURNK_PROVIDER_RETRY_ATTEMPTS: "0" });

// Mock fetch: serves GET /v1/models (the n_ctx probe) and a [DONE] stream for
// /chat/completions (generate). `nctx` controls the probed window. Records URLs.
const mockEndpoint = ({ nctx, metaNctx, modelId = "m" }: { nctx?: number; metaNctx?: number; modelId?: string } = {}) => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith("/models")) {
            const row = {
                id: modelId,
                ...(nctx !== undefined ? { n_ctx: nctx } : {}),
                ...(metaNctx !== undefined ? { meta: { n_vocab: 262144, n_ctx: metaNctx } } : {}),
            };
            return new Response(JSON.stringify({ data: [row] }), { status: 200 });
        }
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    return calls;
};
const chatCall = (calls: string[]) => calls.find((u) => u.endsWith("/chat/completions"));
test.afterEach(() => mock.restoreAll());

test("isStandardProvider: known vs unknown", () => {
    assert.equal(isStandardProvider("openai"), true);
    assert.equal(isStandardProvider("groq"), true);
    assert.equal(isStandardProvider("openrouter"), false); // bespoke sibling
    assert.equal(isStandardProvider("nope"), false);
});

test("standardProviderFromEnv: returns null for a non-standard name", async () => {
    assert.equal(await standardProviderFromEnv("openrouter", { ...baseEnv }, "m"), null);
});

test("openai: throws a named error when OPENAI_BASE_URL is unset", async () => {
    await assert.rejects(standardProviderFromEnv("openai", { ...baseEnv }, "m"), /OPENAI_BASE_URL must be set/);
});

test("openai: invalid tokenizer value throws", async () => {
    await assert.rejects(
        standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", OPENAI_TOKENIZER: "bogus" }, "m"),
        /OPENAI_TOKENIZER must be one of/,
    );
});

test("openai: OPENAI_TOKENIZER=cl100k_base enables real tokenization", async () => {
    mockEndpoint();
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", OPENAI_TOKENIZER: "cl100k_base" }, "m");
    assert.equal(p!.countTokens("hello world"), 2);
});

test("openai: defaults to heuristic tokenizer", async () => {
    mockEndpoint();
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    const s = "The quick brown fox.";
    assert.equal(p!.countTokens(s), Math.ceil(s.length / 4));
});

// — context-window resolution (issue #6) —

test("openai: derives contextSize from endpoint n_ctx when env unset", async () => {
    mockEndpoint({ nctx: 49152, modelId: "macher.gguf" });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "macher.gguf");
    assert.equal(p!.contextSize, 49152);
});

test("openai: derives contextSize from llama-server's nested meta.n_ctx (issue #7)", async () => {
    mockEndpoint({ metaNctx: 49152, modelId: "macher.gguf" });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "macher.gguf");
    assert.equal(p!.contextSize, 49152);
});

test("openai: meta.n_ctx wins over a top-level n_ctx", async () => {
    mockEndpoint({ nctx: 8192, metaNctx: 49152 });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "m");
    assert.equal(p!.contextSize, 49152);
});

test("openai: explicit PLURNK_PROVIDER_CONTEXT_SIZE wins over n_ctx", async () => {
    mockEndpoint({ nctx: 49152 });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local", PLURNK_PROVIDER_CONTEXT_SIZE: "400000" }, "m");
    assert.equal(p!.contextSize, 400000);
});

test("openai: contextSize null when the endpoint reports no n_ctx (e.g. real OpenAI)", async () => {
    mockEndpoint({}); // models response without n_ctx
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.contextSize, null);
});

test("openai: probe failure degrades to null, never throws", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) return new Response("nope", { status: 503 });
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.contextSize, null);
});

test("cloud standard providers do not probe (no n_ctx fetch)", async () => {
    const calls = mockEndpoint({ nctx: 99999 });
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k" }, "m");
    assert.equal(p!.contextSize, null);           // groq has no probeNctx
    assert.equal(calls.some((u) => u.endsWith("/models")), false); // never queried /models
});

test("standard provider tags failures with provider:<name> telemetry source", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response("forbidden", { status: 403 }); // chat/completions fails
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    await assert.rejects(() => p!.generate({ runId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.toTelemetryEvent().source, "provider:openai");
        assert.equal(err.kind, "unauthorized");
        return true;
    });
});

test("groq: requires its API key", async () => {
    await assert.rejects(standardProviderFromEnv("groq", { ...baseEnv }, "m"), /GROQ_API_KEY must be set/);
});

test("groq: applies PLURNK_PROVIDER_CONTEXT_SIZE", async () => {
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", PLURNK_PROVIDER_CONTEXT_SIZE: "131072" }, "m");
    assert.equal(p!.contextSize, 131072);
});

// — grammar capability detection (SPEC §13, issue #8) —

test("openai: llama-server fingerprint (meta block) enables grammar transport", async () => {
    const bodies: string[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "m", meta: { n_vocab: 262144, n_ctx: 49152 } }] }), { status: 200 });
        }
        if (String(url).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        bodies.push(String(init?.body));
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "m");
    await p!.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    const sent = JSON.parse(bodies[0]);
    assert.equal(sent.grammar, "root ::= statement");
    assert.equal(sent.repeat_penalty, 1.15);
    assert.equal(sent.id_slot, 0); // fingerprint wires internal slot affinity too
});

test("openai: top-level n_ctx without meta (vLLM) does NOT enable grammar", async () => {
    const bodies: string[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "m", n_ctx: 8192 }] }), { status: 200 });
        }
        bodies.push(String(init?.body));
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.contextSize, 8192); // window still read
    await p!.generate({ runId: "r", messages: [], grammar: "root ::= statement" });
    assert.equal("grammar" in JSON.parse(bodies[0]), false);
});

test("openai: llama-server upgrades 'think'→'template'; enable_thinking mirrors PLURNK_PROVIDERS_REASONING_BUDGET != 0", async () => {
    const mk = (reasoning: string) => {
        const bodies: string[] = [];
        mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
            if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m", meta: { n_ctx: 49152 } }] }), { status: 200 });
            if (String(url).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
            bodies.push(String(init?.body));
            const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
            return new Response(body, { status: 200 });
        });
        return { bodies, env: { ...baseEnv, PLURNK_PROVIDERS_REASONING_BUDGET: reasoning, OPENAI_BASE_URL: "http://local" } };
    };
    const off = mk("0");
    const pOff = await standardProviderFromEnv("openai", off.env, "m");
    await pOff!.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(off.bodies[0]).chat_template_kwargs, { enable_thinking: false });
    assert.equal("think" in JSON.parse(off.bodies[0]), false); // think→template, never raw think

    mock.restoreAll();
    const on = mk("-1");
    const pOn = await standardProviderFromEnv("openai", on.env, "m");
    await pOn!.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(on.bodies[0]).chat_template_kwargs, { enable_thinking: true });
});

test("openai: non-llama-server endpoint keeps the 'think' style (no template kwargs)", async () => {
    const bodies: string[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }); // no meta → not llama-server
        }
        bodies.push(String(init?.body));
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal("chat_template_kwargs" in JSON.parse(bodies[0]), false);
});

test("openai: probed total_slots drives internal run→slot affinity; never surfaces", async () => {
    const bodies: string[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m", meta: { n_ctx: 16384 } }] }), { status: 200 });
        if (u.endsWith("/props")) return new Response(JSON.stringify({ total_slots: 2 }), { status: 200 });
        bodies.push(String(init?.body));
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "m");
    assert.equal(p!.contextSize, 16384); // per-slot window, as the server reports it
    assert.equal("slotCount" in p!, false); // resource internals never on the surface
    await p!.generate({ runId: "run-A", messages: [] });
    await p!.generate({ runId: "run-B", messages: [] });
    await p!.generate({ runId: "run-A", messages: [] });
    assert.deepEqual(bodies.map((b) => JSON.parse(b).id_slot), [0, 1, 0]);

    mock.restoreAll();
    mockEndpoint({ nctx: 8192 }); // top-level n_ctx, no meta → not llama-server
    const vllm = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    const calls = mockEndpoint({ nctx: 8192 });
    await vllm!.generate({ runId: "run-A", messages: [] });
    assert.equal(calls.some((u) => u.endsWith("/props")), false); // no fingerprint → no props probe
});

test("openai: env-pinned context size does not disable grammar detection (probe still runs)", async () => {
    const calls = mockEndpoint({ metaNctx: 49152 });
    const p = await standardProviderFromEnv(
        "openai",
        { ...baseEnv, OPENAI_BASE_URL: "http://local", PLURNK_PROVIDER_CONTEXT_SIZE: "400000" },
        "m",
    );
    assert.equal(p!.contextSize, 400000); // env wins for the window
    assert.equal(calls.some((u) => u.endsWith("/models")), true); // probe still fired for capability
});

// — URL resolution —

test("openai flexBaseStrip: base with trailing /v1 yields a single /v1/chat/completions", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x/v1" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "http://x/v1/chat/completions");
});

test("fixed-base provider resolves the documented chat-completions URL", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("deepinfra", { ...baseEnv, DEEPINFRA_API_KEY: "k" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "https://api.deepinfra.com/v1/openai/chat/completions");
});

test("baseUrlVar overrides the fixed default", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", GROQ_BASE_URL: "http://proxy/openai/v1" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "http://proxy/openai/v1/chat/completions");
});

test("every registry entry resolves the chat URL the spec encodes", async () => {
    const envFor = (name: string): NodeJS.ProcessEnv => {
        const spec = STANDARD_PROVIDERS[name];
        const e: NodeJS.ProcessEnv = { ...baseEnv, [spec.apiKeyVar]: "k" };
        // Entries with no fixed default (openai, bedrock) require their base URL.
        if (spec.baseUrl === undefined && spec.baseUrlVar !== undefined) e[spec.baseUrlVar] = "http://x/v1";
        return e;
    };
    for (const name of Object.keys(STANDARD_PROVIDERS)) {
        const calls = mockEndpoint();
        const p = await standardProviderFromEnv(name, envFor(name), "m");
        await p!.generate({ runId: "r", messages: [] });
        const u = chatCall(calls)!;
        assert.ok(u.endsWith("/chat/completions"), `${name} → ${u}`);
        assert.ok(u.startsWith("http"), `${name} → ${u}`);
        mock.restoreAll();
    }
});

// — vendored-snapshot fallback (#19): live wins, catalog fills the gap —

import { catalogSnapshot } from "@plurnk/plurnk-models";

test("standard provider: a catalog hit fills contextSize + cost when there's no live source", async () => {
    // groq doesn't probe; pick a real model id from the vendored snapshot.
    const [modelId, info] = Object.entries(catalogSnapshot().groq)[0];
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k" }, modelId);
    assert.ok(p !== null);
    assert.equal(p.contextSize, info.contextWindow); // catalog window, no probe needed
    if (info.cost !== undefined) {
        // 1M output tokens → outputPer1M USD, in pico-USD (per-1M ×1e6 per token).
        const c = p.costFor({ prompt: 0, completion: 1_000_000, reasoning: 0, cached: 0, total: 1_000_000 });
        assert.equal(c, Math.round(info.cost.outputPer1M * 1e6 * 1_000_000));
    } else {
        assert.equal(p.costFor({ prompt: 1, completion: 1, reasoning: 0, cached: 0, total: 2 }), 0);
    }
});

test("standard provider: a local (non-cataloged) model misses the fallback — probe owns it, contextSize null", async () => {
    mock.method(globalThis, "fetch", async (url: string) =>
        String(url).endsWith("/models") ? new Response(JSON.stringify({ data: [] }), { status: 200 }) : new Response("{}", { status: 200 }));
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "macher.gguf");
    assert.ok(p !== null);
    assert.equal(p.contextSize, null); // empty probe + catalog miss → null; live owns the local case
    mock.restoreAll();
});

// — anthropic standard entry (first-party Claude, #18) —

test("anthropic: standard entry sends bearer auth + the thinking param to the compat endpoint", async () => {
    let body = "";
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/chat/completions")) { body = String(init?.body); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } }), { status: 200 }); }
        return new Response("{}", { status: 200 });
    });
    const env = { ...baseEnv, ANTHROPIC_API_KEY: "sk-ant-xyz", PLURNK_PROVIDERS_REASONING_BUDGET: "3000" };
    const p = await standardProviderFromEnv("anthropic", env, "claude-opus-4-8");
    assert.ok(p !== null);
    await p.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(JSON.parse(body).thinking, { type: "enabled", budget_tokens: 3000 });
    mock.restoreAll();
});

test("anthropic: context + cost come from the catalog (no probe)", async () => {
    const [modelId, info] = Object.entries(catalogSnapshot().anthropic)[0];
    const p = await standardProviderFromEnv("anthropic", { ...baseEnv, ANTHROPIC_API_KEY: "k" }, modelId);
    assert.equal(p!.contextSize, info.contextWindow);
});

// — bedrock standard entry (AWS, bearer API key, #19) —

test("bedrock: requires BEDROCK_BASE_URL (region-templated) and AWS_BEARER_TOKEN_BEDROCK", async () => {
    await assert.rejects(
        standardProviderFromEnv("bedrock", { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: "tok" }, "us.anthropic.claude-sonnet-4-6"),
        /BEDROCK_BASE_URL must be set/,
    );
    await assert.rejects(
        standardProviderFromEnv("bedrock", { ...baseEnv, BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com/v1" }, "m"),
        /AWS_BEARER_TOKEN_BEDROCK must be set/,
    );
});

test("bedrock: builds the region URL and sends the Bedrock API key as bearer", async () => {
    const calls: { url: string; auth: string }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") });
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } }), { status: 200 });
    });
    const env = { ...baseEnv, BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com/v1", AWS_BEARER_TOKEN_BEDROCK: "bedrock-key" };
    const p = await standardProviderFromEnv("bedrock", env, "us.anthropic.claude-sonnet-4-6");
    await p!.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    assert.equal(calls[0].url, "https://bedrock-runtime.us-east-1.amazonaws.com/v1/chat/completions");
    assert.equal(calls[0].auth, "Bearer bedrock-key");
    mock.restoreAll();
});

// — plurnk hosted model: two optional credentials via headersFromEnv —

// Mock that serves the /models probe + captures the chat-completions request
// headers; `chatStatus` lets a test force a rejection.
const plurnkMock = (chatStatus = 200) => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        const u = String(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ url: u, headers, body: String(init?.body ?? "") });
        if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "plurnk", meta: { n_ctx: 49152 } }] }), { status: 200 });
        if (u.endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        if (chatStatus !== 200) return new Response("denied", { status: chatStatus });
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } }), { status: 200 });
    });
    return seen;
};
const chatHeaders = (seen: { url: string; headers: Record<string, string> }[]) =>
    seen.find((s) => s.url.endsWith("/chat/completions"))!.headers;

test("plurnk: with no PLURNK_KEY/PLURNK_ACCOUNT, no auth headers are sent", async () => {
    const seen = plurnkMock();
    const p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk"); // default base, no creds
    await p!.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    const h = chatHeaders(seen);
    assert.equal("Authorization" in h, false);
    assert.equal("Plurnk-Account" in h, false);
    mock.restoreAll();
});

test("plurnk: PLURNK_KEY + PLURNK_ACCOUNT send bearer + the Plurnk-Account routing header", async () => {
    const seen = plurnkMock();
    const env = { ...baseEnv, PLURNK_KEY: "pk-live-123", PLURNK_ACCOUNT: "acct_42" };
    const p = await standardProviderFromEnv("plurnk", env, "plurnk");
    await p!.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    const h = chatHeaders(seen);
    assert.equal(h.Authorization, "Bearer pk-live-123");
    assert.equal(h["Plurnk-Account"], "acct_42");
    mock.restoreAll();
});

test("plurnk: each credential is independent (key-only, account-only)", async () => {
    let seen = plurnkMock();
    let p = await standardProviderFromEnv("plurnk", { ...baseEnv, PLURNK_KEY: "k" }, "plurnk");
    await p!.generate({ runId: "r", messages: [] });
    let h = chatHeaders(seen);
    assert.equal(h.Authorization, "Bearer k");
    assert.equal("Plurnk-Account" in h, false);
    mock.restoreAll();

    seen = plurnkMock();
    p = await standardProviderFromEnv("plurnk", { ...baseEnv, PLURNK_ACCOUNT: "acct_9" }, "plurnk");
    await p!.generate({ runId: "r", messages: [] });
    h = chatHeaders(seen);
    assert.equal(h["Plurnk-Account"], "acct_9");
    assert.equal("Authorization" in h, false);
    mock.restoreAll();
});

test("plurnk: a 401 is classified unauthorized — terminal, never retried", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    const seen = plurnkMock(401);
    const env = { ...baseEnv, PLURNK_PROVIDER_RETRY_ATTEMPTS: "3", PLURNK_KEY: "expired" };
    const p = await standardProviderFromEnv("plurnk", env, "plurnk");
    await assert.rejects(() => p!.generate({ runId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError); assert.equal(err.kind, "unauthorized"); return true;
    });
    assert.equal(seen.filter((s) => s.url.endsWith("/chat/completions")).length, 1); // terminal — never retried
    mock.restoreAll();
});

test("plurnk: llama.cpp behavior is inherited — grammar capability + n_ctx from the probe", async () => {
    const seen = plurnkMock();
    const p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    assert.equal(p!.contextSize, 49152); // probed n_ctx (the live source)
    // The probe saw the llama-server meta block, so a caller-supplied grammar
    // transports on the wire — identical to the local model.
    await p!.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    const body = JSON.parse(seen.find((s) => s.url.endsWith("/chat/completions"))!.body);
    assert.equal(body.grammar, 'root ::= "ok"');
    mock.restoreAll();
});

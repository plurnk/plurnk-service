import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { STANDARD_PROVIDERS, isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

const baseEnv = Object.freeze({ PLURNK_FETCH_TIMEOUT: "600000", PLURNK_REASON: "0", PLURNK_PROVIDERS_REASONING: "0" });

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

test("openai: llama-server upgrades 'think'→'template'; enable_thinking mirrors PLURNK_PROVIDERS_REASONING", async () => {
    const mk = (reasoning: string) => {
        const bodies: string[] = [];
        mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
            if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m", meta: { n_ctx: 49152 } }] }), { status: 200 });
            if (String(url).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
            bodies.push(String(init?.body));
            const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
            return new Response(body, { status: 200 });
        });
        return { bodies, env: { ...baseEnv, PLURNK_PROVIDERS_REASONING: reasoning, OPENAI_BASE_URL: "http://local" } };
    };
    const off = mk("0");
    const pOff = await standardProviderFromEnv("openai", off.env, "m");
    await pOff!.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(off.bodies[0]).chat_template_kwargs, { enable_thinking: false });
    assert.equal("think" in JSON.parse(off.bodies[0]), false); // think→template, never raw think

    mock.restoreAll();
    const on = mk("1");
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
    const envFor = (name: string): NodeJS.ProcessEnv => ({
        ...baseEnv,
        OPENAI_BASE_URL: "http://x",
        ...Object.fromEntries([[STANDARD_PROVIDERS[name].apiKeyVar, "k"]]),
    });
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

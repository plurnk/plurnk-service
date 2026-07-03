import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { STANDARD_PROVIDERS, isStandardProvider, standardProviderFromEnv } from "./standardProviders.ts";

// Base URLs are REQUIRED (no in-code default) — the fixture supplies the vendor
// defaults for the providers exercised outside the coverage loop. `openai` is
// deliberately omitted so its missing-base fail-hard test still fires.
const baseEnv = Object.freeze({
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000", PLURNK_PROVIDERS_THINKING: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    GROQ_BASE_URL: "https://api.groq.com/openai/v1",
    DEEPINFRA_BASE_URL: "https://api.deepinfra.com/v1/openai",
    FIREWORKS_BASE_URL: "https://api.fireworks.ai/inference/v1",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
    PLURNK_BASE_URL: "https://plurnk.ai/v1",
});

// Mock fetch: serves GET /v1/models (the n_ctx probe) and a [DONE] stream for
// /chat/completions (generate). `nctx` controls the probed window. Records URLs.
const mockEndpoint = ({ nctx, metaNctx, modelId = "m" }: { nctx?: number; metaNctx?: number; modelId?: string } = {}) => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
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
        // Honor the request's transport: SSE when stream:true, one JSON otherwise.
        const streamed = init?.body !== undefined && JSON.parse(String(init.body)).stream === true;
        if (streamed) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } }), { status: 200 });
        return new Response(JSON.stringify({ model: modelId, choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    await assert.rejects(standardProviderFromEnv("openai", { ...baseEnv }, "m"), /OPENAI_BASE_URL or OPENAI_API_BASE must be set/);
});

test("openai: a still-set tokenizer var fails hard with the migration pointer (tokenizer shed)", async () => {
    await assert.rejects(
        standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", OPENAI_TOKENIZER: "cl100k_base" }, "m"),
        /OPENAI_TOKENIZER was removed — exact counting moved to the @plurnk\/plurnk-mimetypes tokenizer seam/,
    );
});

test("openai: defaults to the chars/2 heuristic upper bound, and SURFACES it", async () => {
    mockEndpoint();
    const warned: Array<string | Error> = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { warned.push(msg); });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    const s = "The quick brown fox.";
    assert.equal(p!.countTokens(s), Math.ceil(s.length / 2));
    // Never a silent fallback: the heuristic announces itself at construction.
    assert.ok(warned.some((w) => String(w).includes("chars/2 upper bound")), `expected heuristic warning; got ${warned.join("; ")}`);
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

test("openai: explicit PLURNK_PROVIDERS_CONTEXT_SIZE wins over n_ctx", async () => {
    mockEndpoint({ nctx: 49152 });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local", PLURNK_PROVIDERS_CONTEXT_SIZE: "400000" }, "m");
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

test("openai: a probe network error (fetch rejects) degrades to null context and no grammar, never throws", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) throw new TypeError("network down"); // fetch itself rejects
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.contextSize, null);
    await p!.generate({ runId: "r", messages: [] }); // no fingerprint → no grammar capability, generate still works
});

test("openai: a slot-probe network error (fetch rejects on /props) degrades slotCount to null, never throws", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
        const u = String(url);
        if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m", meta: { n_ctx: 4096 } }] }), { status: 200 }); // llama fingerprint → slot probe runs
        if (u.endsWith("/props")) throw new TypeError("network down"); // the /props slot probe rejects
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
        return new Response(body, { status: 200 });
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.contextSize, 4096); // meta.n_ctx still resolved despite the slot-probe failure
    await p!.generate({ runId: "r", messages: [], grammar: 'root ::= "x"?' }); // grammar still transports; no id_slot (slotCount null)
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

test("groq: applies PLURNK_PROVIDERS_CONTEXT_SIZE", async () => {
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", PLURNK_PROVIDERS_CONTEXT_SIZE: "131072" }, "m");
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
    await p!.generate({ runId: "r", messages: [], grammar: 'root ::= "x"?' });
    const sent = JSON.parse(bodies[0]);
    assert.equal(sent.grammar, 'root ::= "x"?');
    assert.equal(sent.repeat_penalty, 1.15);
    assert.equal(sent.id_slot, 0); // fingerprint wires internal slot affinity too
});

test("openai: llama-server fingerprint surfaces the tokenize() capability (native /tokenize, model's own vocab)", async () => {
    const tokenizeCalls: Array<{ url: string; body: string }> = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m", meta: { n_vocab: 262144, n_ctx: 49152 } }] }), { status: 200 });
        if (u.endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        if (u.endsWith("/tokenize")) { tokenizeCalls.push({ url: u, body: String(init?.body) }); return new Response(JSON.stringify({ tokens: [101, 7, 42] }), { status: 200 }); }
        throw new Error(`unexpected fetch ${u}`);
    });
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://local" }, "m");
    assert.notEqual(p!.tokenize, undefined);
    const ids = await p!.tokenize!("hello");
    assert.deepEqual(ids, [101, 7, 42]);
    assert.equal(tokenizeCalls[0].url, "http://local/tokenize"); // native root endpoint, not /v1
    assert.deepEqual(JSON.parse(tokenizeCalls[0].body), { content: "hello" });
});

test("openai: non-llama-server endpoint has NO tokenize capability (undefined is the honest signal)", async () => {
    mockEndpoint({ nctx: 8192 }); // top-level n_ctx, no meta → vLLM-ish, not llama-server
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x" }, "m");
    assert.equal(p!.tokenize, undefined);
});

test("plurnk: detectLlamaServer=false never surfaces tokenize, even when the endpoint fingerprints", async () => {
    mockEndpoint({ metaNctx: 32768, modelId: "plurnk" });
    const p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    assert.equal(p!.tokenize, undefined);
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

test("openai: llama-server upgrades 'think'→'template'; enable_thinking mirrors PLURNK_PROVIDERS_THINKING", async () => {
    const mk = (reasoning: string) => {
        const bodies: string[] = [];
        mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
            if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m", meta: { n_ctx: 49152 } }] }), { status: 200 });
            if (String(url).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
            bodies.push(String(init?.body));
            const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } });
            return new Response(body, { status: 200 });
        });
        return { bodies, env: { ...baseEnv, PLURNK_PROVIDERS_THINKING: reasoning, OPENAI_BASE_URL: "http://local" } };
    };
    const off = mk("off");
    const pOff = await standardProviderFromEnv("openai", off.env, "m");
    await pOff!.generate({ runId: "r", messages: [] });
    assert.deepEqual(JSON.parse(off.bodies[0]).chat_template_kwargs, { enable_thinking: false });
    assert.equal("think" in JSON.parse(off.bodies[0]), false); // think→template, never raw think

    mock.restoreAll();
    const on = mk("adaptive");
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
        { ...baseEnv, OPENAI_BASE_URL: "http://local", PLURNK_PROVIDERS_CONTEXT_SIZE: "400000" },
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

test("a provider appends chatPath to its base URL", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("deepinfra", { ...baseEnv, DEEPINFRA_API_KEY: "k" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "https://api.deepinfra.com/v1/openai/chat/completions");
});

test("baseUrlVar supplies the base URL (no in-code default)", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", GROQ_BASE_URL: "http://proxy/openai/v1" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "http://proxy/openai/v1/chat/completions");
});

test("a standard provider fails hard when its base URL is unset (no in-code default)", async () => {
    await assert.rejects(
        standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k", GROQ_BASE_URL: "" }, "m"),
        /groq provider: GROQ_BASE_URL must be set/,
    );
});

test("every registry entry resolves the chat URL the spec encodes", async () => {
    const first = (v: string | readonly string[] | undefined): string | undefined =>
        v === undefined ? undefined : typeof v === "string" ? v : v[0];
    const envFor = (name: string): NodeJS.ProcessEnv => {
        const spec = STANDARD_PROVIDERS[name];
        const e: NodeJS.ProcessEnv = { ...baseEnv };
        // Specs whose auth rides headersFromEnv (e.g. plurnk) have no apiKeyVar.
        const keyVar = first(spec.apiKeyVar);
        if (keyVar !== undefined) e[keyVar] = "k";
        // Every entry requires its base URL (no in-code default); bedrock also
        // accepts its BASE_URL var, so setting it here covers all specs.
        const baseVar = first(spec.baseUrlVar);
        if (baseVar !== undefined) e[baseVar] = "http://x/v1";
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

// — accepted env-var aliases & derived bases (audit; web-sourced wild conventions) —

test("deepinfra: resolves auth via the DEEPINFRA_TOKEN alias (not only DEEPINFRA_API_KEY)", async () => {
    const seen = plurnkMock();
    const p = await standardProviderFromEnv("deepinfra", { ...baseEnv, DEEPINFRA_TOKEN: "di-tok" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatHeaders(seen).Authorization, "Bearer di-tok");
    mock.restoreAll();
});

test("deepinfra: a required key unset across ALL aliases fails hard, naming each", async () => {
    await assert.rejects(
        standardProviderFromEnv("deepinfra", { ...baseEnv }, "m"),
        /DEEPINFRA_API_KEY or DEEPINFRA_API_TOKEN or DEEPINFRA_TOKEN must be set/,
    );
});

test("openai: base URL via the legacy OPENAI_API_BASE alias", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_API_BASE: "http://legacy/v1" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "http://legacy/v1/chat/completions");
    mock.restoreAll();
});

test("bedrock: derives the base from AWS_REGION (.../openai/v1), no BEDROCK_BASE_URL needed", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("bedrock", { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: "tok", AWS_REGION: "us-west-2" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions");
    mock.restoreAll();
});

test("bedrock: AWS_DEFAULT_REGION is accepted when AWS_REGION is unset", async () => {
    const calls = mockEndpoint();
    const p = await standardProviderFromEnv("bedrock", { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: "tok", AWS_DEFAULT_REGION: "eu-west-1" }, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1/chat/completions");
    mock.restoreAll();
});

test("bedrock: an explicit BEDROCK_BASE_URL overrides region derivation", async () => {
    const calls = mockEndpoint();
    const env = { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: "tok", AWS_REGION: "us-west-2", BEDROCK_BASE_URL: "https://gw.internal/openai/v1" };
    const p = await standardProviderFromEnv("bedrock", env, "m");
    await p!.generate({ runId: "r", messages: [] });
    assert.equal(chatCall(calls), "https://gw.internal/openai/v1/chat/completions");
    mock.restoreAll();
});

test("bedrock: neither BEDROCK_BASE_URL nor a region fails hard, naming the region vars", async () => {
    await assert.rejects(
        standardProviderFromEnv("bedrock", { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: "tok" }, "m"),
        /BEDROCK_BASE_URL must be set, or AWS_REGION \/ AWS_DEFAULT_REGION/,
    );
});

test("bedrock: contextSize resolves from the catalog via the inference-profile's publisher (#22)", async () => {
    const env = { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: "tok", AWS_REGION: "us-west-2" };
    const p = await standardProviderFromEnv("bedrock", env, "us.anthropic.claude-sonnet-4-5");
    assert.equal(p!.contextSize, 200000); // from the anthropic catalog, no PLURNK_PROVIDERS_CONTEXT_SIZE set
    // cost is NOT taken from the native anthropic rate (bedrock marks up) — stays 0
    assert.equal(p!.costFor({ prompt: 1_000_000, completion: 1_000_000, reasoning: 0, cached: 0, total: 2_000_000 }), 0);
});

test("bedrock: a publisher the catalog lacks (meta) → contextSize null; PLURNK_PROVIDERS_CONTEXT_SIZE still wins", async () => {
    const base = { ...baseEnv, AWS_BEARER_TOKEN_BEDROCK: "tok", AWS_REGION: "us-east-1" };
    assert.equal((await standardProviderFromEnv("bedrock", base, "us.meta.llama-3-70b"))!.contextSize, null);
    const pinned = await standardProviderFromEnv("bedrock", { ...base, PLURNK_PROVIDERS_CONTEXT_SIZE: "128000" }, "us.meta.llama-3-70b");
    assert.equal(pinned!.contextSize, 128000);
});

test("PLURNK_GBNF_DEBUG=1 wires through: an invalid grammar throws without a chat call", async () => {
    const calls = mockEndpoint({ metaNctx: 4096 }); // llama fingerprint → grammarStyle llamacpp
    const p = await standardProviderFromEnv("openai", { ...baseEnv, OPENAI_BASE_URL: "http://x", PLURNK_GBNF_DEBUG: "1" }, "m");
    await assert.rejects(
        () => p!.generate({ runId: "r", messages: [], grammar: 'foo ::= "a"' }), // invalid GBNF
        /PLURNK_GBNF_DEBUG/,
    );
    assert.equal(chatCall(calls), undefined); // probes only — the grammar never reached /chat/completions
    mock.restoreAll();
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
    const env = { ...baseEnv, ANTHROPIC_API_KEY: "sk-ant-xyz", PLURNK_PROVIDERS_THINKING: "on", PLURNK_PROVIDERS_THINKING_CAPACITY: "3000" };
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

test("bedrock: an explicit base is used verbatim and sends the Bedrock API key as bearer", async () => {
    const calls: { url: string; auth: string }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") });
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } }), { status: 200 });
    });
    const env = { ...baseEnv, BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", AWS_BEARER_TOKEN_BEDROCK: "bedrock-key" };
    const p = await standardProviderFromEnv("bedrock", env, "us.anthropic.claude-sonnet-4-6");
    await p!.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    assert.equal(calls[0].url, "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions");
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

test("plurnk: with no PLURNK_API_KEY, no Authorization header is sent (keyless local server)", async () => {
    const seen = plurnkMock();
    const p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk"); // base from PLURNK_BASE_URL, no key
    await p!.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    const h = chatHeaders(seen);
    assert.equal("Authorization" in h, false);
    mock.restoreAll();
});

test("plurnk: PLURNK_API_KEY sends the bearer; no separate account header (the key identifies the account)", async () => {
    const seen = plurnkMock();
    const env = { ...baseEnv, PLURNK_API_KEY: "pk-live-123" };
    const p = await standardProviderFromEnv("plurnk", env, "plurnk");
    await p!.generate({ runId: "r", messages: [{ role: "user", content: "hi" }] });
    const h = chatHeaders(seen);
    assert.equal(h.Authorization, "Bearer pk-live-123");
    assert.equal("Plurnk-Account" in h, false); // retired — the key carries account identity
    mock.restoreAll();
});

test("plurnk: forwards attributions + client as Plurnk-* telemetry headers (firstPartyMetadata)", async () => {
    const seen = plurnkMock();
    const p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    await p!.generate({ runId: "r", messages: [], attributions: ["@acme/x@1.0.0"], client: "plurnk-tui/0.9.0" });
    const h = chatHeaders(seen);
    assert.equal(h["Plurnk-Attribution"], '["@acme/x@1.0.0"]');
    assert.equal(h["Plurnk-Client"], "plurnk-tui/0.9.0");
    assert.equal(h["Plurnk-Run-Id"], "r"); // run identity rides the same gate (#26)
    mock.restoreAll();
});

test("plurnk: forwards strikes as Plurnk-Strikes — and 0 is a real value, distinct from absent (#313)", async () => {
    let seen = plurnkMock();
    let p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    await p!.generate({ runId: "r", messages: [], strikes: 3 });
    assert.equal(chatHeaders(seen)["Plurnk-Strikes"], "3");
    mock.restoreAll();
    seen = plurnkMock();
    p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    await p!.generate({ runId: "r", messages: [], strikes: 0 }); // clean streak reported explicitly
    assert.equal(chatHeaders(seen)["Plurnk-Strikes"], "0");
    mock.restoreAll();
    seen = plurnkMock();
    p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    await p!.generate({ runId: "r", messages: [] }); // not reported → no header
    assert.equal("Plurnk-Strikes" in chatHeaders(seen), false);
});

test("fireworks: does NOT forward attributions/client — first-party telemetry can't leak to a third party", async () => {
    let seenHeaders: Record<string, string> = {};
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/chat/completions")) {
            seenHeaders = (init?.headers ?? {}) as Record<string, string>;
            return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
    });
    const p = await standardProviderFromEnv("fireworks", { ...baseEnv, FIREWORKS_API_KEY: "fw" }, "deepseek-v4-flash");
    await p!.generate({ runId: "r", messages: [], attributions: ["@acme/x@1.0.0"], client: "plurnk-tui/0.9.0", strikes: 2 });
    assert.equal("Plurnk-Attribution" in seenHeaders, false);
    assert.equal("Plurnk-Client" in seenHeaders, false);
    assert.equal("Plurnk-Strikes" in seenHeaders, false); // strikes gated identically
    assert.equal("Plurnk-Run-Id" in seenHeaders, false); // run identity gated identically (#26)
    mock.restoreAll();
});

test("plurnk: a 401 is classified unauthorized — terminal, never retried", async () => {
    const { ProviderError } = await import("./telemetry.ts");
    const seen = plurnkMock(401);
    const env = { ...baseEnv, PLURNK_PROVIDERS_RETRY_ATTEMPTS: "3", PLURNK_API_KEY: "expired" };
    const p = await standardProviderFromEnv("plurnk", env, "plurnk");
    await assert.rejects(() => p!.generate({ runId: "r", messages: [] }), (err: unknown) => {
        assert.ok(err instanceof ProviderError); assert.equal(err.kind, "unauthorized"); return true;
    });
    assert.equal(seen.filter((s) => s.url.endsWith("/chat/completions")).length, 1); // terminal — never retried
    mock.restoreAll();
});

test("plurnk: normalizes the endpoint's balance_pico into meta.balancePico (#23)", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
        const u = String(url);
        if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "plurnk", meta: { n_ctx: 49152 } }] }), { status: 200 });
        // plurnk has detectLlamaServer:false → streams; balance rides as a top-level field on a chunk.
        const sse = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"balance_pico":880000000}\n\ndata: [DONE]';
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), { status: 200 });
    });
    const p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    const res = await p!.generate({ runId: "r", messages: [] });
    assert.equal(res.meta?.balancePico, 880000000);
    mock.restoreAll();
});

test("a third-party (non-plurnk) provider never NORMALIZES balancePico — only plurnk holds that contract", async () => {
    mock.method(globalThis, "fetch", async () =>
        new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}],"balance_pico":880000000}\n\ndata: [DONE]')); c.close(); } }), { status: 200 }));
    const p = await standardProviderFromEnv("groq", { ...baseEnv, GROQ_API_KEY: "k" }, "m");
    const res = await p!.generate({ runId: "r", messages: [] });
    assert.equal("balancePico" in (res.meta ?? {}), false); // groq has no balanceMetaKey — no normalization
    assert.equal(res.meta?.balance_pico, 880000000);          // but the raw field still passes through (every-provider meta)
    mock.restoreAll();
});

test("plurnk: reads its window from upstream but stays a plain OpenAI client — no grammar, no slot pinning, despite a meta block", async () => {
    // The mock's /models returns a meta block (a llama-server fingerprint), yet
    // detectLlamaServer:false means plurnk reads only the window and refuses every
    // capability it could otherwise be talked into.
    const seen = plurnkMock();
    const p = await standardProviderFromEnv("plurnk", { ...baseEnv }, "plurnk");
    assert.equal(p!.contextSize, 49152); // window STILL read from upstream — a 32k→48k change is a server decision
    await p!.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    const body = JSON.parse(seen.find((s) => s.url.endsWith("/chat/completions"))!.body);
    assert.equal("grammar" in body, false);          // never forwards GBNF — the router injects its own
    assert.equal("response_format" in body, false);
    assert.equal("id_slot" in body, false);          // never slot-pinned
    assert.equal("think" in body, false);            // reasoningStyle "none" → no reasoning param leaks
    mock.restoreAll();
});

// — fireworks carries GBNF via response_format.grammar (cloud GBNF, #grammarStyle) —

test("fireworks: a grammar transports as response_format.grammar (not the llama.cpp top-level field)", async () => {
    let body = "";
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/chat/completions")) { body = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } }); }
        return new Response("{}", { status: 200 });
    });
    const p = await standardProviderFromEnv("fireworks", { ...baseEnv, FIREWORKS_API_KEY: "fw" }, "accounts/fireworks/models/deepseek-v4-pro");
    await p!.generate({ runId: "r", messages: [], grammar: 'root ::= "ok"' });
    const b = JSON.parse(body);
    assert.deepEqual(b.response_format, { type: "grammar", grammar: 'root ::= "ok"' });
    assert.equal("grammar" in b, false);
    mock.restoreAll();
});

// — fireworks modelPrefix: the alias carries only the distinctive tail —

const fireworksWireModel = async (alias: string): Promise<string> => {
    let body = "";
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).endsWith("/chat/completions")) { body = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } }); }
        return new Response("{}", { status: 200 });
    });
    const p = await standardProviderFromEnv("fireworks", { ...baseEnv, FIREWORKS_API_KEY: "fw" }, alias);
    await p!.generate({ runId: "r", messages: [] });
    mock.restoreAll();
    return JSON.parse(body).model;
};

test("fireworks: a bare alias is prefixed with accounts/fireworks/models/ on the wire", async () => {
    assert.equal(await fireworksWireModel("deepseek-v4-pro"), "accounts/fireworks/models/deepseek-v4-pro");
});

test("fireworks: an already-prefixed id is left unchanged (idempotent prepend)", async () => {
    assert.equal(await fireworksWireModel("accounts/fireworks/models/deepseek-v4-pro"), "accounts/fireworks/models/deepseek-v4-pro");
});

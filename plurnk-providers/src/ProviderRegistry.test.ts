import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { instantiateProvider, loadActiveProvider, resetDiscoveryCache } from "./ProviderRegistry.ts";
import type { PluginAttributionContext } from "@plurnk/plurnk-meta";

const mapOf = (entries: Record<string, string>, skipped: Record<string, string> = {}) =>
    async () => ({ registry: new Map(Object.entries(entries)), skipped: new Map(Object.entries(skipped)), attributions: new Map<string, string | string[]>() });

// Alias parsing is tested in @plurnk/plurnk-aliases (its owner). Here we
// exercise the resolution + two-tier instantiation this module owns; the active
// alias is driven end-to-end by loadActiveProvider below.

// — provider resolution ({§provider-resolution}) —

const fullEnv = Object.freeze({
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
    PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT: "0",
    PLURNK_PROVIDERS_REASONING: "off", PLURNK_PROVIDERS_TEMPERATURE: "0.2", PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15", PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0.4", PLURNK_PROVIDERS_REASONING_RESERVE: "10%", PLURNK_PROVIDERS_COMPLETION_RESERVE: "25%", PLURNK_PROVIDERS_PROBE_ATTEMPTS: "3", PLURNK_PROVIDERS_PROBE_DELAY: "1", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0", PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512", PLURNK_PROVIDERS_PROMPT_CACHE_KEY: "1",
    OPENAI_BASE_URL: "http://x",
});

test("instantiateProvider: cataloged name resolves in-framework, no scan, no import", async () => {
    resetDiscoveryCache();
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        throw new Error("unexpected fetch");
    });
    const imports: string[] = [];
    let scanned = false;
    const p = await instantiateProvider("openai", { ...fullEnv }, "m",
        async (s) => { imports.push(s); return {}; },
        async () => { scanned = true; return { registry: new Map(), skipped: new Map(), attributions: new Map() }; });
    assert.equal(p.model, "m");
    assert.deepEqual(imports, []); // tier 1 never touches the importer…
    assert.equal(scanned, false); // …nor the scan
    mock.restoreAll();
});

test("instantiateProvider: an installed AI SDK provider resolves through discovery", async () => {
    resetDiscoveryCache();
    const calls: unknown[] = [];
    const p = await instantiateProvider("acme", { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192" }, "model-a",
        async (specifier) => {
            calls.push(specifier);
            return { default: { languageModel: (model: string) => { calls.push(model); return {} as never; } } };
        },
        mapOf({ acme: "@acme/ai-provider" }));
    assert.equal(p.model, "model-a");
    assert.equal(p.contextWindow, 8192);
    assert.deepEqual(calls, ["@acme/ai-provider", "model-a"]);
});

test("instantiateProvider: a selected plugin composes its static and runtime attribution sources", async () => {
    resetDiscoveryCache();
    const context: PluginAttributionContext = {
        workspaceId: "workspace",
        workerId: "worker",
        primaryWorkerId: "primary",
        loop: 3,
        turn: 2,
        attempt: 1,
    };
    const sdkProvider = {
        languageModel: () => ({} as never),
        attributions: ({ attempt }: PluginAttributionContext) => attempt === 1
            ? ["runtime:provider", "static:provider"]
            : [],
    };
    const provider = await instantiateProvider(
        "acme",
        { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192" },
        "model-a",
        async () => ({ default: sdkProvider }),
        async () => ({
            registry: new Map([["acme", "@acme/ai-provider"]]),
            skipped: new Map(),
            attributions: new Map([["acme", "static:provider"]]),
            packageAttributions: new Map([["@acme/ai-provider", ["static:provider"]]]),
        }),
    );

    assert.deepEqual(provider.attributions?.(context), ["runtime:provider", "static:provider"]);
});

test("instantiateProvider: a per-alias baseUrl drives the built-in Ollama probe", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ model_info: { "qwen.context_length": 32768 } }));
    });
    await instantiateProvider("ollama", { ...fullEnv }, "qwen2.5-coder",
        async () => ({}),
        mapOf({}),
        "http://nook:11434");
    assert.deepEqual(calls, ["http://nook:11434/api/show"]);
    mock.restoreAll();
});

test("instantiateProvider: a per-alias baseUrl drives the standard openai probe to the override host", async () => {
    resetDiscoveryCache();
    const probed: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        probed.push(String(url));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await instantiateProvider("openai", { ...fullEnv }, "m", // fullEnv.OPENAI_BASE_URL is http://x — the override must win
        async () => ({}), async () => ({ registry: new Map(), skipped: new Map(), attributions: new Map() }),
        "http://hazel2:8080/v1");
    assert.ok(probed.some((u) => u === "http://hazel2:8080/v1/models"), `probe hit the override host; saw ${probed.join(", ")}`);
    assert.equal(probed.some((u) => u.startsWith("http://x")), false); // never the per-name OPENAI_BASE_URL
    mock.restoreAll();
});

test("instantiateProvider: a THIRD-PARTY scope is discovered — name maps to its package", async () => {
    resetDiscoveryCache();
    const imports: string[] = [];
    const p = await instantiateProvider("foo", { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW: "4096" }, "m",
        async (specifier) => { imports.push(specifier); return { default: { languageModel: () => ({} as never) } }; },
        mapOf({ foo: "@acme/acme-provider-foo" }));
    assert.equal(p.model, "m");
    assert.deepEqual(imports, ["@acme/acme-provider-foo"]); // not an @plurnk/ specifier
});

test("instantiateProvider: a cataloged name is authoritative — a scanned package of the same name is shadowed", async () => {
    resetDiscoveryCache();
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        throw new Error("unexpected fetch");
    });
    const imports: string[] = [];
    const p = await instantiateProvider("openai", { ...fullEnv }, "m",
        async (s) => { imports.push(s); return {}; },
        mapOf({ openai: "@acme/acme-provider-openai" })); // shadowed by tier 1
    assert.equal(p.model, "m");
    assert.deepEqual(imports, []); // the scanned same-name package is never imported
    mock.restoreAll();
});

test("instantiateProvider: unknown provider throws — no standard, no discovered package", async () => {
    resetDiscoveryCache();
    await assert.rejects(
        () => instantiateProvider("nope", { ...fullEnv }, "m", async () => ({}), mapOf({})),
        /unknown provider "nope"/,
    );
});

test("instantiateProvider: an untrusted (skipped) provider gives a precise error, not 'unknown'", async () => {
    resetDiscoveryCache();
    const imports: string[] = [];
    await assert.rejects(
        () => instantiateProvider("foo", { ...fullEnv }, "m",
            async (s) => { imports.push(s); return {}; },
            mapOf({}, { foo: "@acme/acme-provider-foo" })), // discovered but trust-declined
        /provider "foo" resolves to @acme\/acme-provider-foo, but it is untrusted under PLURNK_PLUGINS_TRUSTED_ONLY/,
    );
    assert.deepEqual(imports, []); // never imported an untrusted package
});

test("instantiateProvider: discovered package must export an AI SDK provider", async () => {
    resetDiscoveryCache();
    await assert.rejects(
        () => instantiateProvider("broken", { ...fullEnv }, "m",
            async () => ({ default: {} }),
            mapOf({ broken: "@acme/acme-provider-broken" })),
        /@acme\/acme-provider-broken default export is not an AI SDK provider/,
    );
});

test("instantiateProvider: a discovered package whose import throws fails hard, naming the specifier and preserving the cause", async () => {
    resetDiscoveryCache();
    const cause = new Error("ERR_MODULE_NOT_FOUND");
    await assert.rejects(
        () => instantiateProvider("foo", { ...fullEnv }, "m",
            async () => { throw cause; },
            mapOf({ foo: "@acme/acme-provider-foo" })),
        (err: Error) => {
            assert.match(err.message, /provider "foo" resolves to @acme\/acme-provider-foo, but importing it failed/);
            assert.equal(err.cause, cause); // original error preserved
            return true;
        },
    );
});

test("instantiateProvider: per-alias knobs scope through to the provider (per-alias scoping doctrine, user 2026-07-03)", async () => {
    resetDiscoveryCache();
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        if (String(url).endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const env = { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW_turbo: "12345", PLURNK_PROVIDERS_LLAMA_SERVER_turbo: "1" };
    const p = await instantiateProvider("openai", env, "m",
        async () => ({}), async () => ({ registry: new Map(), skipped: new Map(), attributions: new Map() }),
        undefined, "turbo");
    assert.equal(p.contextWindow, 12345); // _turbo CONTEXT_WINDOW reached the provider
    assert.equal(p.constrainsOutput, true); // _turbo LLAMA_SERVER pin reached it too
    // same env, DIFFERENT alias: neither override applies
    const q = await instantiateProvider("openai", env, "m",
        async () => ({}), async () => ({ registry: new Map(), skipped: new Map(), attributions: new Map() }),
        undefined, "plain");
    assert.equal(q.contextWindow, null);
    assert.equal(q.constrainsOutput, false);
    mock.restoreAll();
});

test("public construction applies the package floor to a sparse consumer environment", async () => {
    const provider = await instantiateProvider(
        "fireworks",
        { FIREWORKS_API_KEY: "fw" },
        "deepseek-v4-pro",
        async () => ({}),
        mapOf({}),
    );
    assert.equal(provider.model, "accounts/fireworks/models/deepseek-v4-pro");
});

test("{§deepseek-reasoning-request} #157: direct DeepSeek composes catalog facts, credential, reasoning control, and cached cost", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const chunks = [
            {
                id: "deepseek-test",
                object: "chat.completion.chunk",
                created: 1,
                model: "deepseek-v4-flash",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
                usage: null,
            },
            {
                id: "deepseek-test",
                object: "chat.completion.chunk",
                created: 1,
                model: "deepseek-v4-flash",
                choices: [],
                usage: {
                    prompt_tokens: 10,
                    prompt_cache_hit_tokens: 8,
                    prompt_cache_miss_tokens: 2,
                    completion_tokens: 2,
                    total_tokens: 12,
                },
            },
        ];
        const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]"].join("\n\n");
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const provider = await instantiateProvider(
        "deepseek",
        {
            DEEPSEEK_API_KEY: "test-key",
            PLURNK_PROVIDERS_REASONING: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        },
        "deepseek-v4-flash",
        async () => ({}),
        mapOf({}),
    );
    const response = await provider.generate({
        workerId: "worker",
        messages: [{ role: "user", content: "Reply with ok." }],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer test-key");
    const request = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    assert.equal(request.model, "deepseek-v4-flash");
    assert.deepEqual(request.thinking, { type: "disabled" });
    assert.equal(provider.contextWindow, 1_000_000);
    assert.equal(response.assistant.content, "ok");
    assert.deepEqual(response.assistant.usage, {
        prompt: 10,
        completion: 2,
        reasoning: 0,
        cached: 8,
        total: 12,
    });
    assert.ok(Math.abs(provider.calculateCost(response.assistant.usage) - 0.0000008624) < 1e-15);
    mock.restoreAll();
});

test("an explicit malformed operator override still fails at its owning contract", async () => {
    await assert.rejects(
        () => instantiateProvider(
            "fireworks",
            {
                FIREWORKS_API_KEY: "fw",
                PLURNK_PROVIDERS_PROMPT_CACHE_KEY: "malformed",
            },
            "deepseek-v4-pro",
            async () => ({}),
            mapOf({}),
        ),
        /fireworks provider: PLURNK_PROVIDERS_PROMPT_CACHE_KEY must be "0" or "1"/,
    );
});

test("a catalog provider with unknown model metadata never falls through to plugin discovery", async () => {
    let scanned = false;
    await assert.rejects(
        () => instantiateProvider(
            "cloudflare",
            {
                CLOUDFLARE_ACCOUNT_ID: "account",
                CLOUDFLARE_API_TOKEN: "token",
            },
            "vendor/model-outside-snapshot",
            async () => { throw new Error("plugin import must not run"); },
            async () => {
                scanned = true;
                return {
                    registry: new Map([["cloudflare", "@plurnk/plurnk-providers-cloudflare"]]),
                    skipped: new Map(),
                    attributions: new Map(),
                };
            },
        ),
        /cloudflare provider: context window unresolved for "vendor\/model-outside-snapshot" — set PLURNK_PROVIDERS_CONTEXT_WINDOW or update the Models.dev snapshot/,
    );
    assert.equal(scanned, false);
});

test("explicit metadata constructs an out-of-snapshot Cloudflare model in the consolidated transport", async () => {
    let scanned = false;
    const provider = await instantiateProvider(
        "cloudflare",
        {
            CLOUDFLARE_ACCOUNT_ID: "account",
            CLOUDFLARE_API_TOKEN: "token",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "128000",
        },
        "vendor/model-outside-snapshot",
        async () => { throw new Error("plugin import must not run"); },
        async () => {
            scanned = true;
            return {
                registry: new Map([["cloudflare", "@plurnk/plurnk-providers-cloudflare"]]),
                skipped: new Map(),
                attributions: new Map(),
            };
        },
    );
    assert.equal(provider.model, "vendor/model-outside-snapshot");
    assert.equal(provider.contextWindow, 128000);
    assert.equal(scanned, false);
});

test("{§provider-tagged-reasoning} a Cloudflare model alias carries its explicit response style through the public registry", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        calls.push(String(input));
        const chunks = [
            {
                id: "cloudflare-reasoning",
                object: "chat.completion.chunk",
                created: 1,
                model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
                choices: [{ index: 0, delta: { content: "<think>working</think>done" }, finish_reason: "stop" }],
            },
            {
                id: "cloudflare-reasoning",
                object: "chat.completion.chunk",
                created: 2,
                model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
                choices: [],
                usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
            },
        ];
        const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]"].join("\n\n");
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const provider = await instantiateProvider(
        "cloudflare",
        {
            ...fullEnv,
            CLOUDFLARE_ACCOUNT_ID: "account",
            CLOUDFLARE_API_TOKEN: "token",
            PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE: "verbatim",
            PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE_cfds1: "think-tags",
        },
        "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        async () => ({}),
        mapOf({}),
        undefined,
        "cfds1",
    );

    const response = await provider.generate({ workerId: "cloudflare-worker", messages: [] });

    assert.equal(response.assistant.reasoning, "working");
    assert.equal(response.assistant.content, "done");
    assert.deepEqual(calls, [
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
    ]);
});

test("two Fireworks aliases independently select default and priority service tiers", async () => {
    const bodies: Record<string, unknown>[] = [];
    mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const env = {
        ...fullEnv,
        FIREWORKS_BASE_URL: "https://api.fireworks.ai/inference/v1",
        FIREWORKS_API_KEY: "fw",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        PLURNK_PROVIDERS_PROVIDER_FIREWORKS_REASONING_STYLE: "effort_explicit",
        PLURNK_PROVIDERS_TOP_LOGPROBS: "2",
        PLURNK_PROVIDERS_SERVICE_TIER_fast: "priority",
        PLURNK_PROVIDERS_SERVICE_TIER_standard: "default",
    };
    const imports = async () => ({});
    const discover = async () => ({ registry: new Map(), skipped: new Map(), attributions: new Map() });
    const fast = await instantiateProvider("fireworks", env, "accounts/fireworks/routers/glm-5p2-fast", imports, discover, undefined, "fast");
    const standard = await instantiateProvider("fireworks", env, "deepseek-v4-pro", imports, discover, undefined, "standard");
    await fast.generate({ workerId: "fast-worker", messages: [] });
    await standard.generate({ workerId: "standard-worker", messages: [] });
    assert.deepEqual(bodies.map((body) => body.service_tier), ["priority", "default"]);
    assert.deepEqual(bodies.map((body) => body.prompt_cache_key), ["fast-worker", "standard-worker"]);
    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["none", "none"]);
    assert.deepEqual(bodies.map((body) => body.top_logprobs), [2, 2]);
    assert.deepEqual(bodies.map((body) => body.model), [
        "accounts/fireworks/routers/glm-5p2-fast",
        "accounts/fireworks/models/deepseek-v4-pro",
    ]);
    mock.restoreAll();
});

test("loadActiveProvider: resolves the alias cascade to an installed AI SDK provider", async () => {
    resetDiscoveryCache();
    const env = { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW: "4096", PLURNK_MODEL: "custom", PLURNK_MODEL_custom: "acme/model-a" } as NodeJS.ProcessEnv;
    const p = await loadActiveProvider(env,
        async () => ({ default: { languageModel: () => ({} as never) } }),
        mapOf({ acme: "@acme/ai-provider" }));
    assert.equal(p.model, "model-a");
});

test("loadActiveProvider: throws a named error when no alias is active", async () => {
    await assert.rejects(() => loadActiveProvider({ ...fullEnv }), /set PLURNK_MODEL to an alias/);
});

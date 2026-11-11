import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Mock, { type MockResponse } from "./Mock.ts";
import { instantiateProvider, loadActiveProvider, resetDiscoveryCache } from "./ProviderRegistry.ts";
import { catalogSnapshot, resolveModel } from "@plurnk/plurnk-models";
import { calculateCostUsdDecimal } from "./usage.ts";
import { requestBody, requestUrl } from "../../scripts/lib/test-fetch.ts";
import { discover } from "./discover.ts";
import { ProviderError } from "./errors.ts";
import { type ExtensionAttributionContext } from "@plurnk/plurnk-meta";
import { type Provider } from "./types.ts";

// Fireworks fixtures derive from the catalog: Models.dev retires ids, and a literal rots.
const fireworksIds = Object.keys(catalogSnapshot()["fireworks-ai"]);
const fireworksNative = fireworksIds.find((id) => id.startsWith("accounts/fireworks/models/")
    && fireworksIds.filter((other) => other.endsWith(`/${id.split("/").at(-1)}`)).length === 1)!;
const fireworksSuffix = fireworksNative.split("/").at(-1)!;
const fireworksRouter = fireworksIds.find((id) => id.startsWith("accounts/fireworks/routers/"))!;

// A rate literal breaks at every catalog refresh (the 1.17.0 stamp moved DeepSeek's rates); the
// claim under test is that the estimate is the catalog's rates applied to the reported usage.
const catalogRatesOf = (provider: string, model: string) => {
    const cost = resolveModel(provider, model)?.info.cost;
    if (cost === undefined) throw new Error(`${provider}/${model} has no catalog rates`);
    return {
        input: cost.inputPer1M,
        output: cost.outputPer1M,
        ...(cost.reasoningPer1M === undefined ? {} : { reasoning: cost.reasoningPer1M }),
        ...(cost.cacheReadPer1M === undefined ? {} : { cacheRead: cost.cacheReadPer1M }),
        ...(cost.cacheWritePer1M === undefined ? {} : { cacheWrite: cost.cacheWritePer1M }),
    };
};


const mapOf = (entries: Record<string, string>) =>
    async () => ({ registry: new Map(Object.entries(entries)) });

// Alias parsing is tested in @plurnk/plurnk-aliases (its owner). Here we
// exercise the resolution + two-tier instantiation this module owns; the active
// alias is driven end-to-end by loadActiveProvider below.

// — provider resolution ({§provider-configuration}) —

const fullEnv = Object.freeze({
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
    PLURNK_PROVIDERS_OPERATION_TIMEOUT: "2700000",
    PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_TEMPERATURE: "0.2", PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15", PLURNK_PROVIDERS_FREQUENCY_PENALTY: "0.4", PLURNK_PROVIDERS_OUTPUT_BUDGET: "35%", PLURNK_PROVIDERS_OUTPUT_FLOOR: "10%", PLURNK_PROVIDERS_PROBE_ATTEMPTS: "3", PLURNK_PROVIDERS_PROBE_DELAY: "1", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0", PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT: "512", PLURNK_PROVIDERS_CACHE_AFFINITY: "1", PLURNK_PROVIDERS_CACHE_WRITE_POLICY: "stable-system",
    OPENAI_BASE_URL: "http://x",
});

test("{§provider-configuration} instantiateProvider: cataloged name resolves in-framework, no scan, no import", async () => {
    resetDiscoveryCache();
    mock.method(globalThis, "fetch", async (url: string) => {
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        throw new Error("unexpected fetch");
    });
    const imports: string[] = [];
    let scanned = false;
    const p = await instantiateProvider("openai", { ...fullEnv }, "m",
        async (s) => { imports.push(s); return {}; },
        async () => { scanned = true; return { registry: new Map() }; });
    assert.equal(p.model, "m");
    assert.deepEqual(imports, []); // tier 1 never touches the importer…
    assert.equal(scanned, false); // …nor the scan
    mock.restoreAll();
});

test("{§provider-configuration} instantiateProvider: an installed provider extension resolves through discovery", async () => {
    resetDiscoveryCache();
    const calls: unknown[] = [];
    const p = await instantiateProvider("bespoke", { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192" }, "model-a",
        async (specifier) => {
            calls.push(specifier);
            return { default: { model: (model: string) => { calls.push(model); return {} as never; } } };
        },
        mapOf({ bespoke: "@plurnk/plurnk-providers-bespoke" }));
    assert.equal(p.model, "model-a");
    assert.equal(p.contextWindow, 8192);
    assert.deepEqual(calls, ["@plurnk/plurnk-providers-bespoke", "model-a"]);
});

test("{§provider-configuration} instantiateProvider: a selected extension composes its static and runtime attribution sources", async () => {
    resetDiscoveryCache();
    const context: ExtensionAttributionContext = {
        workspaceId: "workspace",
        sessionId: "session",
        loop: 3,
        turn: 2,
        attempt: 1,
    };
    const providerExtension = {
        model: () => ({} as never),
        attributions: ({ attempt }: ExtensionAttributionContext) => attempt === 1
            ? ["runtime:provider", "static:provider"]
            : [],
    };
    const provider = await instantiateProvider(
        "bespoke",
        { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192" },
        "model-a",
        async () => ({ default: providerExtension }),
        async () => ({
            registry: new Map([["bespoke", "@plurnk/plurnk-providers-bespoke"]]),
            packageAttributions: new Map([["@plurnk/plurnk-providers-bespoke", ["static:provider"]]]),
        }),
    );

    assert.deepEqual(provider.attributions?.(context), ["runtime:provider", "static:provider"]);
});

test("{§provider-configuration} instantiateProvider: a per-alias baseUrl drives the built-in Ollama probe", async () => {
    resetDiscoveryCache();
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ model_info: { "qwen.context_length": 32768 } }));
    });
    await instantiateProvider("ollama", { ...fullEnv }, "qwen2.5-coder",
        async () => ({}),
        mapOf({}),
        "http://nook:11434");
    assert.deepEqual(calls, ["http://nook:11434/api/show"]);
    mock.restoreAll();
});

test("{§provider-configuration} instantiateProvider: a per-alias baseUrl drives the standard openai probe to the override host", async () => {
    resetDiscoveryCache();
    const probed: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
        probed.push(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await instantiateProvider("openai", { ...fullEnv }, "m", // fullEnv.OPENAI_BASE_URL is http://x — the override must win
        async () => ({}), async () => ({ registry: new Map() }),
        "http://hazel2:8080/v1");
    assert.ok(probed.some((u) => u === "http://hazel2:8080/v1/models"), `probe hit the override host; saw ${probed.join(", ")}`);
    assert.equal(probed.some((u) => u.startsWith("http://x")), false); // never the per-name OPENAI_BASE_URL
    mock.restoreAll();
});

test("{§provider-configuration} instantiateProvider: a cataloged name is authoritative — a scanned package of the same name is shadowed", async () => {
    resetDiscoveryCache();
    mock.method(globalThis, "fetch", async (url: string) => {
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        throw new Error("unexpected fetch");
    });
    const imports: string[] = [];
    const p = await instantiateProvider("openai", { ...fullEnv }, "m",
        async (s) => { imports.push(s); return {}; },
        mapOf({ openai: "@plurnk/plurnk-providers-openai" })); // shadowed by tier 1
    assert.equal(p.model, "m");
    assert.deepEqual(imports, []); // the scanned same-name package is never imported
    mock.restoreAll();
});

test("{§provider-configuration} instantiateProvider: unknown provider throws — no standard, no discovered package", async () => {
    resetDiscoveryCache();
    await assert.rejects(
        () => instantiateProvider("nope", { ...fullEnv }, "m", async () => ({}), mapOf({})),
        /unknown provider "nope"/,
    );
});

test("{§provider-configuration} instantiateProvider: discovered package must export a provider extension", async () => {
    resetDiscoveryCache();
    await assert.rejects(
        () => instantiateProvider("broken", { ...fullEnv }, "m",
            async () => ({ default: {} }),
            mapOf({ broken: "@plurnk/plurnk-providers-broken" })),
        /@plurnk\/plurnk-providers-broken default export is not a provider extension/,
    );
});

test("{§provider-configuration} instantiateProvider: a discovered package whose import throws fails hard, naming the specifier and preserving the cause", async () => {
    resetDiscoveryCache();
    const cause = new Error("ERR_MODULE_NOT_FOUND");
    await assert.rejects(
        () => instantiateProvider("foo", { ...fullEnv }, "m",
            async () => { throw cause; },
            mapOf({ foo: "@plurnk/plurnk-providers-foo" })),
        (err: Error) => {
            assert.match(err.message, /provider "foo" resolves to @plurnk\/plurnk-providers-foo, but importing it failed/);
            assert.equal(err.cause, cause); // original error preserved
            return true;
        },
    );
});

test("instantiateProvider: per-alias knobs scope through to the provider ({§provider-configuration})", async () => {
    resetDiscoveryCache();
    mock.method(globalThis, "fetch", async (url: string) => {
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        if (url.endsWith("/props")) return new Response(JSON.stringify({ total_slots: 1 }), { status: 200 });
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const env = { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW_turbo: "12345", PLURNK_PROVIDERS_LLAMA_SERVER_turbo: "1" };
    const p = await instantiateProvider("openai", env, "m",
        async () => ({}), async () => ({ registry: new Map() }),
        undefined, "turbo");
    assert.equal(p.contextWindow, 12345); // _turbo CONTEXT_WINDOW reached the provider
    assert.equal(p.requiresOutputBudget, true); // _turbo LLAMA_SERVER pin reached it too
    // same env, DIFFERENT alias: neither override applies
    const q = await instantiateProvider("openai", env, "m",
        async () => ({}), async () => ({ registry: new Map() }),
        undefined, "plain");
    assert.equal(q.contextWindow, null);
    assert.equal(q.requiresOutputBudget, undefined);
    mock.restoreAll();
});

test("{§provider-configuration} public construction applies the package floor to a sparse consumer environment", async () => {
    const provider = await instantiateProvider(
        "fireworks-ai",
        { FIREWORKS_API_KEY: "fw" },
        fireworksSuffix,
        async () => ({}),
        mapOf({}),
    );
    assert.equal(provider.model, fireworksNative);
});

test("{§provider-effort} #157: direct DeepSeek composes catalog facts, credential, reasoning control, and cached cost", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: requestUrl(url), init });
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
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        },
        "deepseek-v4-flash",
        async () => ({}),
        mapOf({}),
    );
    const response = await provider.generate({
        sessionId: "session",
        messages: [{ role: "user", content: "Reply with ok." }],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer test-key");
    const request = JSON.parse(requestBody(calls[0].init)) as Record<string, unknown>;
    assert.equal(request.model, "deepseek-v4-flash");
    assert.deepEqual(request.thinking, { type: "disabled" });
    assert.equal(provider.contextWindow, resolveModel("deepseek", "deepseek-v4-flash")!.info.contextWindow);
    assert.equal(response.assistant.content, "ok");
    assert.deepEqual(response.accounting[0]?.usage, {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 8, cacheWriteTokens: 0 },
    });
    const expected = calculateCostUsdDecimal(response.accounting[0].usage, catalogRatesOf("deepseek", "deepseek-v4-flash"));
    assert.match(String(expected), /^0\.0*[1-9]/, "the catalog prices this usage");
    assert.deepEqual(response.accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: expected, currency: "USD" },
        source: "Models.dev catalog rates",
    });
    mock.restoreAll();
});

test("{§provider-configuration} an explicit malformed cache-affinity override still fails at its owning contract", async () => {
    await assert.rejects(
        () => instantiateProvider(
            "fireworks-ai",
            {
                FIREWORKS_API_KEY: "fw",
                PLURNK_PROVIDERS_CACHE_AFFINITY: "malformed",
            },
            fireworksSuffix,
            async () => ({}),
            mapOf({}),
        ),
        /fireworks-ai provider: PLURNK_PROVIDERS_CACHE_AFFINITY must be "0" or "1"/,
    );
});

test("{§provider-configuration} a catalog provider with unknown model metadata never falls through to extension discovery", async () => {
    let scanned = false;
    await assert.rejects(
        () => instantiateProvider(
            "cloudflare-workers-ai",
            {
                CLOUDFLARE_ACCOUNT_ID: "account",
                CLOUDFLARE_API_KEY: "token",
            },
            "vendor/model-outside-snapshot",
            async () => { throw new Error("extension import must not run"); },
            async () => {
                scanned = true;
                return {
                    registry: new Map([["cloudflare-workers-ai", "@plurnk/plurnk-providers-cloudflare"]]),
                };
            },
        ),
        /cloudflare-workers-ai provider: model "vendor\/model-outside-snapshot" is not a Models\.dev id or a unique path suffix of one — correct the model id, or set PLURNK_PROVIDERS_CONTEXT_WINDOW to route an uncataloged model/,
    );
    assert.equal(scanned, false);
});

test("{§provider-configuration} explicit metadata constructs an out-of-snapshot Cloudflare model in the consolidated transport", async () => {
    let scanned = false;
    const provider = await instantiateProvider(
        "cloudflare-workers-ai",
        {
            CLOUDFLARE_ACCOUNT_ID: "account",
            CLOUDFLARE_API_KEY: "token",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "128000",
        },
        "vendor/model-outside-snapshot",
        async () => { throw new Error("extension import must not run"); },
        async () => {
            scanned = true;
            return {
                registry: new Map([["cloudflare-workers-ai", "@plurnk/plurnk-providers-cloudflare"]]),
            };
        },
    );
    assert.equal(provider.model, "vendor/model-outside-snapshot");
    assert.equal(provider.contextWindow, 128000);
    assert.equal(scanned, false);
});

test("{§provider-interface} a Cloudflare model alias carries its explicit response style through the public registry", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        calls.push(requestUrl(input));
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
        "cloudflare-workers-ai",
        {
            ...fullEnv,
            CLOUDFLARE_ACCOUNT_ID: "account",
            CLOUDFLARE_API_KEY: "token",
            PLURNK_PROVIDERS_EFFORT: "adaptive",
            PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE: "verbatim",
            PLURNK_PROVIDERS_REASONING_RESPONSE_STYLE_cfds1: "think-tags",
        },
        "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        async () => ({}),
        mapOf({}),
        undefined,
        "cfds1",
    );

    const response = await provider.generate({ sessionId: "cloudflare-session", messages: [] });

    assert.equal(response.assistant.reasoning, "working");
    assert.equal(response.assistant.content, "done");
    assert.deepEqual(calls, [
        "https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions",
    ]);
});

test("{§provider-configuration} two Fireworks aliases independently select default and priority service tiers", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
        headers.push(new Headers(init?.headers));
        const chunk = {
            id: "fireworks-test",
            object: "chat.completion.chunk",
            created: 1,
            model: "fireworks-test",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
    });
    const env = {
        ...fullEnv,
        FIREWORKS_BASE_URL: "https://api.fireworks.ai/inference/v1",
        FIREWORKS_API_KEY: "fw",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "8192",
        PLURNK_PROVIDERS_TOP_LOGPROBS: "2",
        PLURNK_PROVIDERS_SERVICE_TIER_fast: "priority",
        PLURNK_PROVIDERS_SERVICE_TIER_standard: "default",
    };
    const imports = async () => ({});
    const stubDiscover = async () => ({ registry: new Map() });
    const fast = await instantiateProvider("fireworks-ai", env, fireworksRouter, imports, stubDiscover, undefined, "fast");
    const standard = await instantiateProvider("fireworks-ai", env, fireworksSuffix, imports, stubDiscover, undefined, "standard");
    await fast.generate({ sessionId: "fast-session", messages: [] });
    await standard.generate({ sessionId: "standard-session", messages: [] });
    assert.deepEqual(bodies.map((body) => body.service_tier), ["priority", "default"]);
    assert.deepEqual(headers.map((header) => header.get("x-session-affinity")), ["fast-session", "standard-session"]);
    assert.deepEqual(bodies.map((body) => body.prompt_cache_key), [undefined, undefined]);
    assert.deepEqual(bodies.map((body) => body.reasoning_effort), ["none", "none"]);
    assert.deepEqual(bodies.map((body) => body.top_logprobs), [2, 2]);
    assert.deepEqual(bodies.map((body) => body.model), [
        fireworksRouter,
        fireworksNative,
    ]);
    mock.restoreAll();
});

test("{§provider-configuration} loadActiveProvider: resolves the alias cascade to an installed provider extension", async () => {
    resetDiscoveryCache();
    const env = { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_WINDOW: "4096", PLURNK_MODEL: "custom", PLURNK_MODEL_custom: "bespoke/model-a" } as NodeJS.ProcessEnv;
    const p = await loadActiveProvider(env,
        async () => ({ default: { model: () => ({} as never) } }),
        mapOf({ bespoke: "@plurnk/plurnk-providers-bespoke" }));
    assert.equal(p.model, "model-a");
});

test("{§provider-configuration} loadActiveProvider: throws a named error when no alias is active", async () => {
    await assert.rejects(
        () => loadActiveProvider({ ...fullEnv }),
        /set PLURNK_MODEL to a declared alias or provider\/model route/,
    );
});

{
// Create a temp dir and register its removal on the test context, so it is
// cleaned on a GREEN or RED run. A trailing rm after the assertions leaks the dir
// whenever one throws — thousands accumulate on a shared box at drill frequency.
const tempDir = async (t: TestContext, prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
};

const buildModules = async (t: TestContext, packages: Record<string, unknown>): Promise<string> => {
    const root = await tempDir(t, "providers-scan-");
    for (const [rel, pkg] of Object.entries(packages)) {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    }
    return root;
};

test("{§extension-discovery} discover: admits first-party @plurnk/* provider packages and ignores third-party, unscoped, and non-provider packages", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/plurnk-provider-native": { name: "@plurnk/plurnk-provider-native", plurnk: { kind: "provider", name: "native" } },
        "@acme/acme-provider-foo": { name: "@acme/acme-provider-foo", plurnk: { kind: "provider", name: "foo" } },
        "unscoped-provider-bar": { name: "unscoped-provider-bar", plurnk: { kind: "provider", name: "bar" } },
        "left-pad": { name: "left-pad" },
        "@plurnk/plurnk-execs-wrong-kind": { name: "@plurnk/plurnk-execs-wrong-kind", plurnk: { kind: "exec", runtimes: [] } },
    });
    const { registry } = await discover({ cwd: root });
    assert.deepEqual([...registry.entries()], [["native", "@plurnk/plurnk-provider-native"]]);
});

test("{§extension-discovery} discover: a provider package missing plurnk.name is ignored, not crashed", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/headless": { name: "@plurnk/headless", plurnk: { kind: "provider" } },
        "@plurnk/named": { name: "@plurnk/named", plurnk: { kind: "provider", name: "named" } },
    });
    const { registry } = await discover({ cwd: root });
    assert.deepEqual([...registry.keys()], ["named"]);
});

test("{§extension-discovery} discover: an array kind declares no provider extension", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/dual": {
            name: "@plurnk/dual",
            plurnk: { kind: ["provider", "scheme"], name: "dual" },
        },
    });
    const { registry } = await discover({ cwd: root });
    assert.equal(registry.size, 0);
});

test("{§extension-discovery} discover: a name claimed by two @plurnk/* packages is a fail-hard collision", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/plurnk-provider-native": { name: "@plurnk/plurnk-provider-native", plurnk: { kind: "provider", name: "native" } },
        "@plurnk/rival-native": { name: "@plurnk/rival-native", plurnk: { kind: "provider", name: "native" } },
    });
    await assert.rejects(
        () => discover({ cwd: root }),
        /provider name collision: 'native' claimed by both/,
    );
});

test("{§extension-discovery} discover: node_modules entries with no package.json or malformed JSON are skipped, not crashed", async (t) => {
    const root = await tempDir(t, "providers-junk-");
    const nm = path.join(root, "node_modules");
    await fs.mkdir(path.join(nm, "@plurnk", "no-manifest"), { recursive: true });
    await fs.mkdir(path.join(nm, "@plurnk", "broken"), { recursive: true });
    await fs.writeFile(path.join(nm, "@plurnk", "broken", "package.json"), "{ not json", "utf-8");
    const good = path.join(nm, "@plurnk", "plurnk-provider-native");
    await fs.mkdir(good, { recursive: true });
    await fs.writeFile(path.join(good, "package.json"), JSON.stringify({ name: "@plurnk/plurnk-provider-native", plurnk: { kind: "provider", name: "native" } }), "utf-8");
    const { registry } = await discover({ cwd: root });
    assert.deepEqual([...registry.keys()], ["native"]);
});

test("{§extension-discovery} discover: normalizes attribution per package", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/provider-solo": { name: "@plurnk/provider-solo", plurnk: { kind: "provider", name: "solo", attribution: "@plurnk/solo" } },
        "@plurnk/provider-multi": { name: "@plurnk/provider-multi", plurnk: { kind: "provider", name: "multi", attribution: ["@plurnk/a", "@plurnk/b"] } },
        "@plurnk/provider-none": { name: "@plurnk/provider-none", plurnk: { kind: "provider", name: "none" } },
    });
    const { packageAttributions } = await discover({ cwd: root });
    assert.deepEqual([...packageAttributions], [
        ["@plurnk/provider-multi", ["@plurnk/a", "@plurnk/b"]],
        ["@plurnk/provider-solo", ["@plurnk/solo"]],
    ]);
});

test("{§extension-discovery} discover: validates first-party attribution before provider admission and ignores non-@plurnk/* packages", async (t) => {
    const root = await buildModules(t, {
        "@plurnk/provider-bad": { name: "@plurnk/provider-bad", plurnk: { kind: "provider", name: "bad", attribution: 42 } },
    });
    await assert.rejects(
        discover({ cwd: root }),
        /extension '@plurnk\/provider-bad': plurnk\.attribution must be a non-empty string or string\[\]/,
    );

    const thirdPartyRoot = await buildModules(t, {
        "@acme/provider-bad": { name: "@acme/provider-bad", plurnk: { kind: "provider", name: "bad", attribution: ["ok", 42] } },
    });
    const result = await discover({ cwd: thirdPartyRoot });
    assert.equal(result.registry.size, 0);
    assert.equal(result.packageAttributions.size, 0);
});

test("{§extension-discovery} discover: missing node_modules yields an empty registry, not an error", async (t) => {
    const root = await tempDir(t, "providers-empty-");
    const { registry } = await discover({ cwd: root });
    assert.equal(registry.size, 0);
});
}

{
const build = (responses: MockResponse[] = [{ assistant: { content: "hi", reasoning: null } }]) =>
    new Mock({ contextWindow: 100000, responses });

// The suite runs on this package's own panel, which ships an output budget. "No budget" is therefore
// something a test states — the panel's explicit empty value — never an ambient absence of the key.
const withoutOutputBudget = <T>(body: () => T): T => {
    const panel = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
    process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "";
    try { return body(); } finally { process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = panel; }
};

// — Identity ({§provider-interface}) —

test("{§provider-interface} Mock: contextWindow and model are stable across reads", () => {
    const m = withoutOutputBudget(() => build());
    assert.equal(m.contextWindow, 100000);
    assert.equal(m.inputCapacity, null);
    assert.equal(m.contextWindow, 100000);
    assert.equal(m.model, "mock");
    assert.equal(m.model, "mock");
});

test("{§provider-interface} Mock: contextWindow passes null through", () => {
    const m = new Mock({ contextWindow: null, responses: [] });
    assert.equal(m.contextWindow, null);
});

// — Tokenomics ({§provider-interface}) —

test("{§provider-interface} Mock: prompt counting is exact for its declared mock vocabulary", async () => {
    const m = build();
    assert.deepEqual(await m.countPromptTokens([]), {
        kind: "exact", tokens: 0, source: "mock:chars2",
    });
    assert.deepEqual(await m.countPromptTokens([{ role: "user", content: "four" }]), {
        kind: "exact", tokens: 2, source: "mock:chars2",
    });
});

// — Transport ({§provider-interface}) —

test("{§provider-interface} Mock: generate resolves a valid ProviderResponse shape", async () => {
    const m = build([{ assistant: { content: "hello", reasoning: "cot" } }]);
    const reasoning: string[] = [];
    const { assistant, assistantRaw, accounting } = await m.generate({
        messages: [],
        observeReasoning: (delta) => reasoning.push(delta),
    });
    assert.equal(assistant.content, "hello");
    assert.equal(assistant.reasoning, "cot");
    assert.deepEqual(accounting[0]?.usage, {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
    });
    assert.deepEqual(accounting[0]?.cost, {
        kind: "estimated",
        amount: { amount: "0", currency: "USD" },
        source: "mock provider fixture",
    });
    assert.equal(assistant.finishReason, "stop");
    assert.equal(assistant.model, "mock");
    assert.equal(assistantRaw, null); // present, defaulted
    assert.deepEqual(reasoning, ["cot"]);
});

test("{§provider-interface} Mock: generate applies caller-supplied overrides", async () => {
    const m = build([{
        assistant: {
            content: "x",
            reasoning: null,
            finishReason: "length",
            model: "mock-xl",
        },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        assistantRaw: { wire: true },
    }]);
    const { assistant, assistantRaw, accounting } = await m.generate({ messages: [] });
    assert.equal(assistant.finishReason, "length");
    assert.equal(assistant.model, "mock-xl");
    assert.deepEqual(accounting[0]?.usage, {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
    });
    assert.deepEqual(assistantRaw, { wire: true });
});

test("{§provider-interface} Mock: ops escape hatch passes through when provided", async () => {
    const ops = [{ kind: "send" }] as never;
    const m = build([{ assistant: { content: "x", reasoning: null, ops } }]);
    const { assistant } = await m.generate({ messages: [] });
    assert.deepEqual(assistant.ops, ops);
});

test("{§provider-failure-normalization} Mock: ops absent when not provided", async () => {
    const m = build();
    const { assistant } = await m.generate({ messages: [] });
    assert.equal("ops" in assistant, false);
});

// — Abort ({§provider-failure-normalization}) —

test("{§provider-interface} Mock: generate with a pre-aborted signal rejects and consumes no response", async () => {
    const m = build([{ assistant: { content: "untouched", reasoning: null } }]);
    const signal = AbortSignal.abort(new Error("boom"));
    await assert.rejects(() => m.generate({ messages: [], signal }), /boom/);
    assert.equal(m.remaining, 1); // queue untouched — no "wire call" made
});

// — Lifecycle —

test("{§provider-interface} Mock: remaining decrements as responses are consumed", async () => {
    const m = build([
        { assistant: { content: "a", reasoning: null } },
        { assistant: { content: "b", reasoning: null } },
    ]);
    assert.equal(m.remaining, 2);
    await m.generate({ messages: [] });
    assert.equal(m.remaining, 1);
});

test("{§provider-configuration} Mock: exhausted queue throws a ProviderError carrying its settled accounting", async () => {
    const m = build([]);
    await assert.rejects(
        () => m.generate({ messages: [] }),
        (error: unknown) => {
            assert.ok(error instanceof ProviderError);
            assert.match(error.message, /exhausted/);
            assert.deepEqual(error.accounting, [{
                provider: "provider:mock",
                model: "mock",
                outcome: "error",
                cost: {
                    kind: "unknown",
                    reason: "mock provider exhausted before producing a response",
                },
            }]);
            return true;
        },
    );
});

// -- {§provider-configuration} --

test("{§provider-capacity-admission} the generation-envelope getters are on the Provider interface", () => {
    const previous = {
        output: process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET,
        floor: process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR,
        reasoning: process.env.PLURNK_PROVIDERS_REASONING_BUDGET,
    };
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "35%";
        process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR = "10%";
        process.env.PLURNK_PROVIDERS_REASONING_BUDGET = "10%";
        const p: Provider = new Mock({ contextWindow: 49152, responses: [] });
        assert.equal(p.outputBudget, 17_203);
        assert.equal(p.outputFloor, 4_915);
        assert.equal(p.reasoningBudget, 4_915);
        assert.equal(p.inputCapacity, 31_949);
        assert.equal(p.inputWall, 44_237, "the wall is the window less the floor ({§provider-capacity-admission})");
    } finally {
        if (previous.output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previous.output;
        if (previous.floor === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR;
        else process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR = previous.floor;
        if (previous.reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previous.reasoning;
    }
});

test("{§provider-capacity-admission} an empty output floor leaves a Mock without a wall", () => {
    const panel = process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR;
    process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR = "";
    try {
        const m = new Mock({ contextWindow: 49152, responses: [] });
        assert.equal(m.outputFloor, null);
        assert.equal(m.inputWall, null);
    } finally {
        if (panel === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR;
        else process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR = panel;
    }
});

test("{§provider-interface} Mock resolves percentage and absolute generation budgets against its window", () => {
    const previous = {
        output: process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET,
        reasoning: process.env.PLURNK_PROVIDERS_REASONING_BUDGET,
    };
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = "35%";
        process.env.PLURNK_PROVIDERS_REASONING_BUDGET = "8192";
        const m = new Mock({ contextWindow: 49152, responses: [] });
        assert.equal(m.outputBudget, 17_203);
        assert.equal(m.reasoningBudget, 8_192);
    } finally {
        if (previous.output === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
        else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = previous.output;
        if (previous.reasoning === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = previous.reasoning;
    }
});

test("{§provider-interface} an empty generation budget leaves a bare Mock unbounded", () => {
    const m = withoutOutputBudget(() => new Mock({ contextWindow: 49152, responses: [] }));
    assert.equal(m.outputBudget, null);
    assert.equal(m.reasoningBudget, null);
    assert.equal(m.inputCapacity, null);
});
}

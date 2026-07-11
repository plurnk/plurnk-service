import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { instantiateProvider, loadActiveProvider, resetDiscoveryCache } from "./ProviderRegistry.ts";

const fakeProvider = { contextSize: 1, model: "m", countTokens: () => 0, costFor: () => 0, generate: async () => { throw new Error("unused"); } };
const mapOf = (entries: Record<string, string>, skipped: Record<string, string> = {}) =>
    async () => ({ registry: new Map(Object.entries(entries)), skipped: new Map(Object.entries(skipped)), attributions: new Map<string, string | string[]>() });

// Alias PARSING is tested in @plurnk/plurnk-aliases (its owner, #27). Here we
// exercise the resolution + two-tier instantiation this module owns; the active
// alias is driven end-to-end by loadActiveProvider below.

// — two-tier instantiation (SPEC §5) —

const fullEnv = Object.freeze({
    PLURNK_PROVIDERS_FETCH_TIMEOUT: "600000",
    PLURNK_PROVIDERS_THINKING: "off", PLURNK_PROVIDERS_TEMPERATURE: "0.2", PLURNK_PROVIDERS_REPEAT_PENALTY: "1.15", PLURNK_PROVIDERS_RETRY_DELAY: "1", PLURNK_PROVIDERS_PROBE_ATTEMPTS: "3", PLURNK_PROVIDERS_PROBE_DELAY: "1", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    OPENAI_BASE_URL: "http://x",
});

test("instantiateProvider: standard name resolves in-framework, no scan, no import", async () => {
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

test("instantiateProvider: bespoke name resolves via the scan and imports the discovered package", async () => {
    resetDiscoveryCache();
    const calls: unknown[] = [];
    const p = await instantiateProvider("openrouter", { ...fullEnv }, "anthropic/claude-opus-latest",
        async (specifier) => { calls.push(specifier); return { default: { fromEnv: async (_e: NodeJS.ProcessEnv, model: string) => { calls.push(model); return fakeProvider; } } }; },
        mapOf({ openrouter: "@plurnk/plurnk-providers-openrouter" }));
    assert.equal(p, fakeProvider);
    assert.deepEqual(calls, ["@plurnk/plurnk-providers-openrouter", "anthropic/claude-opus-latest"]);
});

test("instantiateProvider: a per-alias baseUrl is passed to a bespoke factory as the 3rd-arg option", async () => {
    resetDiscoveryCache();
    let received: unknown;
    await instantiateProvider("ollama", { ...fullEnv }, "qwen2.5-coder",
        async () => ({ default: { fromEnv: async (_e: NodeJS.ProcessEnv, _m: string, options?: unknown) => { received = options; return fakeProvider; } } }),
        mapOf({ ollama: "@plurnk/plurnk-providers-ollama" }),
        "http://nook:11434");
    assert.deepEqual(received, { baseUrl: "http://nook:11434" });
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
    const p = await instantiateProvider("foo", { ...fullEnv }, "m",
        async (specifier) => { imports.push(specifier); return { default: { fromEnv: async () => fakeProvider } }; },
        mapOf({ foo: "@acme/acme-provider-foo" }));
    assert.equal(p, fakeProvider);
    assert.deepEqual(imports, ["@acme/acme-provider-foo"]); // not an @plurnk/ specifier
});

test("instantiateProvider: a standard name is authoritative — a scanned package of the same name is shadowed", async () => {
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
        /unknown provider "nope": not a standard provider, and no installed package declares plurnk\.kind:"provider" with name "nope"/,
    );
});

test("instantiateProvider: an untrusted (skipped) provider gives a precise error, not 'unknown' (#15)", async () => {
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

test("instantiateProvider: discovered package without a fromEnv factory throws (factory shape, SPEC §10.1)", async () => {
    resetDiscoveryCache();
    await assert.rejects(
        () => instantiateProvider("broken", { ...fullEnv }, "m",
            async () => ({ default: {} }),
            mapOf({ broken: "@acme/acme-provider-broken" })),
        /@acme\/acme-provider-broken default export is not a Provider factory/,
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
    const env = { ...fullEnv, PLURNK_PROVIDERS_CONTEXT_SIZE_turbo: "12345", PLURNK_PROVIDERS_LLAMA_SERVER_turbo: "1" };
    const p = await instantiateProvider("openai", env, "m",
        async () => ({}), async () => ({ registry: new Map(), skipped: new Map(), attributions: new Map() }),
        undefined, "turbo");
    assert.equal(p.contextSize, 12345); // _turbo CONTEXT_SIZE reached the provider
    assert.equal(p.constrainsOutput, true); // _turbo LLAMA_SERVER pin reached it too
    // same env, DIFFERENT alias: neither override applies
    const q = await instantiateProvider("openai", env, "m",
        async () => ({}), async () => ({ registry: new Map(), skipped: new Map(), attributions: new Map() }),
        undefined, "plain");
    assert.equal(q.contextSize, null);
    assert.equal(q.constrainsOutput, false);
    mock.restoreAll();
});

test("loadActiveProvider: resolves the alias cascade end-to-end via the scan", async () => {
    resetDiscoveryCache();
    const env = { ...fullEnv, PLURNK_MODEL: "opus", PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus-latest" } as NodeJS.ProcessEnv;
    const p = await loadActiveProvider(env,
        async () => ({ default: { fromEnv: async () => fakeProvider } }),
        mapOf({ openrouter: "@plurnk/plurnk-providers-openrouter" }));
    assert.equal(p, fakeProvider);
});

test("loadActiveProvider: throws a named error when no alias is active", async () => {
    await assert.rejects(() => loadActiveProvider({ ...fullEnv }), /set PLURNK_MODEL to an alias/);
});

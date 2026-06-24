import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { parseAliasesFromEnv, resolveActiveAlias, instantiateProvider, loadActiveProvider, resetDiscoveryCache } from "./ProviderRegistry.ts";

const fakeProvider = { contextSize: 1, model: "m", countTokens: () => 0, costFor: () => 0, generate: async () => { throw new Error("unused"); } };
const mapOf = (entries: Record<string, string>, skipped: Record<string, string> = {}) =>
    async () => ({ registry: new Map(Object.entries(entries)), skipped: new Map(Object.entries(skipped)), attributions: new Map<string, string | string[]>() });

test("parseAliasesFromEnv: extracts PLURNK_MODEL_<alias>=<provider>/<model>", () => {
    const env = {
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus-latest",
        PLURNK_MODEL: "gemma",
        OTHER_VAR: "ignored",
    } as NodeJS.ProcessEnv;
    const aliases = parseAliasesFromEnv(env);
    assert.equal(aliases.length, 2);
    const gemma = aliases.find((a) => a.alias === "gemma");
    assert.deepEqual(gemma, { alias: "gemma", provider: "openai", model: "macher.gguf" });
    const opus = aliases.find((a) => a.alias === "opus");
    assert.deepEqual(opus, { alias: "opus", provider: "openrouter", model: "anthropic/claude-opus-latest" });
});

test("parseAliasesFromEnv: lowercases alias key", () => {
    const env = { PLURNK_MODEL_GEMMA: "openai/macher.gguf" } as NodeJS.ProcessEnv;
    const aliases = parseAliasesFromEnv(env);
    assert.equal(aliases[0].alias, "gemma");
});

test("parseAliasesFromEnv: skips entries without slash", () => {
    const env = { PLURNK_MODEL_bad: "no-slash-here" } as NodeJS.ProcessEnv;
    assert.deepEqual(parseAliasesFromEnv(env), []);
});

test("parseAliasesFromEnv: skips empty values", () => {
    const env = { PLURNK_MODEL_empty: "" } as NodeJS.ProcessEnv;
    assert.deepEqual(parseAliasesFromEnv(env), []);
});

test("parseAliasesFromEnv: tri-level value with multiple slashes preserves model id", () => {
    const env = { PLURNK_MODEL_x: "openrouter/anthropic/claude/3.5" } as NodeJS.ProcessEnv;
    const [alias] = parseAliasesFromEnv(env);
    assert.equal(alias.provider, "openrouter");
    assert.equal(alias.model, "anthropic/claude/3.5");
});

test("parseAliasesFromEnv: fails hard on case-folding alias collision", () => {
    const env = {
        PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus",
        PLURNK_MODEL_OPUS: "anthropic/claude-opus-latest",
    } as NodeJS.ProcessEnv;
    assert.throws(() => parseAliasesFromEnv(env), /Duplicate provider alias "opus"/);
});

test("parseAliasesFromEnv: PLURNK_BASEURL_<alias> attaches a per-alias endpoint override (case-folded)", () => {
    const env = {
        PLURNK_MODEL_HAZEL1: "openai/qwen2.5-coder",
        PLURNK_BASEURL_HAZEL1: "http://hazel1:8080/v1",
        PLURNK_MODEL_plain: "openai/m", // no override → no baseUrl key
    } as NodeJS.ProcessEnv;
    const aliases = parseAliasesFromEnv(env);
    assert.deepEqual(aliases.find((a) => a.alias === "hazel1"), { alias: "hazel1", provider: "openai", model: "qwen2.5-coder", baseUrl: "http://hazel1:8080/v1" });
    assert.equal("baseUrl" in (aliases.find((a) => a.alias === "plain") ?? {}), false);
});

test("parseAliasesFromEnv: a PLURNK_BASEURL_* override with no matching alias fails hard", () => {
    const env = { PLURNK_MODEL_a: "openai/m", PLURNK_BASEURL_typo: "http://nope" } as NodeJS.ProcessEnv;
    assert.throws(() => parseAliasesFromEnv(env), /PLURNK_BASEURL_\* override\(s\) with no matching PLURNK_MODEL_\* alias: typo/);
});

test("resolveActiveAlias: returns null when PLURNK_MODEL unset", () => {
    const env = { PLURNK_MODEL_gemma: "openai/macher.gguf" } as NodeJS.ProcessEnv;
    assert.equal(resolveActiveAlias(env), null);
});

test("resolveActiveAlias: returns null when PLURNK_MODEL doesn't match any alias", () => {
    const env = {
        PLURNK_MODEL: "missing",
        PLURNK_MODEL_gemma: "openai/macher.gguf",
    } as NodeJS.ProcessEnv;
    assert.equal(resolveActiveAlias(env), null);
});

test("resolveActiveAlias: matches alias case-insensitively", () => {
    const env = {
        PLURNK_MODEL: "GEMMA",
        PLURNK_MODEL_gemma: "openai/macher.gguf",
    } as NodeJS.ProcessEnv;
    const active = resolveActiveAlias(env);
    assert.equal(active?.alias, "gemma");
});

// — two-tier instantiation (SPEC §5) —

const fullEnv = Object.freeze({
    PLURNK_FETCH_TIMEOUT: "600000",
    PLURNK_PROVIDERS_REASONING_BUDGET: "0", PLURNK_PROVIDER_RETRY_ATTEMPTS: "0",
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

test("instantiateProvider: discovered package without a fromEnv factory throws", async () => {
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

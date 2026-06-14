import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { parseAliasesFromEnv, resolveActiveAlias, instantiateProvider, loadActiveProvider } from "./ProviderRegistry.ts";

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
    PLURNK_PROVIDERS_REASON_LEVEL: "0",
    PLURNK_PROVIDERS_THINKING: "0",
    PLURNK_PROVIDERS_REASONING: "1",
    OPENAI_BASE_URL: "http://x",
});

test("instantiateProvider: standard name resolves in-framework, no dynamic import", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
        if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        throw new Error("unexpected fetch");
    });
    const imports: string[] = [];
    const p = await instantiateProvider("openai", { ...fullEnv }, "m", async (s) => { imports.push(s); return {}; });
    assert.equal(p.model, "m");
    assert.deepEqual(imports, []); // tier 1 never touches the importer
    mock.restoreAll();
});

test("instantiateProvider: bespoke name dynamic-imports the daughter and calls fromEnv", async () => {
    const fake = { contextSize: 1, model: "m", countTokens: () => 0, costFor: () => 0, generate: async () => { throw new Error("unused"); } };
    const calls: unknown[] = [];
    const p = await instantiateProvider("openrouter", { ...fullEnv }, "anthropic/claude-opus-latest", async (specifier) => {
        calls.push(specifier);
        return { default: { fromEnv: async (env: NodeJS.ProcessEnv, model: string) => { calls.push(model); return fake; } } };
    });
    assert.equal(p, fake);
    assert.deepEqual(calls, ["@plurnk/plurnk-providers-openrouter", "anthropic/claude-opus-latest"]);
});

test("instantiateProvider: unknown provider throws naming the missing package", async () => {
    await assert.rejects(
        () => instantiateProvider("nope", { ...fullEnv }, "m", async () => { throw new Error("MODULE_NOT_FOUND"); }),
        /unknown provider "nope": not a standard provider and @plurnk\/plurnk-providers-nope is not installed/,
    );
});

test("instantiateProvider: daughter without a fromEnv factory throws", async () => {
    await assert.rejects(
        () => instantiateProvider("broken", { ...fullEnv }, "m", async () => ({ default: {} })),
        /@plurnk\/plurnk-providers-broken default export is not a Provider factory/,
    );
});

test("loadActiveProvider: resolves the alias cascade end-to-end", async () => {
    const fake = { contextSize: 1, model: "x", countTokens: () => 0, costFor: () => 0, generate: async () => { throw new Error("unused"); } };
    const env = { ...fullEnv, PLURNK_MODEL: "opus", PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus-latest" } as NodeJS.ProcessEnv;
    const p = await loadActiveProvider(env, async () => ({ default: { fromEnv: async () => fake } }));
    assert.equal(p, fake);
});

test("loadActiveProvider: throws a named error when no alias is active", async () => {
    await assert.rejects(() => loadActiveProvider({ ...fullEnv }), /set PLURNK_MODEL to an alias/);
});

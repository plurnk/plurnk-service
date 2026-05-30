import test from "node:test";
import { strict as assert } from "node:assert";
import { parseAliasesFromEnv, resolveActiveAlias } from "./ProviderRegistry.ts";

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

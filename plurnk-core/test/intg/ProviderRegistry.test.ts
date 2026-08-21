import test from "node:test";
import assert from "node:assert/strict";
import { parseAliasesFromEnv, resolveActiveRoute } from "@plurnk/plurnk-providers";

test("parseAliasesFromEnv: extracts PLURNK_MODEL_<alias>=<provider>/<model> entries", () => {
    const aliases = parseAliasesFromEnv({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus-latest",
        PLURNK_MODEL: "gemma",
        PLURNK_SERVICE_DB_PATH: "./x.db",
    });
    assert.deepEqual(aliases.toSorted((a, b) => a.alias.localeCompare(b.alias)), [
        { alias: "gemma", provider: "openai", model: "macher.gguf" },
        { alias: "opus", provider: "openrouter", model: "anthropic/claude-opus-latest" },
    ]);
});

test("parseAliasesFromEnv: downcases the alias suffix; preserves provider+model case", () => {
    const aliases = parseAliasesFromEnv({
        PLURNK_MODEL_GEMMA: "openai/Macher.GGUF",
    });
    assert.equal(aliases.length, 1);
    assert.equal(aliases[0].alias, "gemma");
    assert.equal(aliases[0].model, "Macher.GGUF");
});

test("parseAliasesFromEnv: empty value, no slash, or no suffix are skipped", () => {
    const aliases = parseAliasesFromEnv({
        PLURNK_MODEL_empty: "",
        PLURNK_MODEL_noslash: "openai-no-slash",
        PLURNK_MODEL_leadingslash: "/leading",
        PLURNK_MODEL: "valid-alias-not-listed",
        PLURNK_MODEL_valid: "openai/model",
    });
    assert.deepEqual(aliases.map((a) => a.alias), ["valid"]);
});

test("resolveActiveRoute: returns null when PLURNK_MODEL unset", () => {
    const alias = resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
    });
    assert.equal(alias, null);
});

test("resolveActiveRoute: returns the matching alias when PLURNK_MODEL set", () => {
    const alias = resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL_opus: "openrouter/anthropic/claude-opus-latest",
        PLURNK_MODEL: "opus",
    });
    assert.deepEqual(alias, { alias: "opus", provider: "openrouter", model: "anthropic/claude-opus-latest" });
});

test("resolveActiveRoute: case-insensitive PLURNK_MODEL lookup", () => {
    const alias = resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL: "GEMMA",
    });
    assert.equal(alias?.alias, "gemma");
});

test("resolveActiveRoute: rejects an explicit unknown alias", () => {
    assert.throws(() => resolveActiveRoute({
        PLURNK_MODEL_gemma: "openai/macher.gguf",
        PLURNK_MODEL: "ghost",
    }), /neither a declared alias nor a provider\/model route/);
});

test("resolveActiveRoute: exact routes require no alias declaration", () => {
    assert.deepEqual(resolveActiveRoute({ PLURNK_MODEL: "google/gemini-3-flash" }), {
        provider: "google",
        model: "gemini-3-flash",
    });
});

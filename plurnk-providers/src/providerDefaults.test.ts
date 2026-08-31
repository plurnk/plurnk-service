import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lookupProvider } from "@plurnk/plurnk-models";

const defaultsPath = fileURLToPath(new URL("../.env.defaults", import.meta.url));
const declarations = readFileSync(defaultsPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ key: match[1]!, value: match[2]! }));

const providerFact = (key: string): { provider: string; fact: string } | null => {
    const match = /^PLURNK_PROVIDERS_PROVIDER_([A-Z0-9_]+)_(NPM|BASE_URL|API_KEY_ENV)$/.exec(key);
    return match === null ? null : { provider: match[1]!.toLowerCase(), fact: match[2]! };
};

test("{§provider-fact-authority} package defaults never redefine cataloged provider facts", () => {
    // (#459) the env prefix IS the Models.dev id, underscored; probe both spellings.
    for (const { key, value } of declarations) {
        const fact = providerFact(key);
        if (fact === null) continue;
        for (const candidate of new Set([fact.provider, fact.provider.replaceAll("_", "-")])) {
            assert.equal(
                lookupProvider(candidate),
                null,
                `package default '${key}=${value}' redefines a Models.dev-cataloged provider fact (${candidate})`,
            );
        }
    }
});

test("{§provider-fact-authority} package defaults never ship ordered credential fallbacks", () => {
    for (const { key, value } of declarations) {
        if (!key.endsWith("_API_KEY_ENV")) continue;
        assert.ok(
            /^[A-Z0-9_]+$/.test(value),
            `package default '${key}' must hold one exact environment name, got '${value}'`,
        );
    }
});

test("{§openrouter-app-attribution} the shipped floor identifies the public Plurnk application", () => {
    const values = new Map(declarations.map(({ key, value }) => [key, value]));
    assert.equal(values.get("OPENROUTER_HTTP_REFERER"), "https://github.com/plurnk/plurnk-service");
    assert.equal(values.get("OPENROUTER_APP_TITLE"), "Plurnk");
    assert.equal(values.has("OPENROUTER_X_TITLE"), false);
});

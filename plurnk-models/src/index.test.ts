import test from "node:test";
import { strict as assert } from "node:assert";
import {
    catalogSnapshot,
    lookup,
    lookupProvider,
    providerCatalogSnapshot,
    providerCredentialEnvNames,
    providerNameFromCatalogId,
    resolveModel,
} from "./index.ts";

test("lookup: a known cloud model exposes the independent limits and rate groups", () => {
    const info = lookup("openai", "gpt-5.4");
    assert.ok(info !== null, "expected a snapshot entry for a well-known relay model");
    assert.equal(info.name, "GPT-5.4");
    assert.ok(info.contextWindow > 0);
    assert.ok((info.maxInputTokens ?? 0) > 0);
    assert.ok((info.maxOutputTokens ?? 0) > 0);
    assert.equal(info.reasoning, true);
    assert.equal(typeof info.cost?.inputPer1M, "number");
    assert.equal(typeof info.cost?.outputPer1M, "number");
    assert.deepEqual(info.modalities?.output, ["text"]);
    assert.equal(typeof info.toolCall, "boolean");
    assert.equal(typeof info.structuredOutput, "boolean");
});

test("lookup: the diverging provider names map to their models.dev ids", () => {
    // together → togetherai, fireworks → fireworks-ai, cloudflare → cloudflare-workers-ai,
    // and the Chinese hosts that diverge: moonshot → moonshotai, dashscope → alibaba,
    // zhipu → zai, hunyuan → tencent-tokenhub. Each maps onto a real provider with at
    // least one model; an identity lookup would miss.
    const snap = catalogSnapshot();
    const first = (id: string) => Object.keys(snap[id])[0];
    const mapsThrough = (name: string, id: string) => {
        assert.ok(id in snap, `${id} missing from snapshot`);
        assert.equal(lookup(name, first(id))?.contextWindow, snap[id][first(id)].contextWindow, `${name} → ${id}`);
    };
    mapsThrough("together", "togetherai");
    mapsThrough("fireworks", "fireworks-ai");
    mapsThrough("cloudflare", "cloudflare-workers-ai");
    mapsThrough("moonshot", "moonshotai");
    mapsThrough("dashscope", "alibaba");
    mapsThrough("zhipu", "zai");
    mapsThrough("hunyuan", "tencent-tokenhub");
});

test("lookup: an unknown/local model is a miss (null) — the probe owns that case", () => {
    assert.equal(lookup("openai", "macher.gguf"), null);      // local llama-server model — not in any catalog
    assert.equal(lookup("nonprovider", "whatever"), null);     // unknown provider
});

test("resolveModel: a unique provider-native suffix resolves without a PLURNK vendor table", () => {
    const resolved = resolveModel("fireworks", "deepseek-v4-pro-0813");
    assert.equal(resolved?.id, "accounts/fireworks/models/deepseek-v4-pro-0813");
});

test("provider catalog carries Models.dev's AI SDK construction facts", () => {
    assert.deepEqual(lookupProvider("google"), providerCatalogSnapshot().google);
    assert.equal(lookupProvider("google")?.name, "Google");
    assert.equal(lookupProvider("google")?.npm, "@ai-sdk/google");
    assert.ok(lookupProvider("google")?.env.includes("GEMINI_API_KEY"));
    assert.equal(lookupProvider("cloudflare")?.id, "cloudflare-workers-ai");
});

test("providerNameFromCatalogId projects the one canonical PLURNK route segment", () => {
    assert.equal(providerNameFromCatalogId("fireworks-ai"), "fireworks");
    assert.equal(providerNameFromCatalogId("google"), "google");
});

test("provider catalog carries Cerebras and Gemma 4 facts", () => {
    assert.deepEqual(lookupProvider("cerebras"), {
        id: "cerebras",
        name: "Cerebras",
        npm: "@ai-sdk/cerebras",
        env: ["CEREBRAS_API_KEY"],
    });
    const model = lookup("cerebras", "gemma-4-31b");
    assert.ok(model !== null);
    assert.ok(model.contextWindow > 0);
    assert.ok((model.maxOutputTokens ?? 0) > 0);
});

test("lookup: reasoning rates remain distinct from ordinary output rates", () => {
    const snap = catalogSnapshot();
    const model = Object.values(snap)
        .flatMap((models) => Object.values(models))
        .find((candidate) => candidate.cost?.reasoningPer1M !== undefined
            && candidate.cost.reasoningPer1M !== candidate.cost.outputPer1M);
    assert.ok(model !== undefined, "expected Models.dev to contain a distinct reasoning rate");
});

test("provider credential names exclude non-secret endpoint coordinates", () => {
    const names = providerCredentialEnvNames();
    assert.ok(names.includes("OPENAI_API_KEY"));
    assert.ok(names.includes("AWS_SECRET_ACCESS_KEY"));
    assert.equal(names.includes("AWS_REGION"), false);
    assert.equal(names.includes("CLOUDFLARE_ACCOUNT_ID"), false);
});

test("catalogSnapshot: every vendored provider has models with usable context", () => {
    const snap = catalogSnapshot();
    const providers = providerCatalogSnapshot();
    const ids = Object.keys(snap);
    assert.ok(ids.length > 0);
    for (const id of ids) {
        assert.ok(providers[id] !== undefined, `provider facts missing for "${id}"`);
        assert.ok(Object.keys(snap[id]).length > 0, `"${id}" vendored empty`);
    }
});

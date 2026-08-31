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

test("lookup: route-specific reasoning controls survive the Models.dev projection", () => {
    const info = lookup("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b");
    assert.ok(info !== null);
    assert.deepEqual(info.reasoningOptions, [
        { type: "toggle" },
        { type: "effort", values: ["low", "medium", "xhigh"] },
    ]);
});

test("(#459) the segment IS the Models.dev id; retired plurnk-local names refuse, naming the id", () => {
    const snap = catalogSnapshot();
    const first = (id: string) => Object.keys(snap[id])[0];
    for (const id of ["togetherai", "fireworks-ai", "cloudflare-workers-ai", "moonshotai", "alibaba", "zai", "tencent-tokenhub", "amazon-bedrock"]) {
        assert.ok(id in snap, `${id} missing from snapshot`);
        assert.equal(lookup(id, first(id))?.contextWindow, snap[id][first(id)].contextWindow, id);
    }
    for (const [name, id] of [["together", "togetherai"], ["fireworks", "fireworks-ai"], ["cloudflare", "cloudflare-workers-ai"], ["moonshot", "moonshotai"], ["dashscope", "alibaba"], ["zhipu", "zai"], ["hunyuan", "tencent-tokenhub"], ["bedrock", "amazon-bedrock"]]) {
        assert.throws(() => lookup(name, "any"), new RegExp(`'${name}' was retired.*'${id}'`), name);
        assert.throws(() => lookupProvider(name), new RegExp(`'${name}' was retired`), name);
    }
    // `ollama` is the built-in local rail, never retired; the cloud catalog is ollama-cloud.
    assert.equal(lookupProvider("ollama"), null);
    assert.notEqual(lookupProvider("ollama-cloud"), null);
});

test("lookup: an unknown/local model is a miss (null) — the probe owns that case", () => {
    assert.equal(lookup("openai", "macher.gguf"), null);      // local llama-server model — not in any catalog
    assert.equal(lookup("nonprovider", "whatever"), null);     // unknown provider
});

test("resolveModel: a unique provider-native suffix resolves without a PLURNK vendor table", () => {
    const resolved = resolveModel("fireworks-ai", "deepseek-v4-pro-0813");
    assert.equal(resolved?.id, "accounts/fireworks/models/deepseek-v4-pro-0813");
});

test("provider catalog carries Models.dev's AI SDK construction facts", () => {
    assert.deepEqual(lookupProvider("google"), providerCatalogSnapshot().google);
    assert.equal(lookupProvider("google")?.name, "Google");
    assert.equal(lookupProvider("google")?.npm, "@ai-sdk/google");
    assert.ok(lookupProvider("google")?.env.includes("GEMINI_API_KEY"));
    assert.equal(lookupProvider("cloudflare-workers-ai")?.id, "cloudflare-workers-ai");
});

test("providerNameFromCatalogId projects the one canonical PLURNK route segment", () => {
    assert.equal(providerNameFromCatalogId("fireworks-ai"), "fireworks-ai");
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
        for (const model of Object.values(snap[id])) {
            assert.equal(
                model.reasoningOptions !== undefined,
                model.reasoning,
                `${id}/${model.name} reasoning controls must accompany the capability fact`,
            );
        }
    }
});

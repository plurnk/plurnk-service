import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { providers } from "@opencode-ai/models/snapshot";
import { projectCatalog } from "./generate.mjs";

const model = {
    name: "Example",
    limit: { context: 32_000, input: 28_000, output: 4_000 },
    attachment: true,
    reasoning: true,
    reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: [null, "low", "high"] },
        { type: "budget_tokens", min: 128, max: 4096 },
    ],
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    structured_output: false,
    temperature: true,
    cost: { input: 1, output: 2, reasoning: 3, cache_read: 0.1, cache_write: 1.2 },
};

const source = (entry = model) => ({
    example: {
        id: "example", name: "Example Provider", npm: "@ai-sdk/openai-compatible",
        api: "https://example.invalid/v1", env: ["EXAMPLE_API_KEY"],
        models: { example: entry },
    },
});

test("{§model-catalog-projection} catalog projection preserves independent model facts and provider construction data", () => {
    assert.deepEqual(projectCatalog(source()), {
        providers: {
            example: {
                id: "example", name: "Example Provider", npm: "@ai-sdk/openai-compatible",
                api: "https://example.invalid/v1", env: ["EXAMPLE_API_KEY"],
            },
        },
        catalog: {
            example: {
                example: {
                    name: "Example", contextWindow: 32_000, maxInputTokens: 28_000,
                    maxOutputTokens: 4_000, attachment: true, reasoning: true,
                    reasoningOptions: model.reasoning_options,
                    toolCall: true, modalities: model.modalities,
                    structuredOutput: false, temperature: true,
                    cost: { inputPer1M: 1, outputPer1M: 2, reasoningPer1M: 3, cacheReadPer1M: 0.1, cacheWritePer1M: 1.2 },
                },
            },
        },
    });
});

test("{§model-catalog-projection} catalog projection excludes unsupported SDKs and models without usable context", () => {
    const db = source({ ...model, limit: { context: 0 } });
    db.unsupported = { ...db.example, npm: "@example/uninstalled-sdk", models: { example: model } };
    const result = projectCatalog(db);
    assert.deepEqual(result.catalog, {});
    assert.deepEqual(Object.keys(result.providers), ["example"]);
});

test("catalog projection does not invent missing optional limits, controls, or rates", () => {
    const result = projectCatalog(source({
        ...model, reasoning: false, reasoning_options: undefined,
        limit: { context: 1024 }, cost: { input: 1 },
    })).catalog.example.example;
    assert.equal(result.reasoning, false);
    for (const name of ["reasoningOptions", "maxInputTokens", "maxOutputTokens", "cost"]) {
        assert.equal(Object.hasOwn(result, name), false, name);
    }
});

for (const [change, message] of [
    [{ name: "" }, "has no display name"],
    [{ attachment: undefined }, "has no attachment capability fact"],
    [{ tool_call: undefined }, "has no tool_call capability fact"],
    [{ modalities: {} }, "has no modalities fact"],
    [{ reasoning_options: undefined }, "has no reasoning_options capability facts"],
    [{ reasoning_options: [{ type: "effort", values: ["imaginary"] }] }, "has invalid reasoning effort values"],
    [{ reasoning_options: [{ type: "unknown" }] }, "has an unknown reasoning option"],
]) {
    test(`catalog projection rejects invalid upstream facts: ${message}`, () => {
        assert.throws(() => projectCatalog(source({ ...model, ...change })), {
            message: `Models.dev ${message.includes("capability facts") ? "reasoning model" : "model"} example/example ${message}`,
        });
    });
}

test("development JSON is exactly the projection of the locked upstream snapshot", async () => {
    const expected = projectCatalog(providers);
    for (const name of ["catalog", "providers"]) {
        const actual = JSON.parse(await readFile(new URL(`./${name}.json`, import.meta.url), "utf8"));
        assert.deepEqual(actual, expected[name], name);
    }
});

import test from "node:test";
import assert from "node:assert/strict";

const metadata = { inputTokens: null, warnings: [], accounting: [] };
const vector = new Uint8Array(new Float32Array([1, 0]).buffer);

const adapter = (model) => ({
    dimension: 2,
    contextWindow: 8,
    tokenizerModel: model === "configured" ? "fixture/tokenizer" : undefined,
    model,
    countTokens: model === "configured" ? undefined : async (text) => text.length,
    async embedQuery() { return { vector, metadata }; },
    async embedDocuments(texts) { return { vectors: texts.map(() => vector), metadata }; },
    async dispose() {},
});

test("a bundled-local selection never imports the configured-provider family", async (t) => {
    const previous = process.env.PLURNK_EMBEDDING_MODEL;
    delete process.env.PLURNK_EMBEDDING_MODEL;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_EMBEDDING_MODEL;
        else process.env.PLURNK_EMBEDDING_MODEL = previous;
    });
    t.mock.module("./local.js", { exports: adapter("local") });
    t.mock.module("./configured.js", { exports: {} });

    const selected = await import("./index.js?local-selection");

    assert.equal(selected.model, "local");
    assert.equal(await selected.countTokens("local"), 5);
});

test("a configured selection never imports the bundled ONNX/tokenizer family", async (t) => {
    const previous = process.env.PLURNK_EMBEDDING_MODEL;
    process.env.PLURNK_EMBEDDING_MODEL = "fixture/model";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_EMBEDDING_MODEL;
        else process.env.PLURNK_EMBEDDING_MODEL = previous;
    });
    t.mock.module("./local.js", { exports: {} });
    t.mock.module("./configured.js", {
        exports: { resolveConfiguredEmbedder: () => adapter("configured") },
    });

    const selected = await import("./index.js?configured-selection");

    assert.equal(selected.model, "configured");
    assert.equal(selected.countTokens, undefined);
    assert.equal((await selected.embedQuery("query")).vector.byteLength, 8);
});

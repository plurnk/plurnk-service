import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { embedDocumentsWithModel, embedQueryWithModel } from "./standard.js";

const warning = { type: "other", message: "fixture warning" };
const model = {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "fixture-model",
    maxEmbeddingsPerCall: 2,
    supportsParallelCalls: true,
    async doEmbed({ values, abortSignal }) {
        abortSignal?.throwIfAborted();
        return {
            embeddings: values.map((value) => [value.length, 0]),
            usage: { tokens: values.length * 2 },
            warnings: [warning],
            providerMetadata: { fixture: { requestId: values.join("-") } },
            response: {
                headers: { "x-request-id": values.join("-") },
                body: { deliberately: "not retained" },
            },
        };
    },
};

describe("standard EmbeddingModelV4 adapter ({§mimetype-embedding-telemetry})", () => {
    it("preserves usage, warnings, and provider metadata for a query", async () => {
        const result = await embedQueryWithModel({
            model,
            text: "hello",
            transform: (value) => value,
            dimension: 2,
            label: "fixture",
            maxRetries: 0,
        });
        assert.deepEqual(result.metadata, {
            inputTokens: 2,
            warnings: [warning],
            accounting: [],
            providerMetadata: { fixture: { requestId: "hello" } },
            responses: [{ headers: { "x-request-id": "hello" } }],
        });
    });

    it("aggregates partition telemetry and reports bounded progress", async () => {
        const progress = [];
        const result = await embedDocumentsWithModel({
            model,
            texts: ["a", "bb", "ccc"],
            transform: (value) => value,
            dimension: 2,
            label: "fixture",
            maxRetries: 0,
            maxParallelCalls: 1,
            onProgress: (value) => progress.push(value),
        });
        assert.equal(result.metadata.inputTokens, 6);
        assert.deepEqual(result.metadata.warnings, [warning, warning]);
        assert.deepEqual(result.metadata.providerMetadata, { fixture: { requestId: "ccc" } });
        assert.deepEqual(result.metadata.responses, [
            { headers: { "x-request-id": "a-bb" } },
            { headers: { "x-request-id": "ccc" } },
        ]);
        assert.deepEqual(progress, [
            { completed: 2, total: 3 },
            { completed: 3, total: 3 },
        ]);
    });

    it("preserves the standard UTF-8 request-byte capability while wrapping progress", async () => {
        const requests = [];
        const byteLimited = {
            ...model,
            maxEmbeddingsPerCall: Infinity,
            [Symbol.for("vercel.ai.embeddingModel.maxInputBytesPerCall")]: 3,
            async doEmbed({ values }) {
                requests.push(values);
                return { embeddings: values.map((value) => [value.length, 0]), warnings: [] };
            },
        };
        const result = await embedDocumentsWithModel({
            model: byteLimited,
            texts: ["aa", "bb", "c"],
            transform: (value) => value,
            dimension: 2,
            label: "byte-limited fixture",
            maxRetries: 0,
            maxParallelCalls: 1,
            onProgress() {},
        });
        assert.deepEqual(requests, [["aa"], ["bb", "c"]]);
        assert.equal(result.vectors.length, 3);
    });

    it("caps the adapter's standard input cardinality with the exact route profile", async () => {
        const requests = [];
        const broadlyCompatible = {
            ...model,
            maxEmbeddingsPerCall: 2048,
            async doEmbed({ values }) {
                requests.push(values);
                return { embeddings: values.map((value) => [value.length, 0]), warnings: [] };
            },
        };
        const result = await embedDocumentsWithModel({
            model: broadlyCompatible,
            texts: ["a", "bb", "ccc"],
            transform: (value) => value,
            dimension: 2,
            label: "profile-limited fixture",
            maxEmbeddingsPerCall: 1,
            maxRetries: 0,
            maxParallelCalls: 2,
        });
        assert.deepEqual(requests, [["a"], ["bb"], ["ccc"]]);
        assert.equal(result.vectors.length, 3);
    });

    it("settles factual fallback evidence before surfacing an accounting normalizer defect", async () => {
        const root = new Error("fixture cost wire changed");
        const settled = [];
        await assert.rejects(
            embedQueryWithModel({
                model,
                identity: { provider: "provider:fixture", model: "fixture-model" },
                text: "hello",
                transform: (value) => value,
                dimension: 2,
                label: "fixture",
                maxRetries: 0,
                normalizeAccounting: () => { throw root; },
                observeRequest: async () => async (accounting) => { settled.push(accounting); },
            }),
            (error) => error.name === "EmbeddingInferenceError"
                && error.cause?.name === "EmbeddingRequestAccountingError"
                && error.cause?.cause === root,
        );
        assert.deepEqual(settled, [{
            provider: "provider:fixture",
            model: "fixture-model",
            outcome: "response",
            cost: {
                kind: "unknown",
                reason: "provider request accounting could not be normalized after physical I/O",
            },
        }]);
    });
});

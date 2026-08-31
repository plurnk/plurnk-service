// (#463) — a physical embedding request that never resolves fails at the wire
// deadline instead of freezing every awaiter of the batch.
import test from "node:test";
import assert from "node:assert/strict";
import { embedDocumentsWithModel } from "./standard.js";

test("#463: a never-resolving doEmbed rejects at requestTimeoutMs, never hangs", async () => {
    const model = {
        specificationVersion: "v4",
        provider: "fixture",
        modelId: "hung",
        maxEmbeddingsPerCall: 8,
        supportsParallelCalls: true,
        doEmbed: () => new Promise(() => {}),
    };
    const started = Date.now();
    await assert.rejects(
        embedDocumentsWithModel({
            model,
            identity: { provider: "fixture", model: "hung" },
            texts: ["a", "b"],
            transform: (text) => text,
            dimension: 3,
            label: "fixture embedding",
            maxRetries: 0,
            requestTimeoutMs: 80,
        }),
        (error) => error instanceof Error,
        "the batch rejects instead of hanging",
    );
    assert.ok(Date.now() - started < 5_000, "rejection came from the deadline, not a suite timeout");
});

test("#463: without a configured deadline the caller's signal still aborts", async () => {
    const model = {
        specificationVersion: "v4",
        provider: "fixture",
        modelId: "hung",
        maxEmbeddingsPerCall: 8,
        supportsParallelCalls: true,
        doEmbed: ({ abortSignal }) => new Promise((_, reject) => {
            abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
        }),
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("caller cancelled")), 50);
    await assert.rejects(embedDocumentsWithModel({
        model,
        identity: { provider: "fixture", model: "hung" },
        texts: ["a"],
        transform: (text) => text,
        dimension: 3,
        label: "fixture embedding",
        maxRetries: 0,
        signal: controller.signal,
    }));
});

// Contract: {§mimetype-embedding}.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import EmbeddingVector from "../EmbeddingVector.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";

const INFO: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    projectionRevision: "test-1",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

function makeDiscovery(): Discovery {
    const registry: Registry = {
        byExtension: new Map([[".txt", "text/plain"]]),
        byFilename: new Map(),
    };
    return { registry, handlers: new Map([["text/plain", INFO]]), skipped: [] };
}

// Full surface: declares the chunking facts. countTokens just returns the
// char length so the test can prove delegation reaches THIS function.
let countSignal: AbortSignal | undefined;
const fullEmbedder = {
    dimension: 4,
    model: "fake@1",
    contextWindow: 512,
    async embed(): Promise<Uint8Array> {
        return EmbeddingVector.encode([0, 0, 0, 0]);
    },
    async embedBatch(texts: readonly string[]): Promise<Uint8Array[]> {
        return texts.map(() => EmbeddingVector.encode([0, 0, 0, 0]));
    },
    async countTokens(text: string, options?: { signal?: AbortSignal }): Promise<number> {
        countSignal = options?.signal;
        return text.length;
    },
};

// Minimal valid surface: scalar/batch embedding + dimension, no optional
// chunk-planning facts.
const minimalEmbedder = {
    dimension: 4,
    async embed(): Promise<Uint8Array> {
        return EmbeddingVector.encode([0, 0, 0, 0]);
    },
    async embedBatch(texts: readonly string[]): Promise<Uint8Array[]> {
        return texts.map(() => EmbeddingVector.encode([0, 0, 0, 0]));
    },
};

function mk(embedder: unknown | null) {
    return new Mimetypes({
        discovery: makeDiscovery(),
        loader: async (pkg) => {
            if (pkg === EMB_PKG) {
                if (embedder === null) {
                    throw Object.assign(
                        new Error(`Cannot find package '${EMB_PKG}' imported from test`),
                        { code: "ERR_MODULE_NOT_FOUND" },
                    );
                }
                return embedder;
            }
            return { default: BaseHandler };
        },
    });
}

describe("embedderInfo()", () => {
    it("E1: null when no embedder is installed", async () => {
        assert.equal(await mk(null).embedderInfo(), null);
    });

    it("E2: a present embedder reports unknown optional facts as null", async () => {
        const info = await mk(minimalEmbedder).embedderInfo();
        assert.ok(info, "present embedder must never report as absent");
        assert.equal(info.dimension, 4);
        assert.equal(info.contextWindow, null, "unknown window is explicitly null");
        assert.equal(info.countTokens, null, "no counter is explicitly null");
    });

    it("E3: surfaces dimension + contextWindow + a delegating countTokens", async () => {
        countSignal = undefined;
        const controller = new AbortController();
        const info = await mk(fullEmbedder).embedderInfo();
        assert.ok(info, "expected non-null info");
        assert.equal(info.dimension, 4);
        assert.equal(info.contextWindow, 512);
        assert.ok(info.countTokens, "full surface has a counter");
        assert.equal(await info.countTokens("hello", { signal: controller.signal }), 5, "delegates to the embedder's counter");
        assert.equal(countSignal, controller.signal, "preserves planning cancellation at the artifact boundary");
    });

    it("E4: surfaces the model id when the embedder declares it ({§mimetype-embedding})", async () => {
        const info = await mk(fullEmbedder).embedderInfo();
        assert.equal(info?.model, "fake@1", "model rides for deep_hash re-derivation");
    });

    it("E5: omits model when the embedder doesn't export one", async () => {
        // A full chunking surface (contextWindow + countTokens) but no model id.
        const { model: _drop, ...noModel } = fullEmbedder;
        const info = await mk(noModel).embedderInfo();
        assert.ok(info, "still non-null — model is independent of the chunking facts");
        assert.equal("model" in info, false, "absent, not undefined");
    });
});

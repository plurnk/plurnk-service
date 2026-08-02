// Contract: {§mimetype-embedding}. embeddings#1 is provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";

const INFO: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
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
const fullEmbedder = {
    dimension: 4,
    model: "fake@1",
    contextWindow: 512,
    async embed(): Promise<Uint8Array> {
        return new Uint8Array(new Float32Array(4).buffer);
    },
    async countTokens(text: string): Promise<number> {
        return text.length;
    },
};

// Minimal valid surface: embed + dimension only, no chunk-planning facts.
const minimalEmbedder = {
    dimension: 4,
    async embed(): Promise<Uint8Array> {
        return new Uint8Array(new Float32Array(4).buffer);
    },
};

function mk(embedder: unknown | null) {
    return new Mimetypes({
        discovery: makeDiscovery(),
        loader: async (pkg) => {
            if (pkg === EMB_PKG) {
                if (embedder === null) throw Object.assign(new Error("MODULE_NOT_FOUND"), { code: "ERR_MODULE_NOT_FOUND" });
                return embedder;
            }
            return { default: BaseHandler };
        },
    });
}

describe("embeddings#1 — embedderInfo()", () => {
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
        const info = await mk(fullEmbedder).embedderInfo();
        assert.ok(info, "expected non-null info");
        assert.equal(info.dimension, 4);
        assert.equal(info.contextWindow, 512);
        assert.ok(info.countTokens, "full surface has a counter");
        assert.equal(await info.countTokens("hello"), 5, "delegates to the embedder's counter");
    });

    it("E4: surfaces the model id when the embedder declares it (#31)", async () => {
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

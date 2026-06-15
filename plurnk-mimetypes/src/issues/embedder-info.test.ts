// embeddings#1: mimetypes.embedderInfo() surfaces the embedder's pure model
// facts (token window + the model's own counter) for plurnk-service's lossless
// chunker. The activation key — null keeps the host on whole-entry behavior;
// non-null lets it tile.
//
//   E1. null when no embedder package is installed.
//   E2. null when the installed embedder predates the surface (no
//       maxTokens/countTokens) — back-compat, host stays on whole-entry.
//   E3. {maxTokens, countTokens} when the embedder exposes them; countTokens
//       delegates to the embedder's own tokenizer.

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
    return { registry, handlers: new Map([["text/plain", INFO]]) };
}

// Full surface: declares the chunking facts. countTokens just returns the
// char length so the test can prove delegation reaches THIS function.
const fullEmbedder = {
    dimension: 4,
    model: "fake@1",
    maxTokens: 512,
    async embed(): Promise<Uint8Array> {
        return new Uint8Array(new Float32Array(4).buffer);
    },
    async countTokens(text: string): Promise<number> {
        return text.length;
    },
};

// Legacy surface: embed + dimension only, no maxTokens/countTokens.
const legacyEmbedder = {
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
                if (embedder === null) throw new Error("MODULE_NOT_FOUND");
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

    it("E2: null when the embedder predates the chunking surface", async () => {
        assert.equal(await mk(legacyEmbedder).embedderInfo(), null);
    });

    it("E3: surfaces maxTokens + a delegating countTokens", async () => {
        const info = await mk(fullEmbedder).embedderInfo();
        assert.ok(info, "expected non-null info");
        assert.equal(info.maxTokens, 512);
        assert.equal(await info.countTokens("hello"), 5, "delegates to the embedder's counter");
    });
});

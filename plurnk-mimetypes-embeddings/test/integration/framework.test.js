// Integration proof against the REAL framework loader path: constructs
// Mimetypes from the sibling plurnk-mimetypes checkout (path import of its
// TS source — node type-stripping) with a loader that resolves the
// embeddings package name to this package's index. Proves the duck surface
// matches what Mimetypes.#getEmbedder() checks, end to end through
// process({channels:["embedding"]}).
//
// Requires the sibling checkout at ../../../plurnk-mimetypes — this is a
// repo-local integration gate, not something the published package runs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseHandler, Mimetypes } from "../../../plurnk-mimetypes/src/index.ts";
import * as embedderModule from "../../index.js";

class PlainHandler extends BaseHandler {}

const plainInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

const discovery = {
    registry: {
        byExtension: new Map([[".txt", "text/plain"]]),
        byFilename: new Map(),
    },
    handlers: new Map([["text/plain", plainInfo]]),
};

const loader = async (packageName) => {
    if (packageName === "@plurnk/plurnk-mimetypes-embeddings") return embedderModule;
    if (packageName === "@plurnk/plurnk-mimetypes-text-plain") return { default: PlainHandler };
    throw new Error(`unexpected package load: ${packageName}`);
};

describe("framework embedding channel via real loader path", () => {
    it("process({content, hint}, {channels:['embedding']}) returns 1536 bytes", async () => {
        const m = new Mimetypes({ discovery, loader });
        const result = await m.process(
            { content: "hello", hint: "text/plain" },
            { channels: ["embedding"] },
        );
        assert.equal(result.ok, true);
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.embeddingMissing, undefined);
        assert.ok(result.embedding instanceof Uint8Array);
        assert.equal(result.embedding.length, 4 * embedderModule.dimension);
        assert.equal(result.embedding.length, 1536);
        // Other channels stay absent — embedding was the only request.
        assert.equal(result.symbols, undefined);
        assert.equal(result.deepJson, undefined);
    });

    it("framework bytes match a direct embed() of the same text", async () => {
        const m = new Mimetypes({ discovery, loader });
        const { embedding } = await m.process(
            { content: "hello", hint: "text/plain" },
            { channels: ["embedding"] },
        );
        assert.deepEqual(embedding, await embedderModule.embed("hello"));
    });
});

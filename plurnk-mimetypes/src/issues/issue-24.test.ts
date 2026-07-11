// Coverage: SPEC §17 (embedding channel).
// Issue #24: embedding channel — Float32-bytes Uint8Array, scalar per entry
// (plurnk-service ~semantic).
// https://github.com/plurnk/plurnk-mimetypes/issues/24
//
// Load-bearing claims, restated as testable contracts:
//
//   C1. "embedding" is NEVER materialized unless explicitly requested — the
//       default channel set excludes it (model inference is not a default).
//   C2. Requested with the embedder package present: ProcessResult.embedding
//       is a Uint8Array of native-endian Float32 bytes (4 × dimension). The
//       same channel embeds arbitrary text — an entry body and a ~query's
//       query text ride the identical path.
//   C3. Requested with the package missing: degrade per #14 — empty bytes +
//       embeddingMissing install hint, ok stays true; strict: true throws.
//   C4. Honest empties: empty content and binary content without a toText
//       projection embed to empty bytes with NO missing-hint.
//   C5. The grammar-degrade path still embeds — a grammar-missing entry is
//       still semantically searchable text.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Registry } from "../types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";

// Deterministic fake embedder: dimension 4, vector = [len, first char code,
// 0.5, -1] — enough to assert byte plumbing without a model.
const fakeEmbedderModule = {
    dimension: 4,
    model: "fake-model@abc123",
    async embed(text: string): Promise<Uint8Array> {
        const v = new Float32Array([text.length, text.charCodeAt(0) || 0, 0.5, -1]);
        return new Uint8Array(v.buffer);
    },
};

class PlainHandler extends BaseHandler {}

class MissingGrammarHandler extends BaseHandler {
    override extractRaw(): MimeSymbol[] {
        const err = new Error("grammar missing");
        err.name = "GrammarNotInstalledError";
        (err as Error & { plurnkPackage?: string }).plurnkPackage = "@plurnk/plurnk-mimetypes-grammar-fake";
        throw err;
    }
}

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) {
            if (ext.startsWith(".")) byExtension.set(ext.toLowerCase(), info.mimetype);
        }
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap };
}

const INFO: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

function makeMimetypes(opts: { withEmbedder: boolean; handler?: new (...a: never[]) => BaseHandler }) {
    return new Mimetypes({
        discovery: makeDiscovery([INFO]),
        loader: async (pkg) => {
            if (pkg === EMB_PKG) {
                if (!opts.withEmbedder) throw Object.assign(new Error("MODULE_NOT_FOUND"), { code: "ERR_MODULE_NOT_FOUND" });
                return fakeEmbedderModule;
            }
            return { default: opts.handler ?? PlainHandler };
        },
    });
}

describe("a present-but-broken embedder crashes, never silently degrades to absent", () => {
    it("a non-MODULE_NOT_FOUND load error (e.g. a required env knob unset) propagates", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([INFO]),
            loader: async (pkg) => {
                // Installed but throws on import — a misconfiguration the loader
                // catch must NOT swallow as "no embedder" (that would hide it as
                // a silent FTS-only downgrade). Distinct from ERR_MODULE_NOT_FOUND.
                if (pkg === EMB_PKG) throw new RangeError("PLURNK_EMBED_WORKERS is required");
                return { default: PlainHandler };
            },
        });
        await assert.rejects(
            () => m.process({ path: "a.txt", content: "hi" }, { channels: ["embedding"] }),
            /PLURNK_EMBED_WORKERS is required/,
        );
    });
});

describe("Issue #24 — C1: embedding is opt-in only", () => {
    it("the default channel set never materializes embedding", async () => {
        let embedderRequested = false;
        const m = new Mimetypes({
            discovery: makeDiscovery([INFO]),
            loader: async (pkg) => {
                if (pkg === EMB_PKG) { embedderRequested = true; return fakeEmbedderModule; }
                return { default: PlainHandler };
            },
        });
        const r = await m.process({ path: "a.txt", content: "hello" });
        assert.equal("embedding" in r, false);
        assert.equal(embedderRequested, false, "embedder must not even be resolved");
    });
});

describe("Issue #24 — C2: Float32 bytes, scalar per entry, arbitrary text", () => {
    it("returns 4×dimension bytes readable as a Float32Array view", async () => {
        const m = makeMimetypes({ withEmbedder: true });
        const r = await m.process(
            { path: "a.txt", content: "hello" },
            { channels: ["embedding"] },
        );
        assert.ok(r.embedding instanceof Uint8Array);
        assert.equal(r.embedding.length, 4 * fakeEmbedderModule.dimension);
        const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 4);
        assert.equal(v[0], 5, "embeds the entry text ('hello'.length)");
        assert.equal(v[3], -1);
    });

    it("a ~query's query text rides the identical path", async () => {
        const m = makeMimetypes({ withEmbedder: true });
        const r = await m.process(
            { content: "find the auth retry logic", hint: "text/plain" },
            { channels: ["embedding"] },
        );
        const v = new Float32Array(r.embedding!.buffer, r.embedding!.byteOffset, 4);
        assert.equal(v[0], "find the auth retry logic".length);
    });

    it("embedding composes with structural channels in one call", async () => {
        const m = makeMimetypes({ withEmbedder: true });
        const r = await m.process(
            { path: "a.txt", content: "x" },
            { channels: ["symbols", "embedding"] },
        );
        assert.deepEqual(r.symbols, []);
        assert.equal(r.embedding!.length, 16);
        assert.equal("deepJson" in r, false);
    });
});

describe("Issue #24 — C3: missing embedder package degrades per #14", () => {
    it("empty bytes + embeddingMissing hint, ok stays true", async () => {
        const m = makeMimetypes({ withEmbedder: false });
        const r = await m.process(
            { path: "a.txt", content: "hello" },
            { channels: ["embedding"] },
        );
        assert.equal(r.ok, true);
        assert.equal(r.embedding!.length, 0);
        assert.equal(r.embeddingMissing, EMB_PKG);
    });

    it("strict: true throws with the install hint", async () => {
        const m = makeMimetypes({ withEmbedder: false });
        await assert.rejects(
            () => m.process({ path: "a.txt", content: "x" }, { channels: ["embedding"], strict: true }),
            (err: unknown) => (err as Error).message.includes(EMB_PKG),
        );
    });
});

describe("Issue #24 — C4: honest empties carry no hint", () => {
    it("empty content embeds to empty bytes without embeddingMissing", async () => {
        const m = makeMimetypes({ withEmbedder: true });
        const r = await m.process({ path: "a.txt", content: "" }, { channels: ["embedding"] });
        assert.equal(r.embedding!.length, 0);
        assert.equal("embeddingMissing" in r, false);
    });
});

describe("Issue #24 — C6: model identity rides with the vector", () => {
    it("embeddingModel surfaces when the embedder declares it", async () => {
        const m = makeMimetypes({ withEmbedder: true });
        const r = await m.process({ path: "a.txt", content: "x" }, { channels: ["embedding"] });
        assert.equal(r.embeddingModel, "fake-model@abc123");
    });

    it("absent on empty embeds and when the channel is unrequested", async () => {
        const m = makeMimetypes({ withEmbedder: true });
        const empty = await m.process({ path: "a.txt", content: "" }, { channels: ["embedding"] });
        assert.equal("embeddingModel" in empty, false);
        const unrequested = await m.process({ path: "a.txt", content: "x" });
        assert.equal("embeddingModel" in unrequested, false);
    });
});

describe("Issue #24 — C5: grammar-degrade still embeds", () => {
    it("grammarMissing and a real embedding coexist", async () => {
        const m = makeMimetypes({ withEmbedder: true, handler: MissingGrammarHandler });
        const r = await m.process(
            { path: "a.txt", content: "still searchable text" },
            { channels: ["symbols", "embedding"] },
        );
        assert.equal(r.ok, true);
        assert.equal(r.grammarMissing, "@plurnk/plurnk-mimetypes-grammar-fake");
        assert.deepEqual(r.symbols, []);
        const v = new Float32Array(r.embedding!.buffer, r.embedding!.byteOffset, 4);
        assert.equal(v[0], "still searchable text".length);
    });
});

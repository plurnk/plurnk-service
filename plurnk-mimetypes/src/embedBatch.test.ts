// Contract: {§mimetype-embedding}. plurnk-service#272 is provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "./Mimetypes.ts";
import BaseHandler from "./BaseHandler.ts";
import EmbeddingVector from "./EmbeddingVector.ts";
import type { Discovery, HandlerInfo, Registry } from "./types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";
const TEXT_INFO: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    projectionRevision: "test-1",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

function testDiscovery(): Discovery {
    const registry: Registry = { byExtension: new Map(), byFilename: new Map() };
    return {
        registry,
        handlers: new Map([[TEXT_INFO.mimetype, TEXT_INFO]]),
        skipped: [],
    };
}

// Deterministic embedder: vector = [text length], 4 bytes. embedBatch returns
// the SAME bytes as embed() per text, in input order — the bit-identity the
// issue depends on (no re-embed of stored vectors).
function bytesFor(text: string): Uint8Array {
    return EmbeddingVector.encode([text.length]);
}

function makeMimetypes(embedder: unknown | null): Mimetypes {
    return new Mimetypes({
        discovery: testDiscovery(),
        loader: async (pkg: string) => {
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

describe("Mimetypes.embedBatch (plurnk-service#272)", () => {
    it("delegates to the embedder's embedBatch and returns input-order vectors", async () => {
        const seen: string[][] = [];
        const m = makeMimetypes({
            dimension: 1,
            embed: async (t: string) => bytesFor(t),
            embedBatch: async (texts: readonly string[]) => {
                seen.push([...texts]);
                return texts.map(bytesFor);
            },
        });
        const out = await m.embedBatch(["a", "bb", "ccc"]);
        assert.deepEqual(seen, [["a", "bb", "ccc"]], "delegated once with input order");
        assert.deepEqual(out.map((v) => EmbeddingVector.decode(v)[0]), [1, 2, 3]);
    });

    it("passes onProgress and signal through to the embedder", async () => {
        const controller = new AbortController();
        let gotSignal: AbortSignal | undefined;
        let gotOnProgress = false;
        const m = makeMimetypes({
            dimension: 1,
            embed: async (t: string) => bytesFor(t),
            embedBatch: async (texts: readonly string[], opts?: { onProgress?: (p: unknown) => void; signal?: AbortSignal }) => {
                gotSignal = opts?.signal;
                gotOnProgress = typeof opts?.onProgress === "function";
                opts?.onProgress?.({ completed: texts.length, total: texts.length });
                return texts.map(bytesFor);
            },
        });
        await m.embedBatch(["x"], { onProgress: () => {}, signal: controller.signal });
        assert.equal(gotSignal, controller.signal);
        assert.equal(gotOnProgress, true);
    });

    it("fails hard when an installed artifact lacks the required embedBatch surface (#85)", async () => {
        const m = makeMimetypes({
            dimension: 1,
            embed: async (t: string) => bytesFor(t),
            // no embedBatch
        });
        await assert.rejects(
            () => m.embedderInfo(),
            /does not implement embedBatch\(\)/,
        );
    });

    it("throws (not silent empties) when the embeddings package is absent", async () => {
        const m = makeMimetypes(null);
        await assert.rejects(() => m.embedBatch(["a"]), /not installed/);
    });

    it("rejects an invalid declared dimension before accepting artifact output (#94)", async () => {
        const m = makeMimetypes({
            dimension: 1.5,
            embed: async (text: string) => bytesFor(text),
            embedBatch: async (texts: readonly string[]) => texts.map(bytesFor),
        });

        await assert.rejects(() => m.embedderInfo(), /positive safe-integer dimension/);
    });

    it("rejects malformed singleton and bulk vectors at the artifact boundary (#94)", async () => {
        const singleton = makeMimetypes({
            dimension: 2,
            embed: async () => bytesFor("x"),
            embedBatch: async (texts: readonly string[]) => texts.map(bytesFor),
        });
        await assert.rejects(
            () => singleton.process({ content: "x", hint: "text/plain" }, { channels: ["embedding"] }),
            /embed\(\).*dimension 2.*4 bytes/i,
        );

        const cardinality = makeMimetypes({
            dimension: 1,
            embed: async (text: string) => bytesFor(text),
            embedBatch: async () => [],
        });
        await assert.rejects(
            () => cardinality.embedBatch(["a", "b"]),
            /embedBatch\(\).*2 inputs.*0 vectors/i,
        );

        const malformedIndex = makeMimetypes({
            dimension: 2,
            embed: async () => new Uint8Array(8),
            embedBatch: async () => [new Uint8Array(8), bytesFor("bad")],
        });
        await assert.rejects(
            () => malformedIndex.embedBatch(["a", "b"]),
            /embedBatch\(\).*vector 1.*dimension 2.*4 bytes/i,
        );
    });

    it("preserves an artifact failure instead of replacing its cause (#94)", async () => {
        const artifactFailure = new Error("embedding artifact failed");
        const m = makeMimetypes({
            dimension: 1,
            embed: async (text: string) => bytesFor(text),
            embedBatch: async () => { throw artifactFailure; },
        });

        await assert.rejects(
            () => m.embedBatch(["a"]),
            (error) => error === artifactFailure,
        );
    });
});

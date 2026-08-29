// Contract: {§mimetype-embedding}.

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

// Deterministic embedder: vector = [text length], 4 bytes. Documents return
// the SAME bytes as the symmetric query path, in input order — the bit-identity the
// owning contract requires ({§mimetype-embedding}); stored vectors are not re-embedded.
function bytesFor(text: string): Uint8Array {
    return EmbeddingVector.encode([text.length]);
}

const metadata = { inputTokens: null, warnings: [], accounting: [] } as const;

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
                return { model: "fixture@1", ...(embedder as object) };
            }
            return { default: BaseHandler };
        },
    });
}

describe("Mimetypes.embedDocuments", () => {
    it("delegates once and returns input-order vectors plus metadata", async () => {
        const seen: string[][] = [];
        const m = makeMimetypes({
            dimension: 1,
            embedQuery: async (t: string) => ({ vector: bytesFor(t), metadata }),
            embedDocuments: async (texts: readonly string[]) => {
                seen.push([...texts]);
                return { vectors: texts.map(bytesFor), metadata };
            },
        });
        const out = await m.embedDocuments(["a", "bb", "ccc"]);
        assert.deepEqual(seen, [["a", "bb", "ccc"]], "delegated once with input order");
        assert.deepEqual(out.vectors.map((v) => EmbeddingVector.decode(v)[0]), [1, 2, 3]);
        assert.deepEqual(out.metadata, metadata);
    });

    it("passes onProgress and signal through to the embedder", async () => {
        const controller = new AbortController();
        let gotSignal: AbortSignal | undefined;
        let gotOnProgress = false;
        const m = makeMimetypes({
            dimension: 1,
            embedQuery: async (t: string) => ({ vector: bytesFor(t), metadata }),
            embedDocuments: async (texts: readonly string[], opts?: { onProgress?: (p: unknown) => void; signal?: AbortSignal }) => {
                gotSignal = opts?.signal;
                gotOnProgress = typeof opts?.onProgress === "function";
                opts?.onProgress?.({ completed: texts.length, total: texts.length });
                return { vectors: texts.map(bytesFor), metadata };
            },
        });
        await m.embedDocuments(["x"], { onProgress: () => {}, signal: controller.signal });
        assert.equal(gotSignal, controller.signal);
        assert.equal(gotOnProgress, true);
    });

    it("fails hard when an installed artifact lacks the required document surface (#85)", async () => {
        const m = makeMimetypes({
            dimension: 1,
            embedQuery: async (t: string) => ({ vector: bytesFor(t), metadata }),
            // no embedDocuments
        });
        await assert.rejects(
            () => m.embedderInfo(),
            /does not implement embedDocuments\(\)/,
        );
    });

    it("throws (not silent empties) when the embeddings package is absent", async () => {
        const m = makeMimetypes(null);
        await assert.rejects(() => m.embedDocuments(["a"]), /not installed/);
    });

    it("rejects an invalid declared dimension before accepting artifact output (#94)", async () => {
        const m = makeMimetypes({
            dimension: 1.5,
            embedQuery: async (text: string) => ({ vector: bytesFor(text), metadata }),
            embedDocuments: async (texts: readonly string[]) => ({ vectors: texts.map(bytesFor), metadata }),
        });

        await assert.rejects(() => m.embedderInfo(), /positive safe-integer dimension/);
    });

    it("rejects malformed singleton and bulk vectors at the artifact boundary (#94)", async () => {
        const singleton = makeMimetypes({
            dimension: 2,
            embedQuery: async () => ({ vector: bytesFor("x"), metadata }),
            embedDocuments: async (texts: readonly string[]) => ({ vectors: texts.map(bytesFor), metadata }),
        });
        await assert.rejects(
            () => singleton.process({ content: "x", hint: "text/plain" }, { channels: ["embedding"] }),
            /embedQuery\(\).*dimension 2.*4 bytes/i,
        );

        const cardinality = makeMimetypes({
            dimension: 1,
            embedQuery: async (text: string) => ({ vector: bytesFor(text), metadata }),
            embedDocuments: async () => ({ vectors: [], metadata }),
        });
        await assert.rejects(
            () => cardinality.embedDocuments(["a", "b"]),
            /embedDocuments\(\).*2 inputs.*0 vectors/i,
        );

        const malformedIndex = makeMimetypes({
            dimension: 2,
            embedQuery: async () => ({ vector: new Uint8Array(8), metadata }),
            embedDocuments: async () => ({ vectors: [new Uint8Array(8), bytesFor("bad")], metadata }),
        });
        await assert.rejects(
            () => malformedIndex.embedDocuments(["a", "b"]),
            /embedDocuments\(\).*vector 1.*dimension 2.*4 bytes/i,
        );
    });

    it("preserves an artifact failure instead of replacing its cause (#94)", async () => {
        const artifactFailure = new Error("embedding artifact failed");
        const m = makeMimetypes({
            dimension: 1,
            embedQuery: async (text: string) => ({ vector: bytesFor(text), metadata }),
            embedDocuments: async () => { throw artifactFailure; },
        });

        await assert.rejects(
            () => m.embedDocuments(["a"]),
            (error) => error === artifactFailure,
        );
    });

    it("rejects malformed provider and response metadata at the artifact boundary", async () => {
        const invalidProvider = makeMimetypes({
            dimension: 1,
            embedQuery: async (text: string) => ({ vector: bytesFor(text), metadata }),
            embedDocuments: async (texts: readonly string[]) => ({
                vectors: texts.map(bytesFor),
                metadata: { inputTokens: 1, warnings: [], accounting: [], providerMetadata: null },
            }),
        });
        await assert.rejects(
            () => invalidProvider.embedDocuments(["a"]),
            /metadata\.providerMetadata must be an object/u,
        );

        const invalidHeaders = makeMimetypes({
            dimension: 1,
            embedQuery: async () => ({
                vector: bytesFor("a"),
                metadata: { inputTokens: 1, warnings: [], accounting: [], responses: [{ headers: { broken: 7 } }] },
            }),
            embedDocuments: async (texts: readonly string[]) => ({ vectors: texts.map(bytesFor), metadata }),
        });
        await assert.rejects(
            () => invalidHeaders.process({ content: "a", hint: "text/plain" }, { channels: ["embedding"] }),
            /metadata\.responses must be an array of response metadata/u,
        );
    });
});

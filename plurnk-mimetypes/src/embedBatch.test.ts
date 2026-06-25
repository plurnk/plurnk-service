// Mimetypes.embedBatch — framework bulk-embedding entry for the host's corpus
// ingest (plurnk-service#272). Single embedder seam: resolution stays
// framework-owned; delegates to the embedder's data-parallel embedBatch when
// present, falls back to a sequential embed() loop otherwise.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "./Mimetypes.ts";
import type { Discovery, Registry } from "./types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";

function emptyDiscovery(): Discovery {
    const registry: Registry = { byExtension: new Map(), byFilename: new Map() };
    return { registry, handlers: new Map() };
}

// Deterministic embedder: vector = [text length], 4 bytes. embedBatch returns
// the SAME bytes as embed() per text, in input order — the bit-identity the
// issue depends on (no re-embed of stored vectors).
function bytesFor(text: string): Uint8Array {
    return new Uint8Array(new Float32Array([text.length]).buffer);
}

function makeMimetypes(embedder: unknown | null): Mimetypes {
    return new Mimetypes({
        discovery: emptyDiscovery(),
        loader: async (pkg: string) => {
            if (pkg === EMB_PKG) {
                if (embedder === null) throw new Error("MODULE_NOT_FOUND");
                return embedder;
            }
            return { default: class {} };
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
        assert.deepEqual(out.map((v) => new Float32Array(v.buffer)[0]), [1, 2, 3]);
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

    it("falls back to a sequential embed() loop for embedders without embedBatch, firing onProgress", async () => {
        const progress: Array<{ completed: number; total: number }> = [];
        const m = makeMimetypes({
            dimension: 1,
            embed: async (t: string) => bytesFor(t),
            // no embedBatch
        });
        const out = await m.embedBatch(["a", "bb"], { onProgress: (p) => progress.push(p) });
        assert.deepEqual(out.map((v) => new Float32Array(v.buffer)[0]), [1, 2]);
        assert.deepEqual(progress, [
            { completed: 1, total: 2 },
            { completed: 2, total: 2 },
        ]);
    });

    it("fallback honors an aborted signal", async () => {
        const controller = new AbortController();
        controller.abort();
        const m = makeMimetypes({
            dimension: 1,
            embed: async (t: string) => bytesFor(t),
        });
        await assert.rejects(() => m.embedBatch(["a", "b"], { signal: controller.signal }));
    });

    it("throws (not silent empties) when the embeddings package is absent", async () => {
        const m = makeMimetypes(null);
        await assert.rejects(() => m.embedBatch(["a"]), /not installed/);
    });
});

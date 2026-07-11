// Coverage: SPEC §17 (embedder teardown).
// #36: Mimetypes.dispose() releases the embedder's native runtime so a consumer
// process can drain its event loop and exit. The embeddings package's
// onnxruntime worker pool holds active+referenced libuv handles; without a way
// to tear it down, a host that ever embedded wedges at exit (plurnk-service
// worked around it with --test-force-exit). dispose() awaits the embedder's own
// dispose() and drops the cached instances.
//
//   D1. awaits the embedder's dispose() when one was loaded.
//   D2. no-op (no throw) when no embedder was ever loaded.
//   D3. swallows a load failure — nothing to release, nothing to surface.
//   D4. idempotent + re-lazy-inits: a second dispose() and subsequent use work.
//   D5. clears cached handler instances (channels re-resolve afterward).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";

const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/x",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

function makeDiscovery(): Discovery {
    const registry: Registry = {
        byExtension: new Map([[".tst", "text/x-test"]]),
        byFilename: new Map(),
    };
    return { registry, handlers: new Map([["text/x-test", INFO]]) };
}

// A disposable embedder that records how many times dispose() was awaited.
function makeEmbedder() {
    let disposed = 0;
    return {
        disposed: () => disposed,
        dimension: 2,
        async embed(): Promise<Uint8Array> {
            return new Uint8Array(new Float32Array(2).buffer);
        },
        async dispose(): Promise<void> {
            disposed += 1;
        },
    };
}

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

describe("#36 — Mimetypes.dispose()", () => {
    it("D1: awaits the embedder's dispose() once it was loaded", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.process({ path: "a.tst", content: "x" }, { channels: ["embedding"] });
        await m.dispose();
        assert.equal(embedder.disposed(), 1, "embedder.dispose() must be awaited");
    });

    it("D2: no-op when no embedder was ever loaded", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.dispose(); // never triggered the embedding channel
        assert.equal(embedder.disposed(), 0, "nothing loaded → nothing to release");
    });

    it("D3: swallows a load failure — nothing to surface", async () => {
        const m = mk(null); // loader throws MODULE_NOT_FOUND for the embedder
        await m.embedderInfo(); // forces the (failing) load attempt to be cached
        await assert.doesNotReject(m.dispose());
    });

    it("D4: is idempotent and re-lazy-inits afterward", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.process({ path: "a.tst", content: "x" }, { channels: ["embedding"] });
        await m.dispose();
        await m.dispose(); // second call: embedder already dropped, no re-dispose
        assert.equal(embedder.disposed(), 1, "second dispose() must not re-release");
        // Channel still works — the embedder re-loads transparently.
        const out = await m.process({ path: "a.tst", content: "x" }, { channels: ["embedding"] });
        assert.ok(out.embedding instanceof Uint8Array);
        await m.dispose();
        assert.equal(embedder.disposed(), 2, "re-loaded embedder disposes again");
    });

    it("D5: clears cached handler instances", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.process({ path: "a.tst", content: "x\ny" }, { channels: ["symbols"] });
        await m.dispose();
        // Re-resolving after dispose still produces a usable result.
        const out = await m.process({ path: "a.tst", content: "x\ny" }, { channels: ["symbols"] });
        assert.ok(out.symbols, "handler re-resolves after dispose()");
    });
});

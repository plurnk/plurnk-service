// Content channel — model-facing readable text projection (HTML-only for now).
// Design conversation 2026-06-14; see SPEC §18.
//
//   C1. content is absent by default — directly-readable formats (whose raw
//       body IS the content) populate nothing.
//   C2. content is in the DEFAULT channel set (cheap, model-facing) but absent
//       from the result when the handler returns undefined.
//   C3. a handler that overrides content() surfaces it on the requested channel.
//   C4. embedding embeds content() when present (HTML markdown), not the raw
//       bytes — and falls back to toText/body when content() is undefined.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";

const fakeEmbedder = {
    dimension: 2,
    model: "fake@1",
    async embed(text: string): Promise<Uint8Array> {
        // Encode the embedded text's length + first char so a test can prove
        // WHICH text was embedded.
        return new Uint8Array(new Float32Array([text.length, text.charCodeAt(0) || 0]).buffer);
    },
};

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) byExtension.set(ext.toLowerCase(), info.mimetype);
    }
    const registry: Registry = { byExtension, byFilename: new Map() };
    return { registry, handlers: handlerMap };
}

const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/x",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

// Stand-in for text/html: content() returns a "markdown" projection that
// differs from the raw body; toText returns the same readable text.
class MarkdownHandler extends BaseHandler {
    override content(c: string | Uint8Array): string {
        return `# ${typeof c === "string" ? c.replace(/<[^>]+>/g, "") : ""}`;
    }
    protected override toText(c: string | Uint8Array): string {
        return this.content(c) as string;
    }
}

function mk(handler: new (...a: never[]) => BaseHandler, withEmbedder = false) {
    return new Mimetypes({
        discovery: makeDiscovery([INFO]),
        loader: async (pkg) => {
            if (pkg === EMB_PKG) {
                if (!withEmbedder) throw Object.assign(new Error("MODULE_NOT_FOUND"), { code: "ERR_MODULE_NOT_FOUND" });
                return fakeEmbedder;
            }
            return { default: handler };
        },
    });
}

describe("content channel — C1: absent by default", () => {
    it("a plain handler populates no content even when the channel is requested", async () => {
        const m = mk(BaseHandler);
        const r = await m.process({ path: "a.tst", content: "hello" }, { channels: ["content"] });
        assert.equal("content" in r, false, "no content key when handler returns undefined");
    });

    it("content is in the default channel set (requested without asking)", async () => {
        const m = mk(MarkdownHandler);
        const r = await m.process({ path: "a.tst", content: "<b>hi</b>" });
        assert.equal(r.content, "# hi", "default process() computes content");
    });
});

describe("content channel — C3: overriding handler surfaces it", () => {
    it("MarkdownHandler projects readable text distinct from the body", async () => {
        const m = mk(MarkdownHandler);
        const r = await m.process(
            { path: "a.tst", content: "<p>article body</p>" },
            { channels: ["content"] },
        );
        assert.equal(r.content, "# article body");
        assert.equal("symbols" in r, false, "only the requested channel");
    });
});

describe("content channel — C4: embedding embeds the readable projection", () => {
    it("HTML-like handler embeds content() markdown, not the raw markup", async () => {
        const m = mk(MarkdownHandler, true);
        const r = await m.process(
            { path: "a.tst", content: "<b>x</b>" },
            { channels: ["embedding"] },
        );
        // content() = "# x" (len 3, first char '#'=35), NOT "<b>x</b>" (len 8).
        const v = new Float32Array(r.embedding!.buffer, r.embedding!.byteOffset, 2);
        assert.equal(v[0], 3, "embedded the markdown projection length, not the markup");
        assert.equal(v[1], "#".charCodeAt(0));
    });

    it("a plain handler (no content) still embeds its body via passthrough", async () => {
        const m = mk(BaseHandler, true);
        const r = await m.process({ path: "a.tst", content: "hello" }, { channels: ["embedding"] });
        const v = new Float32Array(r.embedding!.buffer, r.embedding!.byteOffset, 2);
        assert.equal(v[0], 5, "embedded the raw body ('hello')");
    });
});

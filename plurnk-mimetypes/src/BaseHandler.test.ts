import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import type { MimeSymbol, Preview, SymbolPreview } from "./types.ts";

const metadata = {
    mimetype: "text/plain",
    glyph: "📄",
    extensions: [".txt"] as const,
};

describe("BaseHandler", () => {
    it("exposes metadata on the instance", () => {
        const h = new BaseHandler(metadata);
        assert.equal(h.mimetype, "text/plain");
        assert.equal(h.glyph, "📄");
        assert.deepEqual([...h.extensions], [".txt"]);
    });

    it("freezes the extensions array", () => {
        const h = new BaseHandler(metadata);
        assert.ok(Object.isFrozen(h.extensions));
    });

    it("returns an empty array from extractRaw by default", () => {
        const h = new BaseHandler(metadata);
        assert.deepEqual(h.extractRaw("anything"), []);
    });

    it("returns an empty string from symbolsRaw when extractRaw is empty", async () => {
        const h = new BaseHandler(metadata);
        assert.equal(await h.symbolsRaw("anything"), "");
    });

    it("treats validate as a no-op by default", () => {
        const h = new BaseHandler(metadata);
        assert.doesNotThrow(() => h.validate("anything"));
    });

    it("returns a symbols Preview with an empty symbol list when extractRaw is empty", async () => {
        const h = new BaseHandler(metadata);
        const preview = (await h.preview("anything")) as SymbolPreview;
        assert.equal(preview.kind, "symbols");
        assert.deepEqual([...preview.symbols], []);
    });

    it("renders symbolsRaw from a subclass's extractRaw via format", async () => {
        class TestHandler extends BaseHandler {
            override extractRaw(_content: string): MimeSymbol[] {
                return [{ name: "Foo", kind: "class", line: 1, endLine: 10 }];
            }
        }
        const h = new TestHandler(metadata);
        assert.equal(await h.symbolsRaw("anything"), "class Foo [1-10]");
    });

    it("returns a symbols Preview carrying the extractRaw output", async () => {
        class TestHandler extends BaseHandler {
            extractRaw(_content: string): MimeSymbol[] {
                return [
                    { name: "A", kind: "class", line: 1, endLine: 5 },
                    { name: "B", kind: "class", line: 10, endLine: 15 },
                ];
            }
        }
        const h = new TestHandler(metadata);
        const preview = (await h.preview("anything")) as SymbolPreview;
        assert.equal(preview.kind, "symbols");
        assert.deepEqual(
            [...preview.symbols],
            [
                { name: "A", kind: "class", line: 1, endLine: 5 },
                { name: "B", kind: "class", line: 10, endLine: 15 },
            ],
        );
    });

    it("allows subclasses to return null when no preview material is appropriate", async () => {
        class NullHandler extends BaseHandler {
            override preview(_content: string | Uint8Array): Preview {
                return null;
            }
        }
        const h = new NullHandler(metadata);
        assert.equal(await h.preview("anything"), null);
    });
});

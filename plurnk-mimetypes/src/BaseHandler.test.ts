import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import type { MimeSymbol } from "./types.ts";

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

    it("returns an empty array from extract by default", () => {
        const h = new BaseHandler(metadata);
        assert.deepEqual(h.extract("anything"), []);
    });

    it("returns an empty string from symbols when extract is empty", () => {
        const h = new BaseHandler(metadata);
        assert.equal(h.symbols("anything"), "");
    });

    it("treats validate as a no-op by default", () => {
        const h = new BaseHandler(metadata);
        assert.doesNotThrow(() => h.validate("anything"));
    });

    it("returns an empty preview string when extract is empty", async () => {
        const h = new BaseHandler(metadata);
        assert.equal(await h.preview("anything", 100), "");
    });

    it("derives symbols string from a subclass's extract via format", () => {
        class TestHandler extends BaseHandler {
            extract(_content: string): MimeSymbol[] {
                return [{ name: "Foo", kind: "class", line: 1, endLine: 10 }];
            }
        }
        const h = new TestHandler(metadata);
        assert.equal(h.symbols("anything"), "class Foo [1-10]");
    });

    it("derives preview from a subclass's extract via fit", async () => {
        class TestHandler extends BaseHandler {
            extract(_content: string): MimeSymbol[] {
                return [
                    { name: "A", kind: "class", line: 1, endLine: 5 },
                    { name: "B", kind: "class", line: 10, endLine: 15 },
                ];
            }
        }
        const h = new TestHandler(metadata);
        const preview = await h.preview("anything", 10000);
        assert.equal(preview, ["class A [1-5]", "class B [10-15]"].join("\n"));
    });

    it("uses the injected tokenize function for budgeting", async () => {
        let called = false;
        class TestHandler extends BaseHandler {
            extract(_content: string): MimeSymbol[] {
                return [{ name: "Foo", kind: "class", line: 1, endLine: 5 }];
            }
        }
        const h = new TestHandler(metadata, {
            tokenize: async (text) => {
                called = true;
                return text.length;
            },
        });
        await h.preview("anything", 1000);
        assert.ok(called, "injected tokenize should be invoked");
    });

    it("defaults to text.length/2 ceiling when no tokenize is injected", async () => {
        // Indirect test: with default tokenize, a single symbol that produces a
        // 16-char string takes ceil(16/2) = 8 "tokens". Budget of 7 should drop it.
        class TestHandler extends BaseHandler {
            extract(_content: string): MimeSymbol[] {
                return [{ name: "Foo", kind: "class", line: 1, endLine: 10 }]; // "class Foo [1-10]" = 16 chars
            }
        }
        const h = new TestHandler(metadata);
        const out = await h.preview("anything", 7);
        assert.equal(out, "");
    });
});

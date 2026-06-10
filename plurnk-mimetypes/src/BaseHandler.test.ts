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

    it("returns an empty references list by default (#19 lands the engine)", async () => {
        const h = new BaseHandler(metadata);
        assert.deepEqual(await h.references("anything"), []);
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

    it("exposes extractRaw output as the structured symbols surface", async () => {
        class TestHandler extends BaseHandler {
            extractRaw(_content: string): MimeSymbol[] {
                return [
                    { name: "A", kind: "class", line: 1, endLine: 5 },
                    { name: "B", kind: "class", line: 10, endLine: 15 },
                ];
            }
        }
        const h = new TestHandler(metadata);
        assert.deepEqual(
            await h.extractRaw("anything"),
            [
                { name: "A", kind: "class", line: 1, endLine: 5 },
                { name: "B", kind: "class", line: 10, endLine: 15 },
            ],
        );
    });
});

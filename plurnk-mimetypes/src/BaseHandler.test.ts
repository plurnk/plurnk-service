// Contract: {§mimetype-handler-contract}.
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
    it("{§mimetype-content-query} structural evidence addresses its text source even when a readable sibling exists", async () => {
        class Projected extends BaseHandler {
            override content(): string { return "a different readable projection"; }
            override deepJson(): unknown { return { type: "node", line: 2, endLine: 2, name: "source" }; }
        }
        const h = new Projected(metadata);
        const expected = [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 7 }];
        for (const [dialect, pattern] of [["xpath", "//node"], ["jsonpath", "$"]] as const) {
            const matches = await h.query("before\nsource\nafter", dialect, pattern);
            assert.equal(matches.length, 1);
            assert.deepEqual(matches[0].regions, expected);
            const binary = await h.query(new TextEncoder().encode("before\nsource\nafter"), dialect, pattern);
            assert.equal(binary[0].regions, undefined, "bytes do not imply a text source map");
        }
        const computed = await h.query("before\nsource\nafter", "xpath", "count(//node)");
        assert.equal(computed[0].regions, undefined, "a computed scalar has no source node");
    });
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

    it("reports no parser recovery evidence by default", () => {
        const h = new BaseHandler(metadata);
        assert.equal(h.parseIssues("anything"), 0);
    });

    it("declares no effective projection configuration by default", () => {
        const h = new BaseHandler(metadata);
        assert.equal(h.projectionConfiguration(), "");
    });

    it("returns an empty references list by default ({§mimetype-references})", async () => {
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
            override extractRaw(_content: string): MimeSymbol[] {
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

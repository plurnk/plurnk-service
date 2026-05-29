import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import { UnsupportedDialectError } from "./QueryError.ts";
import type { MimeSymbol } from "./types.ts";

const metadata = {
    mimetype: "text/test",
    glyph: "🧪",
    extensions: [".test"] as const,
};

describe("BaseHandler.query — regex default", () => {
    it("applies regex against decoded text content", async () => {
        const h = new BaseHandler(metadata);
        const out = await h.query("foo bar foo", "regex", "foo");
        assert.equal(out.length, 2);
    });

    it("rejects regex on binary content via toText default", async () => {
        const h = new BaseHandler(metadata);
        await assert.rejects(
            async () => { await h.query(new Uint8Array([0x01]), "regex", "."); },
            (err: unknown) => err instanceof UnsupportedDialectError,
        );
    });
});

describe("BaseHandler.query — glob default", () => {
    it("applies glob line-anchored against text", async () => {
        const h = new BaseHandler(metadata);
        const out = await h.query("error: foo\nwarn: bar\nerror: baz", "glob", "error: *");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "error: foo");
    });
});

describe("BaseHandler.query — jsonpath default (against outline)", () => {
    it("applies jsonpath against the bare-leaves outline from extractRaw", async () => {
        class WithSymbols extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [
                    { name: "Top", kind: "heading", level: 1, line: 1, endLine: 1 },
                    { name: "Section", kind: "heading", level: 2, line: 3, endLine: 3 },
                    { name: "Sub", kind: "heading", level: 3, line: 5, endLine: 5 },
                ];
            }
        }
        const h = new WithSymbols(metadata);
        const out = await h.query("(unused content)", "jsonpath", "$.Top.Section.Sub");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, 5);
        assert.equal(out[0].line, 5);
    });

    it("returns [] when extractRaw is empty", async () => {
        const h = new BaseHandler(metadata);
        const out = await h.query("any", "jsonpath", "$.Anything");
        assert.deepEqual(out, []);
    });
});

describe("BaseHandler.query — xpath default", () => {
    it("throws UnsupportedDialectError on the default handler (no xpath path)", async () => {
        const h = new BaseHandler(metadata);
        await assert.rejects(
            async () => { await h.query("any", "xpath", "//foo"); },
            (err: unknown) =>
                err instanceof UnsupportedDialectError &&
                err.dialect === "xpath" &&
                err.mimetype === "text/test",
        );
    });
});

describe("BaseHandler.query — subclass overrides", () => {
    it("allows a subclass to override toText for binary content (PDF pattern)", async () => {
        class BinaryWithText extends BaseHandler {
            protected override async toText(content: string | Uint8Array): Promise<string> {
                if (content instanceof Uint8Array) return "extracted text from bytes";
                return content;
            }
        }
        const h = new BinaryWithText(metadata);
        const out = await h.query(new Uint8Array([0x01]), "regex", "extracted");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "extracted");
    });

    it("allows a subclass to override the whole query method (handler-side dispatch)", async () => {
        class CustomXpath extends BaseHandler {
            override async query(
                content: string | Uint8Array,
                dialect: "regex" | "glob" | "xpath" | "jsonpath",
                pattern: string,
                flags?: string,
            ) {
                if (dialect === "xpath") {
                    return [{ line: 1, matched: "<x/>", matching: `(${pattern})[1]` }];
                }
                return super.query(content, dialect, pattern, flags);
            }
        }
        const h = new CustomXpath(metadata);
        const out = await h.query("any", "xpath", "//x");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "<x/>");
    });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";
import type { MimeSymbol, SymbolPreview } from "@plurnk/plurnk-mimetypes";

const metadata = {
    mimetype: "application/pdf",
    glyph: "📕",
    extensions: [".pdf"] as const,
};

const h = new ApplicationPdf(metadata);

async function symbolsOf(pdf: Uint8Array): Promise<MimeSymbol[]> {
    const preview = await h.preview(pdf);
    if (preview === null) return [];
    assert.equal(preview.kind, "symbols");
    return [...(preview as SymbolPreview).symbols];
}

describe("ApplicationPdf — validate", () => {
    it("instantiates with metadata", () => {
        assert.equal(h.mimetype, "application/pdf");
        assert.equal(h.glyph, "📕");
    });

    it("validates a real PDF by header magic", () => {
        const pdf = buildPdf({ title: "Test" });
        assert.doesNotThrow(() => h.validate(pdf));
    });

    it("rejects garbage bytes as invalid PDF", () => {
        const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
        assert.throws(() => h.validate(garbage), /Not a PDF/);
    });

    it("rejects empty input as invalid PDF", () => {
        assert.throws(() => h.validate(new Uint8Array(0)), /Not a PDF/);
    });

    it("tolerates a UTF-8 BOM prefix before the header", () => {
        const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
        const pdf = buildPdf({ title: "BomTest" });
        const withBom = new Uint8Array(bom.length + pdf.length);
        withBom.set(bom, 0);
        withBom.set(pdf, bom.length);
        assert.doesNotThrow(() => h.validate(withBom));
    });
});

describe("ApplicationPdf — outline extraction (primary structural source)", () => {
    it("emits flat outline items as level-1 heading symbols", async () => {
        const pdf = buildPdf({
            outline: [
                { title: "Chapter 1" },
                { title: "Chapter 2" },
                { title: "Chapter 3" },
            ],
        });
        const syms = await symbolsOf(pdf);
        assert.equal(syms.length, 3);
        assert.deepEqual(syms.map((s) => ({ n: s.name, l: s.level })), [
            { n: "Chapter 1", l: 1 },
            { n: "Chapter 2", l: 1 },
            { n: "Chapter 3", l: 1 },
        ]);
    });

    it("nests children at deeper levels (level = depth)", async () => {
        const pdf = buildPdf({
            outline: [
                {
                    title: "Part I",
                    items: [
                        { title: "Chapter 1" },
                        {
                            title: "Chapter 2",
                            items: [{ title: "Section 2.1" }],
                        },
                    ],
                },
                { title: "Part II" },
            ],
        });
        const syms = await symbolsOf(pdf);
        const byName = new Map(syms.map((s) => [s.name, s]));
        assert.equal(byName.get("Part I")?.level, 1);
        assert.equal(byName.get("Chapter 1")?.level, 2);
        assert.equal(byName.get("Chapter 2")?.level, 2);
        assert.equal(byName.get("Section 2.1")?.level, 3);
        assert.equal(byName.get("Part II")?.level, 1);
    });

    it("preserves outline order via monotonic line numbers", async () => {
        const pdf = buildPdf({
            outline: [
                { title: "First" },
                { title: "Second" },
                { title: "Third" },
            ],
        });
        const syms = await symbolsOf(pdf);
        const lines = syms.map((s) => s.line);
        for (let i = 1; i < lines.length; i += 1) {
            assert.ok(lines[i] > lines[i - 1], "lines should be strictly increasing");
        }
    });

    it("prefers outline over metadata title when both exist", async () => {
        const pdf = buildPdf({
            title: "Document Metadata Title",
            outline: [{ title: "Real Chapter" }],
        });
        const syms = await symbolsOf(pdf);
        assert.equal(syms.length, 1);
        assert.equal(syms[0].name, "Real Chapter");
    });
});

describe("ApplicationPdf — metadata title fallback", () => {
    it("emits the PDF Info dict Title as a level-1 heading when no outline", async () => {
        const pdf = buildPdf({ title: "Sample Document" });
        const syms = await symbolsOf(pdf);
        assert.equal(syms.length, 1);
        assert.deepEqual(syms[0], {
            name: "Sample Document",
            kind: "heading",
            level: 1,
            line: 1,
            endLine: 1,
        });
    });

    it("trims whitespace around the title", async () => {
        const pdf = buildPdf({ title: "   Padded Title   " });
        const syms = await symbolsOf(pdf);
        assert.equal(syms[0].name, "Padded Title");
    });

    it("escapes special characters in titles", async () => {
        const pdf = buildPdf({ title: "Title (with parens) and \\backslash" });
        const syms = await symbolsOf(pdf);
        assert.equal(syms[0].name, "Title (with parens) and \\backslash");
    });
});

describe("ApplicationPdf — null returns (dark in the radar)", () => {
    it("returns null preview for a PDF with no outline and no Title", async () => {
        const pdf = buildPdf({});
        const preview = await h.preview(pdf);
        assert.equal(preview, null);
    });

    it("returns null preview on parse failure (handler authority — no raw byte leak)", async () => {
        const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        const preview = await h.preview(garbage);
        assert.equal(preview, null);
    });
});

describe("ApplicationPdf — escape hatches", () => {
    it("symbolsRaw returns empty string (PDFs surface structure through preview, not extractRaw)", () => {
        const pdf = buildPdf({ title: "X" });
        assert.equal(h.symbolsRaw(pdf), "");
    });

    it("extractRaw returns empty array", () => {
        const pdf = buildPdf({ title: "X" });
        assert.deepEqual(h.extractRaw(pdf), []);
    });
});

// Hand-crafted PDF with an actual text content stream ("Hello, world!") —
// the buildPdf helper produces structurally valid PDFs but doesn't emit page
// content, which means it has no text for regex/glob queries to match
// against. Embedded here for the body-text query tests below.
const HELLO_WORLD_PDF_B64 =
    "JVBERi0xLjQKJaWx6woxIDAgb2JqCjw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PgplbmRvYmoKMiAwIG9iago8PCAvVHlwZSAvUGFnZXMgL0tpZHMgWzMgMCBSXSAvQ291bnQgMSA+PgplbmRvYmoKMyAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDMwMCAxNDRdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ1ID4+CnN0cmVhbQpCVCAvRjEgMTggVGYgMzYgMTAwIFRkIChIZWxsbywgd29ybGQhKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTQgMDAwMDAgbiAKMDAwMDAwMDA2MyAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAyNDYgMDAwMDAgbiAKMDAwMDAwMDM0MCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=";

function helloWorldPdf(): Uint8Array {
    return new Uint8Array(Buffer.from(HELLO_WORLD_PDF_B64, "base64"));
}

describe("ApplicationPdf — query (body-matcher path)", () => {
    it("regex matches against extracted page text via toText override", async () => {
        const out = await h.query(helloWorldPdf(), "regex", "Hello, (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["world"]);
    });

    it("glob matches against extracted page text", async () => {
        const out = await h.query(helloWorldPdf(), "glob", "Hello, *");
        assert.equal(out.length, 1);
        assert.ok((out[0].matched as string).includes("Hello, world!"));
    });

    it("jsonpath inherits outline-shape default; PDF with outline is queryable by bookmark title", async () => {
        const pdf = buildPdf({
            outline: [{ title: "Chapter 1", items: [{ title: "Section 1.1" }] }],
        });
        const out = await h.query(pdf, "jsonpath", "$['Chapter 1']['Section 1.1']");
        assert.equal(out.length, 1);
        assert.equal(typeof out[0].matched, "number");
    });
});

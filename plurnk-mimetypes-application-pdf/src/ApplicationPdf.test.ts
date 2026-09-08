import test from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

const handler = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] });

test("validate accepts the %PDF- magic, with or without a BOM, and refuses anything else", () => {
    const pdf = buildPdf({ title: "T" });
    handler.validate(pdf);
    handler.validate(new Uint8Array([0xef, 0xbb, 0xbf, ...pdf]));
    assert.throws(() => handler.validate(new TextEncoder().encode("not a pdf")), /header magic is absent/u);
    assert.throws(() => handler.validate("text"), /Uint8Array/u);
});

test("facts are the page tree's count and the byte size; nothing is extracted", () => {
    const pdf = buildPdf({ title: "T" });
    assert.deepEqual(handler.facts(pdf), { pages: 1, bytes: pdf.length });
    assert.equal(handler.content(pdf), `PDF document, 1 page, ${pdf.length} bytes`);
    assert.equal(handler.summary(pdf), handler.content(pdf));
    assert.deepEqual(handler.deepJson(pdf), { pages: 1, bytes: pdf.length });
});

test("a compressed page tree yields no page count, only the size", () => {
    const opaque = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 3 >>\nstream\n \nendstream\nendobj\n%%EOF\n");
    assert.deepEqual(handler.facts(opaque), { pages: null, bytes: opaque.length });
    assert.equal(handler.content(opaque), `PDF document, ${opaque.length} bytes`);
});

test("the root page tree's count wins over intermediate nodes", () => {
    const nested = new TextEncoder().encode([
        "%PDF-1.4",
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
        "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 5 >> endobj",
        "3 0 obj << /Type /Pages /Parent 2 0 R /Kids [] /Count 2 >> endobj",
        "4 0 obj << /Count 3 /Type /Pages /Parent 2 0 R /Kids [] >> endobj",
        "%%EOF",
    ].join("\n"));
    assert.equal(handler.facts(nested).pages, 5);
});

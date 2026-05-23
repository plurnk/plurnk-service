import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import type { TextPreview } from "@plurnk/plurnk-mimetypes";

const metadata = {
    mimetype: "application/pdf",
    glyph: "📕",
    extensions: [".pdf"] as const,
};

// Minimal valid PDF containing "Hello, world!" — generated programmatically
// with computed xref byte offsets. ~600 bytes total. Plenty for exercising
// the validate + preview paths end-to-end.
const SAMPLE_PDF_B64 =
    "JVBERi0xLjQKJaWx6woxIDAgb2JqCjw8IC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUiA+PgplbmRvYmoKMiAwIG9iago8PCAvVHlwZSAvUGFnZXMgL0tpZHMgWzMgMCBSXSAvQ291bnQgMSA+PgplbmRvYmoKMyAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDMwMCAxNDRdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDQ1ID4+CnN0cmVhbQpCVCAvRjEgMTggVGYgMzYgMTAwIFRkIChIZWxsbywgd29ybGQhKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTQgMDAwMDAgbiAKMDAwMDAwMDA2MyAwMDAwMCBuIAowMDAwMDAwMTIwIDAwMDAwIG4gCjAwMDAwMDAyNDYgMDAwMDAgbiAKMDAwMDAwMDM0MCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo=";

function samplePdf(): Uint8Array {
    return new Uint8Array(Buffer.from(SAMPLE_PDF_B64, "base64"));
}

const h = new ApplicationPdf(metadata);

describe("ApplicationPdf", () => {
    it("instantiates with metadata", () => {
        assert.equal(h.mimetype, "application/pdf");
        assert.equal(h.glyph, "📕");
    });

    it("validates a real PDF by header magic", () => {
        assert.doesNotThrow(() => h.validate(samplePdf()));
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
        const sample = samplePdf();
        const withBom = new Uint8Array(bom.length + sample.length);
        withBom.set(bom, 0);
        withBom.set(sample, bom.length);
        assert.doesNotThrow(() => h.validate(withBom));
    });

    it("preview returns a head-oriented text Preview carrying extracted content", async () => {
        const preview = (await h.preview(samplePdf())) as TextPreview;
        assert.equal(preview.kind, "text");
        assert.equal(preview.orientation, "head");
        assert.ok(preview.text.includes("Hello, world!"));
    });

    it("preview returns null on parse failure (handler authority — no raw byte leak)", async () => {
        const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        const preview = await h.preview(garbage);
        assert.equal(preview, null);
    });

    it("symbolsRaw returns empty string (PDFs don't expose structural symbols in this canary)", () => {
        assert.equal(h.symbolsRaw(samplePdf()), "");
    });

    it("extractRaw returns empty array", () => {
        assert.deepEqual(h.extractRaw(samplePdf()), []);
    });
});

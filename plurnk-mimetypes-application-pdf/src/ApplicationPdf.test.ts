import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";

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

    it("validates a real PDF (text extractable)", async () => {
        await assert.doesNotReject(() => h.validate(samplePdf()));
    });

    it("rejects garbage bytes as invalid PDF", async () => {
        const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
        await assert.rejects(() => h.validate(garbage));
    });

    it("rejects empty input as invalid PDF", async () => {
        await assert.rejects(() => h.validate(new Uint8Array(0)));
    });

    it("preview returns extracted text content", async () => {
        const text = await h.preview(samplePdf(), Number.POSITIVE_INFINITY);
        assert.ok(text.includes("Hello, world!"));
    });

    it("preview budgets via the injected tokenize function", async () => {
        const tokenizingHandler = new ApplicationPdf(metadata, {
            tokenize: (text) => text.length,
        });
        const text = await tokenizingHandler.preview(samplePdf(), 5);
        assert.ok(text.length <= 5);
    });

    it("preview returns empty string on parse failure (graceful)", async () => {
        const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
        const text = await h.preview(garbage, Number.POSITIVE_INFINITY);
        assert.equal(text, "");
    });

    it("symbols returns empty string (PDFs don't expose structural symbols in this canary)", () => {
        assert.equal(h.symbols(samplePdf()), "");
    });

    it("extract returns empty array", () => {
        assert.deepEqual(h.extract(samplePdf()), []);
    });
});

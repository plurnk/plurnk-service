import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

const metadata = {
    mimetype: "application/pdf",
    glyph: "📕",
    extensions: [".pdf"] as const,
};

const h = new ApplicationPdf(metadata);

describe("{§mimetype-pdf-facts} facts", () => {
    it("reports the page count and byte size of a parseable document", async () => {
        const pdf = buildPdf({ title: "Facts" });
        assert.deepEqual(await h.facts(pdf), { pages: 1, bytes: pdf.byteLength });
    });
    it("reports null pages for bytes that do not parse, keeping the byte size", async () => {
        const junk = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0x01]);
        assert.deepEqual(await h.facts(junk), { pages: null, bytes: junk.byteLength });
    });
});

// deepJson document model — metadata + detect-only security signals on top of
// the outline structure (Tier 1 of the portable PDF ceiling). All from the
// document model; no rendering, no active-content execution.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

interface DocModel {
    type: string;
    metadata: Record<string, unknown>;
    security: { hasJavaScript: boolean; hasEmbeddedFiles: boolean };
    children: Array<{ name: string }>;
}

describe("ApplicationPdf — deepJson document model (metadata + security)", () => {
    it("surfaces document metadata (title + always-present pageCount)", async () => {
        const model = (await h.deepJson(buildPdf({ title: "Quarterly Report" }))) as DocModel;
        assert.equal(model.type, "document");
        assert.equal(model.metadata.title, "Quarterly Report");
        assert.equal(model.metadata.pageCount, 1);
    });

    it("reports detect-only security signals (clean PDF → no active content)", async () => {
        const model = (await h.deepJson(buildPdf({ title: "Clean" }))) as DocModel;
        assert.deepEqual(model.security, { hasJavaScript: false, hasEmbeddedFiles: false });
    });

    it("is non-null with zero structure — metadata keeps the deep channel lit", async () => {
        // Previously deepJson returned null without an outline; now the document
        // model (metadata + security) is always present for a parseable PDF,
        // even one with no title and no bookmarks.
        const model = (await h.deepJson(buildPdf({}))) as DocModel;
        assert.notEqual(model, null);
        assert.equal(model.children.length, 0);
        assert.equal(model.metadata.pageCount, 1);
        assert.equal(model.metadata.title, undefined);
    });

    it("still carries the outline as children when bookmarks are present", async () => {
        const model = (await h.deepJson(buildPdf({
            title: "Doc",
            outline: [{ title: "Chapter 1", items: [{ title: "Section 1.1" }] }],
        }))) as DocModel;
        const names = model.children.map((c) => c.name);
        assert.ok(names.includes("Chapter 1"));
        assert.ok(names.includes("Section 1.1"));
    });

    it("returns null on unparseable input (degrade-to-dark preserved)", async () => {
        const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x01]); // %PDF- then junk
        assert.equal(await h.deepJson(garbage), null);
    });
});

// Hyperlinks in the document model (Tier 1). URI Link annotations are surfaced
// as document data on deepJson.links — NOT in the references channel, whose
// RefKind is frozen to code-nav semantics. Detect-only: never followed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

interface DocModel {
    links: Array<{ url: string; line: number; endLine: number }>;
}

async function linksOf(pdf: Uint8Array): Promise<Array<{ url: string; line: number; endLine: number }>> {
    return ((await h.deepJson(pdf)) as DocModel).links;
}

describe("ApplicationPdf — hyperlinks in deepJson", () => {
    it("surfaces URI link annotations with their page", async () => {
        const links = await linksOf(buildPdf({ title: "Doc", links: ["https://example.com/a"] }));
        assert.deepEqual(links, [{ url: "https://example.com/a", line: 1, endLine: 1 }]);
    });

    it("surfaces multiple links on a page", async () => {
        const links = await linksOf(buildPdf({ links: ["https://a.example", "https://b.example"] }));
        const urls = links.map((l) => l.url);
        assert.ok(urls.includes("https://a.example/"));
        assert.ok(urls.includes("https://b.example/"));
        assert.ok(links.every((l) => l.line === 1 && l.endLine === 1));
    });

    it("a PDF with no links yields an empty list (not null, not missing)", async () => {
        const links = await linksOf(buildPdf({ title: "No Links" }));
        assert.deepEqual(links, []);
    });

    it("dedupes identical url+page", async () => {
        const links = await linksOf(buildPdf({ links: ["https://dup.example/", "https://dup.example/"] }));
        assert.equal(links.length, 1);
    });
});

// Resource caps + render-free guarantee (plurnk-mimetypes#38).
//
// The handler extracts text + structure only and never rasterizes, so pdfjs's
// lazy `require("@napi-rs/canvas")` (render path only) is never reached — a
// missing/broken canvas binary cannot crash these paths. These tests pin the
// DoS caps degrade cleanly (never throw out of the pipeline) and that ordinary
// extraction succeeds without any canvas/render involvement.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildPdf } from "./buildPdf.ts";

const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
    const prev = process.env[key];
    process.env[key] = value;
    try {
        await fn();
    } finally {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
    }
}

describe("ApplicationPdf — resource caps (#38 DoS resistance)", () => {
    it("a PDF over the byte cap degrades to empty symbols / null deepJson, never throws", async () => {
        const pdf = buildPdf({ title: "Over Cap", outline: [{ title: "A" }] });
        await withEnv("PLURNK_PDF_MAX_BYTES", "10", async () => {
            assert.deepEqual(await h.extractRaw(pdf), []);
            assert.equal(await h.deepJson(pdf), null);
        });
    });

    it("with no cap set (unbounded default), the same PDF extracts normally", async () => {
        const pdf = buildPdf({ title: "Doc", outline: [{ title: "A" }] });
        const syms = await h.extractRaw(pdf);
        assert.ok(syms.length > 0, "expected symbols with no cap set");
    });

    it("a malformed page cap crashes loud — never silently degrades to empty", async () => {
        const pdf = buildPdf({ title: "Doc", outline: [{ title: "A" }] });
        // `0`, negatives, and non-numbers are operator misconfigurations: they
        // must throw at the public entry, not get swallowed by the channel's
        // degrade-to-dark catch as an empty result (the old `|| magic-default`
        // bug, inverted).
        for (const bad of ["0", "-1", "abc"]) {
            await withEnv("PLURNK_PDF_MAX_PAGES", bad, async () => {
                await assert.rejects(() => h.extractRaw(pdf), /PLURNK_PDF_MAX_PAGES must be a positive integer/);
                await assert.rejects(() => h.query(pdf, "regex", ".+"), /PLURNK_PDF_MAX_PAGES must be a positive integer/);
            });
        }
    });

    it("render-free path: ordinary text + structure extraction succeeds (canvas never on the path)", async () => {
        const pdf = buildPdf({ title: "Render Free", outline: [{ title: "Intro" }, { title: "Body" }] });
        const syms = await h.extractRaw(pdf);
        assert.ok(syms.some((s) => s.name === "Intro"), "structure extracted without rasterizing");
    });
});

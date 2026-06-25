// AcroForm fields in the document model (Tier 2). Read-only: surfaces what a
// form holds (name/value/type/page) without filling or executing it. Verified
// against genuine pdfjs getFieldObjects() output via a real form-PDF fixture.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ApplicationPdf from "./ApplicationPdf.ts";
import { buildFormPdf } from "./buildFormPdf.ts";
import { buildPdf } from "./buildPdf.ts";

const h = new ApplicationPdf({ mimetype: "application/pdf", glyph: "📕", extensions: [".pdf"] as const });

interface DocModel {
    forms: Array<{ name: string; value: string; type: string; page: number }>;
}

describe("ApplicationPdf — AcroForm fields in deepJson", () => {
    it("surfaces text field name, value, type and 1-indexed page", async () => {
        const model = (await h.deepJson(buildFormPdf([
            { name: "full_name", value: "Ada Lovelace" },
            { name: "email", value: "ada@example.com" },
        ]))) as DocModel;
        assert.deepEqual(model.forms, [
            { name: "full_name", value: "Ada Lovelace", type: "text", page: 1 },
            { name: "email", value: "ada@example.com", type: "text", page: 1 },
        ]);
    });

    it("a PDF with no AcroForm yields an empty list", async () => {
        const model = (await h.deepJson(buildPdf({ title: "No Form" }))) as DocModel;
        assert.deepEqual(model.forms, []);
    });

    it("preserves an empty field value as the empty string (not dropped)", async () => {
        const model = (await h.deepJson(buildFormPdf([{ name: "optional", value: "" }]))) as DocModel;
        assert.equal(model.forms.length, 1);
        assert.equal(model.forms[0].name, "optional");
        assert.equal(model.forms[0].value, "");
    });
});

import test from "node:test";
import { strict as assert } from "node:assert";
import { emptyRegistry, Mimetypes } from "@plurnk/plurnk-mimetypes";
import MimetypeBinary from "./mimetype-binary.ts";

const mimetypes = new Mimetypes({
    discovery: { registry: emptyRegistry(), handlers: new Map(), skipped: [] },
});

const classifications: ReadonlyArray<readonly [string, boolean, readonly string[]]> = [
    ["text types", false, ["text/plain", "text/markdown", "text/html", "text/csv"]],
    ["known application text types", false, ["application/json", "application/yaml", "application/toml", "application/xml"]],
    ["structured text suffixes", false, ["application/vnd.api+json", "image/svg+xml", "application/cloudevents+yaml"]],
    ["media types", true, ["image/png", "image/jpeg", "audio/mpeg", "video/mp4"]],
    ["binary application types", true, ["application/pdf", "application/octet-stream", "application/zip"]],
    ["malformed labels", true, ["noslashhere"]],
    ["empty label", false, [""]],
];

for (const [name, expected, labels] of classifications) {
    test(`configured registry classifies ${name}`, async () => {
        for (const label of labels) {
            assert.equal(await MimetypeBinary.isBinaryMimetype(label, mimetypes), expected, label);
        }
    });
}

test("binary classification requires the configured registry", async () => {
    await assert.rejects(
        MimetypeBinary.isBinaryMimetype("text/plain", undefined),
        /configured mimetype registry is required/,
    );
});

// --- MimetypeBinary.normalizeAutoTextMimetype ---

test("MimetypeBinary.normalizeAutoTextMimetype: text/plain → text/markdown (the text primitive)", () => {
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype("text/plain"), MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE);
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype("text/plain"), "text/markdown");
});

test("MimetypeBinary.normalizeAutoTextMimetype: null/empty → text/markdown", () => {
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype(null), "text/markdown");
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype(undefined), "text/markdown");
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype(""), "text/markdown");
});

test("MimetypeBinary.normalizeAutoTextMimetype: passes other mimetypes through unchanged", () => {
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype("text/markdown"), "text/markdown");
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype("application/json"), "application/json");
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype("image/png"), "image/png");
    assert.equal(MimetypeBinary.normalizeAutoTextMimetype("text/csv"), "text/csv");
});

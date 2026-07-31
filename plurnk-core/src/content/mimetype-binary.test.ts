import test from "node:test";
import { strict as assert } from "node:assert";
import MimetypeBinary from "./mimetype-binary.ts";

test("text/* is text", () => {
    assert.equal(MimetypeBinary.isBinaryMimetype("text/plain"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("text/markdown"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("text/html"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("text/csv"), false);
});

test("application/json + relatives are text", () => {
    assert.equal(MimetypeBinary.isBinaryMimetype("application/json"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("application/yaml"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("application/toml"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("application/xml"), false);
});

test("+json / +xml / +yaml suffix is text", () => {
    assert.equal(MimetypeBinary.isBinaryMimetype("application/vnd.api+json"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("image/svg+xml"), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("application/cloudevents+yaml"), false);
});

test("image/audio/video are binary", () => {
    assert.equal(MimetypeBinary.isBinaryMimetype("image/png"), true);
    assert.equal(MimetypeBinary.isBinaryMimetype("image/jpeg"), true);
    assert.equal(MimetypeBinary.isBinaryMimetype("audio/mpeg"), true);
    assert.equal(MimetypeBinary.isBinaryMimetype("video/mp4"), true);
});

test("application/pdf and friends are binary", () => {
    assert.equal(MimetypeBinary.isBinaryMimetype("application/pdf"), true);
    assert.equal(MimetypeBinary.isBinaryMimetype("application/octet-stream"), true);
    assert.equal(MimetypeBinary.isBinaryMimetype("application/zip"), true);
});

test("malformed input", () => {
    assert.equal(MimetypeBinary.isBinaryMimetype(""), false);
    assert.equal(MimetypeBinary.isBinaryMimetype("noslashhere"), true);
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

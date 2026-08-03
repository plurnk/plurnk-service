import test from "node:test";
import { strict as assert } from "node:assert";
import MimetypeClassifier, { TEXT_PRIMITIVE_MIMETYPE } from "./MimetypeClassifier.ts";

test("text/* is text", () => {
    assert.equal(MimetypeClassifier.isBinary("text/plain"), false);
    assert.equal(MimetypeClassifier.isBinary("text/markdown"), false);
    assert.equal(MimetypeClassifier.isBinary("text/html"), false);
    assert.equal(MimetypeClassifier.isBinary("text/csv"), false);
});

test("application/json + relatives are text", () => {
    assert.equal(MimetypeClassifier.isBinary("application/json"), false);
    assert.equal(MimetypeClassifier.isBinary("application/yaml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/toml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/xml"), false);
});

test("NDJSON family is text and not a single JSON document (schemes#28)", () => {
    for (const mt of ["application/jsonl", "application/x-ndjson"]) {
        assert.equal(MimetypeClassifier.isBinary(mt), false);
        assert.equal(MimetypeClassifier.isJson(mt), false);
    }
});

test("+json / +xml / +yaml suffix is text", () => {
    assert.equal(MimetypeClassifier.isBinary("application/vnd.api+json"), false);
    assert.equal(MimetypeClassifier.isBinary("image/svg+xml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/cloudevents+yaml"), false);
});

test("the web-readable HTML family includes HTML and XHTML only", () => {
    assert.equal(MimetypeClassifier.isHtml("text/html"), true);
    assert.equal(MimetypeClassifier.isHtml("application/xhtml+xml"), true);
    assert.equal(MimetypeClassifier.isHtml("image/svg+xml"), false);
    assert.equal(MimetypeClassifier.isHtml("text/plain"), false);
});

test("image/audio/video are binary", () => {
    assert.equal(MimetypeClassifier.isBinary("image/png"), true);
    assert.equal(MimetypeClassifier.isBinary("image/jpeg"), true);
    assert.equal(MimetypeClassifier.isBinary("audio/mpeg"), true);
    assert.equal(MimetypeClassifier.isBinary("video/mp4"), true);
});

test("application/pdf and friends are binary", () => {
    assert.equal(MimetypeClassifier.isBinary("application/pdf"), true);
    assert.equal(MimetypeClassifier.isBinary("application/octet-stream"), true);
    assert.equal(MimetypeClassifier.isBinary("application/zip"), true);
});

test("malformed input", () => {
    assert.equal(MimetypeClassifier.isBinary(""), false);
    assert.equal(MimetypeClassifier.isBinary("noslashhere"), true);
});

// --- normalizeAutoTextMimetype ---

test("normalizeAutoTextMimetype: text/plain → text/markdown (the text primitive)", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText("text/plain"), TEXT_PRIMITIVE_MIMETYPE);
    assert.equal(MimetypeClassifier.normalizeAutoText("text/plain"), "text/markdown");
});

test("normalizeAutoTextMimetype: null/empty → text/markdown", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText(null), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText(undefined), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText(""), "text/markdown");
});

test("normalizeAutoTextMimetype: passes other mimetypes through unchanged", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText("text/markdown"), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText("application/json"), "application/json");
    assert.equal(MimetypeClassifier.normalizeAutoText("image/png"), "image/png");
    assert.equal(MimetypeClassifier.normalizeAutoText("text/csv"), "text/csv");
});

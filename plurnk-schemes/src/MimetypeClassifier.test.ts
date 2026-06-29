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

test("+json / +xml / +yaml suffix is text", () => {
    assert.equal(MimetypeClassifier.isBinary("application/vnd.api+json"), false);
    assert.equal(MimetypeClassifier.isBinary("image/svg+xml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/cloudevents+yaml"), false);
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

// --- isLineNavigableMimetype ---

test("line-navigable: text/plain, text/markdown, text/csv, source code", () => {
    assert.equal(MimetypeClassifier.isLineNavigable("text/plain"), true);
    assert.equal(MimetypeClassifier.isLineNavigable("text/markdown"), true);
    assert.equal(MimetypeClassifier.isLineNavigable("text/csv"), true);
    assert.equal(MimetypeClassifier.isLineNavigable("text/javascript"), true);
    assert.equal(MimetypeClassifier.isLineNavigable("text/typescript"), true);
    assert.equal(MimetypeClassifier.isLineNavigable("application/javascript"), true);
    assert.equal(MimetypeClassifier.isLineNavigable("application/yaml"), true);
    assert.equal(MimetypeClassifier.isLineNavigable("application/toml"), true);
});

test("tree-navigable: JSON, XML, HTML, suffix variants", () => {
    assert.equal(MimetypeClassifier.isLineNavigable("application/json"), false);
    assert.equal(MimetypeClassifier.isLineNavigable("application/xml"), false);
    assert.equal(MimetypeClassifier.isLineNavigable("text/html"), false);
    assert.equal(MimetypeClassifier.isLineNavigable("application/vnd.api+json"), false);
    assert.equal(MimetypeClassifier.isLineNavigable("image/svg+xml"), false);
});

test("binary mimetypes are not line-navigable", () => {
    assert.equal(MimetypeClassifier.isLineNavigable("image/png"), false);
    assert.equal(MimetypeClassifier.isLineNavigable("application/pdf"), false);
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

import test from "node:test";
import { strict as assert } from "node:assert";
import { isBinaryMimetype, isLineNavigableMimetype, normalizeAutoTextMimetype, TEXT_PRIMITIVE_MIMETYPE } from "./mimetype-binary.ts";

test("text/* is text", () => {
    assert.equal(isBinaryMimetype("text/plain"), false);
    assert.equal(isBinaryMimetype("text/markdown"), false);
    assert.equal(isBinaryMimetype("text/html"), false);
    assert.equal(isBinaryMimetype("text/csv"), false);
});

test("application/json + relatives are text", () => {
    assert.equal(isBinaryMimetype("application/json"), false);
    assert.equal(isBinaryMimetype("application/yaml"), false);
    assert.equal(isBinaryMimetype("application/toml"), false);
    assert.equal(isBinaryMimetype("application/xml"), false);
});

test("+json / +xml / +yaml suffix is text", () => {
    assert.equal(isBinaryMimetype("application/vnd.api+json"), false);
    assert.equal(isBinaryMimetype("image/svg+xml"), false);
    assert.equal(isBinaryMimetype("application/cloudevents+yaml"), false);
});

test("image/audio/video are binary", () => {
    assert.equal(isBinaryMimetype("image/png"), true);
    assert.equal(isBinaryMimetype("image/jpeg"), true);
    assert.equal(isBinaryMimetype("audio/mpeg"), true);
    assert.equal(isBinaryMimetype("video/mp4"), true);
});

test("application/pdf and friends are binary", () => {
    assert.equal(isBinaryMimetype("application/pdf"), true);
    assert.equal(isBinaryMimetype("application/octet-stream"), true);
    assert.equal(isBinaryMimetype("application/zip"), true);
});

test("malformed input", () => {
    assert.equal(isBinaryMimetype(""), false);
    assert.equal(isBinaryMimetype("noslashhere"), true);
});

// --- isLineNavigableMimetype ---

test("line-navigable: text/plain, text/markdown, text/csv, source code", () => {
    assert.equal(isLineNavigableMimetype("text/plain"), true);
    assert.equal(isLineNavigableMimetype("text/markdown"), true);
    assert.equal(isLineNavigableMimetype("text/csv"), true);
    assert.equal(isLineNavigableMimetype("text/javascript"), true);
    assert.equal(isLineNavigableMimetype("text/typescript"), true);
    assert.equal(isLineNavigableMimetype("application/javascript"), true);
    assert.equal(isLineNavigableMimetype("application/yaml"), true);
    assert.equal(isLineNavigableMimetype("application/toml"), true);
});

test("tree-navigable: JSON, XML, HTML, suffix variants", () => {
    assert.equal(isLineNavigableMimetype("application/json"), false);
    assert.equal(isLineNavigableMimetype("application/xml"), false);
    assert.equal(isLineNavigableMimetype("text/html"), false);
    assert.equal(isLineNavigableMimetype("application/vnd.api+json"), false);
    assert.equal(isLineNavigableMimetype("image/svg+xml"), false);
});

test("binary mimetypes are not line-navigable", () => {
    assert.equal(isLineNavigableMimetype("image/png"), false);
    assert.equal(isLineNavigableMimetype("application/pdf"), false);
});

// --- normalizeAutoTextMimetype ---

test("normalizeAutoTextMimetype: text/plain → text/markdown (the text primitive)", () => {
    assert.equal(normalizeAutoTextMimetype("text/plain"), TEXT_PRIMITIVE_MIMETYPE);
    assert.equal(normalizeAutoTextMimetype("text/plain"), "text/markdown");
});

test("normalizeAutoTextMimetype: null/empty → text/markdown", () => {
    assert.equal(normalizeAutoTextMimetype(null), "text/markdown");
    assert.equal(normalizeAutoTextMimetype(undefined), "text/markdown");
    assert.equal(normalizeAutoTextMimetype(""), "text/markdown");
});

test("normalizeAutoTextMimetype: passes other mimetypes through unchanged", () => {
    assert.equal(normalizeAutoTextMimetype("text/markdown"), "text/markdown");
    assert.equal(normalizeAutoTextMimetype("application/json"), "application/json");
    assert.equal(normalizeAutoTextMimetype("image/png"), "image/png");
    assert.equal(normalizeAutoTextMimetype("text/csv"), "text/csv");
});

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

// --- MimetypeBinary.isLineNavigableMimetype ---

test("line-navigable: text/plain, text/markdown, text/csv, source code", () => {
    assert.equal(MimetypeBinary.isLineNavigableMimetype("text/plain"), true);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("text/markdown"), true);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("text/csv"), true);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("text/javascript"), true);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("text/typescript"), true);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("application/javascript"), true);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("application/yaml"), true);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("application/toml"), true);
});

test("tree-navigable: JSON, XML, HTML, suffix variants", () => {
    assert.equal(MimetypeBinary.isLineNavigableMimetype("application/json"), false);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("application/xml"), false);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("text/html"), false);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("application/vnd.api+json"), false);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("image/svg+xml"), false);
});

test("binary mimetypes are not line-navigable", () => {
    assert.equal(MimetypeBinary.isLineNavigableMimetype("image/png"), false);
    assert.equal(MimetypeBinary.isLineNavigableMimetype("application/pdf"), false);
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

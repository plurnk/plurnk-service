import test from "node:test";
import { strict as assert } from "node:assert";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import MimetypeClassifier, { PathMimetype, TEXT_PRIMITIVE_MIMETYPE } from "./MimetypeClassifier.ts";

test("{§network-address} text/* is text", () => {
    assert.equal(MimetypeClassifier.isBinary("text/plain"), false);
    assert.equal(MimetypeClassifier.isBinary("text/markdown"), false);
    assert.equal(MimetypeClassifier.isBinary("text/html"), false);
    assert.equal(MimetypeClassifier.isBinary("text/csv"), false);
});

test("{§network-address} application/json + relatives are text", () => {
    assert.equal(MimetypeClassifier.isBinary("application/json"), false);
    assert.equal(MimetypeClassifier.isBinary("application/yaml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/toml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/xml"), false);
});

test("{§network-address} NDJSON family is text and not a single JSON document", () => {
    for (const mt of ["application/jsonl", "application/x-ndjson"]) {
        assert.equal(MimetypeClassifier.isBinary(mt), false);
        assert.equal(MimetypeClassifier.isJson(mt), false);
    }
});

test("{§network-address} +json / +xml / +yaml suffix is text", () => {
    assert.equal(MimetypeClassifier.isBinary("application/vnd.api+json"), false);
    assert.equal(MimetypeClassifier.isBinary("image/svg+xml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/cloudevents+yaml"), false);
});

test("{§network-address} the web-readable HTML family includes HTML and XHTML only", () => {
    assert.equal(MimetypeClassifier.isHtml("text/html"), true);
    assert.equal(MimetypeClassifier.isHtml("application/xhtml+xml"), true);
    assert.equal(MimetypeClassifier.isHtml("image/svg+xml"), false);
    assert.equal(MimetypeClassifier.isHtml("text/plain"), false);
});

test("{§network-address} image/audio/video are binary", () => {
    assert.equal(MimetypeClassifier.isBinary("image/png"), true);
    assert.equal(MimetypeClassifier.isBinary("image/jpeg"), true);
    assert.equal(MimetypeClassifier.isBinary("audio/mpeg"), true);
    assert.equal(MimetypeClassifier.isBinary("video/mp4"), true);
});

test("{§network-address} application/pdf and friends are binary", () => {
    assert.equal(MimetypeClassifier.isBinary("application/pdf"), true);
    assert.equal(MimetypeClassifier.isBinary("application/octet-stream"), true);
    assert.equal(MimetypeClassifier.isBinary("application/zip"), true);
});

test("{§network-address} malformed input", () => {
    assert.equal(MimetypeClassifier.isBinary(""), false);
    assert.equal(MimetypeClassifier.isBinary("noslashhere"), true);
});

// --- normalizeAutoTextMimetype ---

test("{§network-address} normalizeAutoText: text/plain → text/markdown (the text primitive)", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText("text/plain"), TEXT_PRIMITIVE_MIMETYPE);
    assert.equal(MimetypeClassifier.normalizeAutoText("text/plain"), "text/markdown");
});

test("{§network-address} normalizeAutoText: null/empty → text/markdown", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText(null), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText(undefined), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText(""), "text/markdown");
});

test("{§network-address} normalizeAutoText: passes other mimetypes through unchanged", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText("text/markdown"), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText("application/json"), "application/json");
    assert.equal(MimetypeClassifier.normalizeAutoText("image/png"), "image/png");
    assert.equal(MimetypeClassifier.normalizeAutoText("text/csv"), "text/csv");
});

test("{§network-address}: textual sources fit generic text destinations without widening structured or binary destinations", () => {
    const text = ["text/plain", "text/markdown", "text/vnd.plurnk", "text/html", "text/csv", "application/json", "application/vnd.api+json", "application/javascript", "image/svg+xml"];
    const mimetypes = [...text, "application/octet-stream", "image/png", "application/pdf", "application/x-unknown"];
    for (const source of mimetypes) {
        for (const destination of mimetypes) {
            const expected = source === destination
                || (text.includes(source) && ["text/plain", "text/markdown"].includes(destination));
            assert.equal(MimetypeClassifier.isTransferCompatible(source, destination), expected, `${source} → ${destination}`);
        }
    }
});

test("{§network-address}: resolved source classification remains authoritative", () => {
    assert.equal(MimetypeClassifier.isTransferCompatible("application/x-custom", "text/plain", { binary: false }), true);
    assert.equal(MimetypeClassifier.isTransferCompatible("text/x-encoded", "text/markdown", { binary: true }), false);
    assert.equal(MimetypeClassifier.isTransferCompatible("application/x-custom", "application/json", { binary: false }), false);
});

const pathMimetypes = new Mimetypes();
await pathMimetypes.ready();

test("{§network-address} resolve: no extension → scheme default", async () => {
    assert.equal(await PathMimetype.resolve("users", "text/markdown", pathMimetypes), "text/markdown");
    assert.equal(await PathMimetype.resolve("notes", "text/plain", pathMimetypes), "text/plain");
});

test("{§network-address} resolve: leading-dot file is not an extension", async () => {
    assert.equal(await PathMimetype.resolve(".env", "text/markdown", pathMimetypes), "text/markdown");
});

test("{§network-address} resolve: unknown extension → scheme default", async () => {
    const result = await PathMimetype.resolve("data.xyz", "text/markdown", pathMimetypes);
    assert.equal(result, "text/markdown");
});

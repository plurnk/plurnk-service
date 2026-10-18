import test from "node:test";
import { strict as assert } from "node:assert";
import MimetypeClassifier, { TEXT_PRIMITIVE_MIMETYPE } from "./MimetypeClassifier.ts";

test("{§mimetype-classifier} text/* is text", () => {
    assert.equal(MimetypeClassifier.isBinary("text/plain"), false);
    assert.equal(MimetypeClassifier.isBinary("text/markdown"), false);
    assert.equal(MimetypeClassifier.isBinary("text/html"), false);
    assert.equal(MimetypeClassifier.isBinary("text/csv"), false);
});

test("{§mimetype-classifier} application/json + relatives are text", () => {
    assert.equal(MimetypeClassifier.isBinary("application/json"), false);
    assert.equal(MimetypeClassifier.isBinary("application/yaml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/toml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/xml"), false);
});

test("{§mimetype-classifier} NDJSON family is text and not a single JSON document", () => {
    for (const mt of ["application/jsonl", "application/x-ndjson"]) {
        assert.equal(MimetypeClassifier.isBinary(mt), false);
        assert.equal(MimetypeClassifier.isJson(mt), false);
    }
});

test("{§mimetype-classifier} +json / +xml / +yaml suffix is text", () => {
    assert.equal(MimetypeClassifier.isBinary("application/vnd.api+json"), false);
    assert.equal(MimetypeClassifier.isBinary("image/svg+xml"), false);
    assert.equal(MimetypeClassifier.isBinary("application/cloudevents+yaml"), false);
});

test("{§mimetype-classifier} the web-readable HTML family includes HTML and XHTML only", () => {
    assert.equal(MimetypeClassifier.isHtml("text/html"), true);
    assert.equal(MimetypeClassifier.isHtml("application/xhtml+xml"), true);
    assert.equal(MimetypeClassifier.isHtml("image/svg+xml"), false);
    assert.equal(MimetypeClassifier.isHtml("text/plain"), false);
});

test("{§mimetype-classifier} image/audio/video are binary", () => {
    assert.equal(MimetypeClassifier.isBinary("image/png"), true);
    assert.equal(MimetypeClassifier.isBinary("image/jpeg"), true);
    assert.equal(MimetypeClassifier.isBinary("audio/mpeg"), true);
    assert.equal(MimetypeClassifier.isBinary("video/mp4"), true);
});

test("{§mimetype-classifier} application/pdf and friends are binary", () => {
    assert.equal(MimetypeClassifier.isBinary("application/pdf"), true);
    assert.equal(MimetypeClassifier.isBinary("application/octet-stream"), true);
    assert.equal(MimetypeClassifier.isBinary("application/zip"), true);
});

test("{§mimetype-classifier} malformed input", () => {
    assert.equal(MimetypeClassifier.isBinary(""), false);
    assert.equal(MimetypeClassifier.isBinary("noslashhere"), true);
});

// --- normalizeAutoTextMimetype ---

test("{§mimetype-classifier} normalizeAutoText: text/plain → text/markdown (the text primitive)", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText("text/plain"), TEXT_PRIMITIVE_MIMETYPE);
    assert.equal(MimetypeClassifier.normalizeAutoText("text/plain"), "text/markdown");
});

test("{§mimetype-classifier} normalizeAutoText: null/empty → text/markdown", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText(null), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText(undefined), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText(""), "text/markdown");
});

test("{§mimetype-classifier} normalizeAutoText: passes other mimetypes through unchanged", () => {
    assert.equal(MimetypeClassifier.normalizeAutoText("text/markdown"), "text/markdown");
    assert.equal(MimetypeClassifier.normalizeAutoText("application/json"), "application/json");
    assert.equal(MimetypeClassifier.normalizeAutoText("image/png"), "image/png");
    assert.equal(MimetypeClassifier.normalizeAutoText("text/csv"), "text/csv");
});

test("{§mimetype-verbatim-transfer}: textual sources fit generic text destinations without widening structured or binary destinations", () => {
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

test("{§mimetype-verbatim-transfer}: resolved source classification remains authoritative", () => {
    assert.equal(MimetypeClassifier.isTransferCompatible("application/x-custom", "text/plain", { binary: false }), true);
    assert.equal(MimetypeClassifier.isTransferCompatible("text/x-encoded", "text/markdown", { binary: true }), false);
    assert.equal(MimetypeClassifier.isTransferCompatible("application/x-custom", "application/json", { binary: false }), false);
});

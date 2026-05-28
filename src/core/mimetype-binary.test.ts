import test from "node:test";
import { strict as assert } from "node:assert";
import { isBinaryMimetype } from "./mimetype-binary.ts";

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

// {§scheme-metadata-modifier} {§matcher-option}
import test from "node:test";
import assert from "node:assert/strict";
import MetadataOptions from "./MetadataOptions.ts";

test("MetadataOptions.parse merges option objects left to right", () => {
    const read = MetadataOptions.parse(['{"a": 1}, {"b": 2, "a": 3}'], "scheme:test");
    assert.deepEqual(read, { options: { a: 3, b: 2 } });
});

test("MetadataOptions.parse drops the language's `pattern` key so an owner never interprets it", () => {
    const read = MetadataOptions.parse(['{"pattern": "/needle/", "remote": true}'], "scheme:test");
    assert.deepEqual(read, { options: { remote: true } });
});

test("MetadataOptions.parse fails malformed blocks as the owner's 400 without echoing the input", () => {
    const read = MetadataOptions.parse(['{"secret": '], "scheme:test");
    assert.ok("failure" in read);
    assert.equal(read.failure.status, 400);
    assert.equal(read.failure.problem?.detail, "[metadata] must be a JSON array of option objects.");
    const repeated = MetadataOptions.parse(['{"a": 1}', '{"b": 2}'], "scheme:test");
    assert.ok("failure" in repeated);
    assert.match(String(repeated.failure.problem?.type), /metadata-repeated$/);
});

test("MetadataOptions.parse withholds the service's `env` key from an owner and surfaces it raw", () => {
    const read = MetadataOptions.parse(['{"cwd": "src", "env": {"CI": "1"}}'], "scheme:test");
    assert.deepEqual(read, { options: { cwd: "src" }, env: { CI: "1" } });
    assert.deepEqual(MetadataOptions.parse(['{"cwd": "src"}'], "scheme:test"), { options: { cwd: "src" } }, "absent stays absent");
});

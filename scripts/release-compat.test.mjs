import test from "node:test";
import assert from "node:assert/strict";
import { caretRange, compatibleRange, exactVersion, supportsVersion } from "./release-compat.mjs";

test("compatible-major ranges accept later minors and reject the next major", () => {
    assert.equal(supportsVersion("^1.2.0", "1.2.0"), true);
    assert.equal(supportsVersion("^1.2.0", "1.3.1"), true);
    assert.equal(supportsVersion("^1.2.0", "2.0.0"), false);
    assert.equal(supportsVersion("^1.2.3", "1.2.2"), false);
});

test("zero-major caret semantics retain npm's narrower compatibility boundary", () => {
    assert.equal(supportsVersion("^0.71.2", "0.71.9"), true);
    assert.equal(supportsVersion("^0.71.2", "0.72.0"), false);
    assert.equal(supportsVersion("^0.0.2", "0.0.2"), true);
    assert.equal(supportsVersion("^0.0.2", "0.0.3"), false);
});

test("release compatibility accepts one canonical spelling", () => {
    assert.notEqual(exactVersion("1.3.1"), null);
    assert.equal(exactVersion("v1.3.1"), null);
    assert.notEqual(caretRange("^1.3.1"), null);
    assert.equal(caretRange("~1.3.1"), null);
    assert.equal(compatibleRange("1.3.1"), "^1.3.1");
    assert.throws(() => compatibleRange("next"), /invalid exact version/);
});

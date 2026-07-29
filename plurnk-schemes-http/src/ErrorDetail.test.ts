import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import ErrorDetail, { ERROR_DETAIL_LIMIT } from "./ErrorDetail.ts";

const original = process.env[ERROR_DETAIL_LIMIT];

afterEach(() => {
    if (original === undefined) delete process.env[ERROR_DETAIL_LIMIT];
    else process.env[ERROR_DETAIL_LIMIT] = original;
});

test("model-facing HTTP diagnostics use the package-owned configured bound", () => {
    process.env[ERROR_DETAIL_LIMIT] = "4";
    const limit = ErrorDetail.configuredLimit();
    assert.equal(ErrorDetail.preview("abcdef", limit), "abcd...");
    assert.equal(ErrorDetail.preview(new Error("abc"), limit), "abc");
});

test("model-facing HTTP diagnostics reject a missing or invalid bound", () => {
    delete process.env[ERROR_DETAIL_LIMIT];
    assert.throws(() => ErrorDetail.configuredLimit(), /must be set/);
    process.env[ERROR_DETAIL_LIMIT] = "-1";
    assert.throws(() => ErrorDetail.configuredLimit(), /non-negative integer/);
});

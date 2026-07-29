import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import ErrorDetail, { ERROR_DETAIL_LIMIT } from "./ErrorDetail.ts";

const original = process.env[ERROR_DETAIL_LIMIT];

afterEach(() => {
    if (original === undefined) delete process.env[ERROR_DETAIL_LIMIT];
    else process.env[ERROR_DETAIL_LIMIT] = original;
});

test("model-facing diagnostic detail uses the package-owned configured bound", () => {
    process.env[ERROR_DETAIL_LIMIT] = "4";
    assert.equal(ErrorDetail.preview("abcdef"), "abcd...");
    assert.equal(ErrorDetail.preview(new Error("abc")), "abc");
});

test("model-facing diagnostic detail rejects a missing or invalid bound", () => {
    delete process.env[ERROR_DETAIL_LIMIT];
    assert.throws(() => ErrorDetail.preview("failure"), /must be set/);
    process.env[ERROR_DETAIL_LIMIT] = "-1";
    assert.throws(() => ErrorDetail.preview("failure"), /non-negative integer/);
});

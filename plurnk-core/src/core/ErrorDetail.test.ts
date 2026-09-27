import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import ErrorDetail, { ERROR_DETAIL_LIMIT } from "./ErrorDetail.ts";

const original = process.env[ERROR_DETAIL_LIMIT];

afterEach(() => {
    if (original === undefined) delete process.env[ERROR_DETAIL_LIMIT];
    else process.env[ERROR_DETAIL_LIMIT] = original;
});

// {§error-detail-bound}
test("model-facing diagnostic detail uses the package-owned configured bound", () => {
    process.env[ERROR_DETAIL_LIMIT] = "4";
    assert.equal(ErrorDetail.preview("abcdef"), "abcd...");
    assert.equal(ErrorDetail.preview(new Error("abc")), "abc");
});

test("model-facing diagnostic detail rejects a missing or invalid bound by name", () => {
    delete process.env[ERROR_DETAIL_LIMIT];
    assert.throws(() => ErrorDetail.preview("failure"), /PLURNK_SERVICE_ERROR_DETAIL_LIMIT is missing from the assembled environment floor/);
    process.env[ERROR_DETAIL_LIMIT] = "-1";
    assert.throws(() => ErrorDetail.preview("failure"), /PLURNK_SERVICE_ERROR_DETAIL_LIMIT must be a safe integer of at least 0/);
});

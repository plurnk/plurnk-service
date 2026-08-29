import assert from "node:assert/strict";
import test from "node:test";
import ErrorDetail, { ERROR_DETAIL_LIMIT } from "./ErrorDetail.ts";

test("A2A diagnostics use their package-owned configured bound", () => {
    const env = { [ERROR_DETAIL_LIMIT]: "4" };
    assert.equal(ErrorDetail.preview(new Error("sensitive upstream diagnostic"), env), "sens...");
});

test("A2A diagnostic configuration is required and non-negative", () => {
    assert.throws(() => ErrorDetail.configuredLimit({}), new RegExp(`${ERROR_DETAIL_LIMIT} must be set`, "u"));
    assert.throws(
        () => ErrorDetail.configuredLimit({ [ERROR_DETAIL_LIMIT]: "-1" }),
        new RegExp(`${ERROR_DETAIL_LIMIT} must be a non-negative integer`, "u"),
    );
});

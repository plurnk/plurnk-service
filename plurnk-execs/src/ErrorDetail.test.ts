import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import ErrorDetail, { ERROR_DETAIL_LIMIT } from "./ErrorDetail.ts";

const original = process.env[ERROR_DETAIL_LIMIT];

afterEach(() => {
    if (original === undefined) delete process.env[ERROR_DETAIL_LIMIT];
    else process.env[ERROR_DETAIL_LIMIT] = original;
});

test("error detail limit is required, configurable, and deterministic", () => {
    delete process.env[ERROR_DETAIL_LIMIT];
    assert.equal(ErrorDetail.configuredLimit(), null);

    process.env[ERROR_DETAIL_LIMIT] = "4";
    assert.equal(ErrorDetail.configuredLimit(), 4);
    assert.equal(ErrorDetail.preview("abcdef", 4), "abcd...");
});

test("a missing or invalid error detail limit has one exact configuration Problem", () => {
    for (const raw of [undefined, "-1"]) {
        if (raw === undefined) delete process.env[ERROR_DETAIL_LIMIT];
        else process.env[ERROR_DETAIL_LIMIT] = raw;
        assert.equal(ErrorDetail.configuredLimit(), null);
        assert.deepEqual(ErrorDetail.invalidConfiguration("executor:test"), {
            status: 500,
            problem: {
                type: "https://problems.plurnk.dev/executor/test/invalid-configuration",
                title: "Invalid configuration",
                status: 500,
                detail: `${ERROR_DETAIL_LIMIT} must be set to a non-negative integer.`,
                configuration: ERROR_DETAIL_LIMIT,
                stage: "configuration",
                retryable: false,
            },
        });
    }
});

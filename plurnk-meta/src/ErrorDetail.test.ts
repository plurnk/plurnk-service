import test from "node:test";
import assert from "node:assert/strict";
import ErrorDetail from "./ErrorDetail.ts";

const KNOB = "PLURNK_TEST_ERROR_DETAIL_LIMIT";
const withEnv = (value: string | undefined, body: () => void): void => {
    const prior = process.env[KNOB];
    try {
        if (value === undefined) delete process.env[KNOB]; else process.env[KNOB] = value;
        body();
    } finally {
        if (prior === undefined) delete process.env[KNOB]; else process.env[KNOB] = prior;
    }
};

test("{§error-detail-bound} a diagnostic preview is bounded by the package's own knob", () => {
    const detail = new ErrorDetail(KNOB);
    withEnv("4", () => {
        assert.equal(detail.limit(), 4);
        assert.equal(detail.preview("abcdef"), "abcd...");
        assert.equal(detail.preview(new Error("abc")), "abc");
    });
    withEnv("0", () => assert.equal(detail.preview("abc"), "...", "zero keeps nothing but the mark"));
});

test("{§error-detail-bound} an unset or invalid bound crashes by name", () => {
    const detail = new ErrorDetail(KNOB);
    withEnv(undefined, () => assert.throws(() => detail.preview("failure"), /PLURNK_TEST_ERROR_DETAIL_LIMIT is missing from the assembled environment floor/));
    for (const bad of ["", "-1", "1.5", "many"]) {
        withEnv(bad, () => assert.throws(() => detail.preview("failure"), /PLURNK_TEST_ERROR_DETAIL_LIMIT must be a safe integer of at least 0/, JSON.stringify(bad)));
    }
});

test("{§error-detail-bound} offline validation uses the supplied environment, not ambient state", () => {
    const detail = new ErrorDetail(KNOB);
    withEnv("4", () => {
        assert.equal(detail.limit({ [KNOB]: "12" }), 12);
        assert.throws(() => detail.limit({}), /is missing from the assembled environment floor/u);
    });
});

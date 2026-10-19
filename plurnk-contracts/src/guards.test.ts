import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecord, isSafeInteger } from "./guards.ts";

test("{§wire-entrypoint} isRecord admits exactly a non-null, non-array object", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(Object.create(null)), true);
    for (const other of [null, undefined, [], [1], "x", 1, true, () => {}]) assert.equal(isRecord(other), false, String(other));
});

test("{§wire-entrypoint} isSafeInteger admits exactly a safe integer", () => {
    assert.equal(isSafeInteger(0), true);
    assert.equal(isSafeInteger(-3), true);
    assert.equal(isSafeInteger(Number.MAX_SAFE_INTEGER), true);
    for (const other of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", null, undefined, true]) {
        assert.equal(isSafeInteger(other), false, String(other));
    }
});

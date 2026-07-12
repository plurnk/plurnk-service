// Enforces the SPEC.md ↔ test anchor bijection (Charter §5). Every contract promise must
// have a covering test, and no test may cite a contract that SPEC.md does not define.

import test from "node:test";
import assert from "node:assert/strict";
import { checkSpecCoverage } from "../../scriptify/spec-coverage.ts";

test("SPEC contracts and test anchors are in bijection", () => {
    const { specOnly, testOnly } = checkSpecCoverage();
    assert.deepEqual(specOnly, [], `SPEC contracts with no covering test: ${specOnly.join(", ")}`);
    assert.deepEqual(testOnly, [], `test anchors absent from SPEC: ${testOnly.join(", ")}`);
});

import test from "node:test";
import assert from "node:assert/strict";
import * as Contracts from "./index.ts";
import {
    PlurnkParser,
    Problems,
    UNKNOWN_POSITION,
    Validator,
} from "./index.ts";

test("the package root exposes exactly the supported runtime values", () => {
    assert.deepEqual(Object.keys(Contracts).sort(), [
        "DEFAULT_LOOP_FLAGS",
        "DEFAULT_RETRIEVAL_LIMIT",
        "InvalidClientDisplayCapabilitiesError",
        "InvalidEntryReadResultError",
        "InvalidLoopFlagsError",
        "InvalidNoticeError",
        "InvalidOperationResultError",
        "InvalidProblemDetailsError",
        "InvalidProposalProjectionError",
        "InvalidRangeExtentError",
        "InvalidTextRegionError",
        "PLURNK_OPS",
        "PathSyntax",
        "PlurnkParseError",
        "PlurnkParser",
        "Problems",
        "RESERVED_AUTHORITIES",
        "UNKNOWN_POSITION",
        "Validator",
        "WORKER_NAME",
        "parsePath",
        "parseResourceSelection",
        "renderJsonResult",
    ]);
});

test("the package root is the singular language and wire-contract API", () => {
    const parsed = PlurnkParser.parseStatements("## EDIT0 (worker:///draft)\nbody");
    const item = parsed.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;

    assert.equal(item.statement.op, "EDIT");
    assert.equal(Validator.validatePosition(item.statement.position).valid, true);

    const problem = Problems.create("contracts", "missing", 404, "Missing.");
    assert.equal(Validator.validateOperationResult({ status: 404, problem }).valid, true);
});

test("unknown statement position is one frozen contracts-owned value", () => {
    assert.deepEqual(UNKNOWN_POSITION, { line: 0, column: 0 });
    assert.equal(Object.isFrozen(UNKNOWN_POSITION), true);
    assert.equal(Validator.validatePosition(UNKNOWN_POSITION).valid, true);
});

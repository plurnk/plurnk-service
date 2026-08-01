import test from "node:test";
import assert from "node:assert/strict";
import {
    PlurnkParser,
    Problems,
    Validator,
} from "./index.ts";

test("the package root is the singular language and wire-contract API", () => {
    const parsed = PlurnkParser.parseStatements("<<EDIT(worker:///draft):body:EDIT");
    const item = parsed.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;

    assert.equal(item.statement.op, "EDIT");
    assert.equal(Validator.validatePosition(item.statement.position).valid, true);

    const problem = Problems.create("contracts", "missing", 404, "Missing.");
    assert.equal(Validator.validateOperationResult({ status: 404, problem }).valid, true);
});

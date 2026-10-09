import assert from "node:assert/strict";
import test from "node:test";
import PlurnkParseError from "./PlurnkParseError.ts";

test("{§parse-admission}: a warning preserves whether an attempted operation was omitted", () => {
    const omitted = new PlurnkParseError(1, 2, "parser", "Operation omitted.", "warning", undefined, true);
    assert.equal(omitted.operationOmitted, true);
    assert.deepEqual(omitted.toJSON(), {
        line: 1, column: 2, source: "parser", severity: "warning", message: "Operation omitted.", operationOmitted: true,
    });
    const recovered = new PlurnkParseError(1, 2, "parser", "Operation recovered.", "warning");
    assert.equal(recovered.operationOmitted, false);
    assert.deepEqual(recovered.toJSON(), {
        line: 1, column: 2, source: "parser", severity: "warning", message: "Operation recovered.",
    });
});

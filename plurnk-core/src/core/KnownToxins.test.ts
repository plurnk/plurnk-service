import test from "node:test";
import assert from "node:assert/strict";
import KnownToxins from "./KnownToxins.ts";

test("{§response-text-note} the toxin register names foreign tool-call grammars and template leaks, never prose", () => {
    assert.equal(KnownToxins.match('<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="READ">\n</｜｜DSML｜｜ calls>'), "<｜｜DSML｜｜", "the markup sphinx-10325 died on (#840)");
    assert.equal(KnownToxins.match('<tool_call>\n{"name": "read"}\n</tool_call>'), "<tool_call>");
    assert.equal(KnownToxins.match('<function_calls><invoke name="READ"></invoke></function_calls>'), "<function_calls>");
    assert.equal(KnownToxins.match("[TOOL_CALLS][{\"name\": \"sh\"}]"), "[TOOL_CALLS]");
    assert.equal(KnownToxins.match("<|im_start|>assistant\nhello"), "<|im_start|>");
    assert.equal(KnownToxins.match("I'll verify my implementation against a broader test run."), null);
});

test("{§response-text-note} prose is retained, but foreign tool-call markup is not", () => {
    assert.equal(KnownToxins.retains("I'll verify my implementation against a broader test run."), true);
    assert.equal(KnownToxins.retains('<tool_call>{"name":"read"}</tool_call>'), false);
});

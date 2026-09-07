import assert from "node:assert/strict";
import test from "node:test";
import LineSelection from "./line-selection.ts";

test("{§log-readable-projection}: sparse selection retains original Unicode text and separators", () => {
    assert.deepEqual(LineSelection.retain("one\r\ntwo\r\n😀\r\nfour", [2, 4]), { content: "two\r\nfour", ordinals: [2, 4] });
    assert.deepEqual(LineSelection.retain("two\nthree\nfour\n", [2, 4], 2), { content: "two\nfour\n", ordinals: [2, 4] });
});

test("{§log-readable-projection}: matcher regions map through gaps and the trailing newline boundary", () => {
    assert.deepEqual(LineSelection.region({ startLine: 1, startColumn: 2, endLine: 2, endColumn: 3 }, [2, 4]), { startLine: 2, startColumn: 2, endLine: 4, endColumn: 3 });
    assert.deepEqual(LineSelection.region({ startLine: 2, startColumn: 1, endLine: 3, endColumn: 1 }, [2, 4]), { startLine: 4, startColumn: 1, endLine: 5, endColumn: 1 });
    assert.equal(LineSelection.region({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, []), undefined, "an empty match has no readable line");
    assert.throws(() => LineSelection.region({ startLine: 4, startColumn: 1, endLine: 4, endColumn: 2 }, [2, 4]), RangeError);
});

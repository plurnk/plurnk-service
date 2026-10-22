import test from "node:test";
import assert from "node:assert/strict";
import { excerptOf } from "./Excerpt.ts";

test("{§list-excerpt} the excerpt is the first line holding anything but blanks, cut whole characters, blanks trimmed from its end", () => {
    const cases: ReadonlyArray<readonly [string, number, string, boolean, string]> = [
        ["Fits.", 10, "Fits.", false, "a short message is its own excerpt"],
        ["Fits.\n   \n", 10, "Fits.", false, "trailing blank lines continue nothing"],
        ["\n \n  No, you did it wrong!  \r\nHere is why.", 10, "No, you di", true, "leading blank lines and spaces are skipped"],
        ["Check the tests, all of them.", 10, "Check the", true, "a cut that lands after a space keeps no trailing blank"],
        ["Line one\r\nLine two", 20, "Line one", true, "a carriage return ends no excerpt's words"],
        ["a\tb", 10, "a\tb", false, "a tab inside the line stays"],
        ["😀".repeat(12), 10, "😀".repeat(10), true, "a character is never cut in two"],
        ["", 10, "", false, "an empty message"],
        [" \n\t\r\n", 10, "", false, "a message of blanks alone"],
        [" x", 10, " x", false, "a no-break space is not a blank"],
        ["first\n\nsecond", 3, "fir", true, "a cut first line continues"],
    ];
    for (const [text, chars, excerpt, continued, why] of cases) {
        assert.deepEqual(excerptOf(text, chars), { excerpt, continued }, why);
    }
    const long = `${"x".repeat(1_000_000)}\nmore`;
    assert.deepEqual(excerptOf(long, 240), { excerpt: "x".repeat(240), continued: true }, "a long line costs its excerpt, not its length");
});

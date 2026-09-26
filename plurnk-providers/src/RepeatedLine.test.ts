import test from "node:test";
import assert from "node:assert/strict";
import RepeatedLine from "./RepeatedLine.ts";

test("{§repetition-stop} a line repeated to the limit stops the stream, across chunk boundaries", () => {
    const guard = new RepeatedLine(3);
    const line = "gitea list_issues {\"owner\": \"plunk\"}";
    assert.equal(guard.push(`${line}\n${line.slice(0, 10)}`), null);
    assert.equal(guard.push(`${line.slice(10)}\n`), null);
    assert.deepEqual(guard.push(`  ${line}  \n`), { line, count: 3 });
});

test("{§repetition-stop} short lines and an unfinished line never count", () => {
    const guard = new RepeatedLine(2);
    assert.equal(guard.push("}\n}\n}\n- item\n- item\n"), null, "lines under 16 characters recur legitimately");
    assert.equal(guard.push("a line long enough to count, never finished"), null);
    assert.equal(guard.push("a line long enough to count, never finished"), null);
});

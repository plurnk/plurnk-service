// {§logical-line-count} — a pattern scope's -1 clamps to the text's last logical line, the count
// TextCoordinates owns, so a terminated file bounds exactly as an unterminated one does.
import test from "node:test";
import assert from "node:assert/strict";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import PatternSelection from "./PatternSelection.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

const ctx = { mimetypes: new Mimetypes() } as unknown as PlurnkSchemeContext;
const match = (content: string, marks: readonly number[]) => PatternSelection.match({
    matcher: { dialect: "glob", raw: "old*" }, content, mimetype: "text/plain", marks, ctx, scheme: "worker", operation: "EDIT",
});

test("a pattern scope's -1 is the last logical line whether or not the text ends in a newline", async () => {
    for (const content of ["keep\nold value", "keep\nold value\n"]) {
        const bounded = await match(content, [2, -1]);
        assert.ok(!("result" in bounded), `<2,-1> on ${JSON.stringify(content)} selects`);
        assert.deepEqual(bounded.bounds, { from: 2, to: 2 }, `${JSON.stringify(content)}: -1 clamps to line 2, the last line`);
        const past = await match(content, [3, -1]);
        assert.ok("result" in past, `<3,-1> on ${JSON.stringify(content)} names no line`);
        assert.equal(past.result.status, 400);
        assert.match(String(past.result.problem?.type), /\/pattern-scope-invalid$/);
    }
});

// {§logical-line-count} — a pattern scope's -1 clamps to the text's last logical line, the count
// TextCoordinates owns, so a terminated file bounds exactly as an unterminated one does.
import test from "node:test";
import assert from "node:assert/strict";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import PatternSelection from "./PatternSelection.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import { parsePath } from "@plurnk/plurnk-parser";

const ctx = { mimetypes: new Mimetypes() } as unknown as PlurnkSchemeContext;
const match = (content: string, marks: readonly number[]) => PatternSelection.match({
    matcher: { dialect: "glob", raw: "old*" }, content, mimetype: "text/plain", target: parsePath("worker:///entry")!, marks, ctx, scheme: "worker", operation: "EDIT",
});

test("a pattern scope's -1 is the last logical line whether or not the text ends in a newline", async () => {
    for (const content of ["keep\nold value", "keep\nold value\n"]) {
        const bounded = await match(content, [2, -1]);
        assert.ok(!("result" in bounded), `<2,-1> on ${JSON.stringify(content)} selects`);
        assert.deepEqual(bounded.spans, [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 10 }], `${JSON.stringify(content)}: -1 clamps to line 2, the last line`);
        const past = await match(content, [3, -1]);
        assert.ok("result" in past, `<3,-1> on ${JSON.stringify(content)} names no line`);
        assert.equal(past.result.status, 400);
        assert.match(String(past.result.problem?.type), /\/pattern-scope-invalid$/);
    }
});

test("{§slice-semantics-compose-pattern} an exact-source operation never widens an enclosing match or silently drops an unlocated one", async () => {
    for (const evidence of [
        { matched: "name", matching: "//name", enclosingRegions: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }] },
        { matched: 1, matching: "count(//name)" },
    ]) {
        const source = { mimetypes: { query: async () => [evidence] } } as unknown as PlurnkSchemeContext;
        const result = await PatternSelection.match({
            matcher: { dialect: "xpath", raw: "//name" }, content: "abc", mimetype: "text/test",
            target: parsePath("worker:///entry")!, marks: undefined, ctx: source, scheme: "worker", operation: "EDIT",
        });
        assert.ok("result" in result, JSON.stringify(result));
        assert.equal(result.result.status, 422);
        assert.match(String(result.result.problem?.type), /\/pattern-source-unlocated$/);
    }
});

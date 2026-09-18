// {§anchor-offset} — recorded anchor-offset scopes parse; a bare +N without an anchor stays refused (#749).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const marksOf = (heading: string) => {
    const result = PlurnkParser.parse(heading.startsWith("````EDIT") ? `${heading}\nbody\n\`\`\`\`` : `${heading}\n\`\`\`\``);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), [], heading);
    const [statement] = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    return statement !== undefined && "lineMarker" in statement ? statement.lineMarker?.marks : undefined;
};

test("{§anchor-offset} recorded offset scopes read as anchor-relative marks", () => {
    assert.deepEqual(marksOf("````EDIT (tests/test_laws.py) <@wtxRn,+1> <!-- register after Result -->"), ["@wtxRn", "@wtxRn+1"]);
    assert.deepEqual(marksOf("````EDIT (world.ts) <@QLTY4,@LVx89+1> <!-- drop duplicated set signature -->"), ["@QLTY4", "@LVx89+1"]);
    assert.deepEqual(marksOf("````EDIT (catalog.md) <@ormjQ+1>"), ["@ormjQ+1"]);
    assert.deepEqual(marksOf("````EDIT (catalog.md) <@ormjQ-2,@ormjQ>"), ["@ormjQ-2", "@ormjQ"]);
});

test("{§anchor-offset} a bare +N counts only from an anchor", () => {
    for (const heading of ["````EDIT (a.md) <3,+1>", "````EDIT (a.md) <+1>"]) {
        const result = PlurnkParser.parse(`${heading}\nbody\n\`\`\`\``);
        assert.ok(result.items.some((item) => item.kind === "error" && item.error.severity === "error"), heading);
    }
    assert.deepEqual(marksOf("````READ (a.md) <1,-1>"), [1, -1], "a negative end is still the numeric end");
});

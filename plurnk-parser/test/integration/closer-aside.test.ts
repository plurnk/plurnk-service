// {§closer-aside} — a closer followed only by an aside closes; it is never written into the body (#758).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const statements = (input: string) => PlurnkParser.parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

test("{§closer-aside} the recorded corrupting EDIT deletes its line instead of writing the fence into the file", () => {
    const edits = statements("````EDIT (returns/converters.py) <9>\n```` <!-- remove duplicated Result import -->\n\n````READ (returns/converters.py)\n````");
    assert.deepEqual(edits.map((statement) => [statement.op, "body" in statement ? statement.body : undefined]), [["EDIT", null], ["READ", null]]);
});

test("{§closer-aside} a bodied EDIT keeps exactly its body; a closer followed by prose is still body", () => {
    assert.equal((statements("````EDIT (a.md) <3>\nnew line\n```` <!-- why -->")[0] as { body: string | null }).body, "new line");
    assert.equal((statements("````EDIT (doc.md) <1,-1>\nbody\n```` then prose\n````")[0] as { body: string | null }).body, "body\n```` then prose");
});

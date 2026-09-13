/** Broad structural checks for the model-facing reference, never wording pins. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlurnkParser, PLURNK_OPS } from "../../src/index.ts";

const teaching = readFileSync(new URL("../../plurnk.md", import.meta.url), "utf8");

test("concrete KILL examples in plurnk.md parse as one clean operation", () => {
    const unindented = teaching.replace(/^ {4}/gm, "");
    const examples = [...unindented.matchAll(/^(?:[*|].*?)?((`{3,})KILL\b[^\n]*?(?:\2[ \t]*$|\n[\s\S]*?^\2[ \t]*$))/gm)].map((match) => match[1]!);
    assert.ok(examples.length > 0, "the reference demonstrates curation operations");
    for (const source of examples) {
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.items.length, 1, source);
        assert.equal(parsed.items[0]?.kind, "statement", source);
        assert.equal(parsed.unparsedTail, undefined, source);
    }
});

test("plurnk.md retains broad operation coverage without pinning prose", () => {
    for (const op of PLURNK_OPS) {
        if (op === "EXEC") continue;
        assert.match(teaching, new RegExp("^(?:`{3,}" + op + "(?: |$)|[*-] " + op + "(?: \\([^)]*\\))*:)", "m"), `operation reference is missing ${op}`);
    }
});

/** Broad structural checks for the model-facing reference, never wording pins. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlurnkParser } from "../../src/index.ts";
import { PLURNK_OPS } from "@plurnk/plurnk-contracts";

const teaching = readFileSync(new URL("./plurnk.md", import.meta.resolve("@plurnk/plurnk-contracts/package.json")), "utf8");

test("concrete core-operation examples in plurnk.md parse verbatim as one clean operation", () => {
    const examples = [...teaching.matchAll(/^([ \t]*(`{3,})([A-Z]+)\b[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$)/gm)]
        .filter((match) => PLURNK_OPS.some((op) => op === match[3]));
    assert.ok(examples.length > 0, "the reference demonstrates concrete operations");
    for (const example of examples) {
        const source = example[1]!;
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.items.length, 1, source);
        const item = parsed.items[0]!;
        assert.equal(item.kind, "statement", source);
        if (item.kind === "statement") assert.equal(item.statement.op, example[3], source);
        assert.equal(parsed.unparsedTail, undefined, source);
    }
});

test("plurnk.md retains broad operation coverage without pinning prose", () => {
    for (const op of PLURNK_OPS) {
        assert.match(teaching, new RegExp("^(?:`{3,}" + op + "(?: |$)|[*-] " + op + "(?: \\([^)]*\\)(?: <[^>]+>\\??)?)*:)", "m"), `operation reference is missing ${op}`);
    }
});

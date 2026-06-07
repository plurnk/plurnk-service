/**
 * Auto-extracted regression: parses every statement inside plurnk.md's
 * `## Examples` code block. plurnk.md is the model-facing protocol reference;
 * any drift between what we tell the model and what the parser accepts breaks
 * here, loudly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlurnkParser } from "../../src/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plurnkMd = readFileSync(join(repoRoot, "plurnk.md"), "utf8");

const exampleBlock = (() => {
    const headingMatch = /^## Examples\s*$/m.exec(plurnkMd);
    assert.ok(headingMatch, "plurnk.md is missing its `## Examples` section");
    const startIdx = (headingMatch.index ?? 0) + headingMatch[0].length;
    const rest = plurnkMd.substring(startIdx);
    const nextHeadingMatch = /^## /m.exec(rest);
    const endIdx = nextHeadingMatch ? nextHeadingMatch.index : rest.length;
    return rest.substring(0, endIdx).trim();
})();

test("plurnk.md examples block parses with no errors and no unparsed tail", () => {
    const result = PlurnkParser.parse(exampleBlock);
    const errors = result.items.filter((i) => i.kind === "error");
    assert.equal(
        errors.length,
        0,
        `expected 0 errors, got ${errors.length}: ` +
            errors.map((e) => (e.kind === "error" ? e.error.message : "")).join(" | "),
    );
    assert.equal(result.unparsedTail, undefined, "expected no unparsedTail");
});

test("plurnk.md examples block contains the expected statement count", () => {
    const result = PlurnkParser.parse(exampleBlock);
    const statements = result.items.filter((i) => i.kind === "statement");
    // Snapshot of current example count. Update when plurnk.md gains/loses examples.
    assert.equal(statements.length, 27, `expected 27 statements, got ${statements.length}`);
});

test("plurnk.md examples cover every OP", () => {
    const result = PlurnkParser.parse(exampleBlock);
    const ops = new Set(
        result.items
            .filter((i): i is Extract<typeof i, { kind: "statement" }> => i.kind === "statement")
            .map((i) => i.statement.op),
    );
    const required = ["FIND", "READ", "EDIT", "COPY", "MOVE", "SHOW", "HIDE", "SEND", "EXEC"];
    for (const op of required) {
        assert.ok(ops.has(op as any), `plurnk.md examples should include ${op}`);
    }
});

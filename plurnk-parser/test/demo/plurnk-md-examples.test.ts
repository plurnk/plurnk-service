/** Broad structural checks for the model-facing reference, never wording pins. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlurnkParser } from "../../src/index.ts";
import { PLURNK_OPS } from "@plurnk/plurnk-contracts";

const teaching = readFileSync(new URL("./plurnk.md", import.meta.resolve("@plurnk/plurnk-contracts/package.json")), "utf8");
// BARE is taught on the session reference page and FORK on the delegation page the card links from WORK,
// not on the card (#893, #1063).
const sessionReference = readFileSync(new URL(import.meta.resolve("@plurnk/plurnk-meta/docs/session.md")), "utf8");
const delegationReference = readFileSync(new URL(import.meta.resolve("@plurnk/plurnk-meta/docs/delegation.md")), "utf8");

test("concrete core-operation examples in plurnk.md parse verbatim as one clean operation", () => {
    const examples = [...teaching.matchAll(/^(await plurnk\.([a-z]+)\([^\n]*)$/gm)]
        .filter((match) => PLURNK_OPS.some((op) => op.toLowerCase() === match[2]));
    assert.ok(examples.length > 0, "the reference demonstrates concrete operations");
    for (const example of examples) {
        const source = example[1];
        const expectedOp = example[2].toUpperCase();
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.items.length, 1, source);
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement", source);
        if (item?.kind === "statement") assert.equal(item.statement.op, expectedOp, source);
        assert.equal(parsed.unparsedTail, undefined, source);
    }
});

test("every operation is taught on the card or on the session or delegation reference page, without pinning prose", () => {
    const combined = `${teaching}\n${sessionReference}\n${delegationReference}`;
    for (const op of PLURNK_OPS) {
        const lower = op.toLowerCase();
        assert.match(
            combined,
            new RegExp(`^(?:await plurnk\\.${lower}\\(|[*-] \`plurnk\\.${lower}\\()`, "m"),
            `operation reference is missing ${op}`,
        );
    }
});

/** Broad structural checks for the model-facing reference, never wording pins. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlurnkParser, PLURNK_OPS } from "../../src/index.ts";

const teaching = readFileSync(new URL("../../plurnk.md", import.meta.url), "utf8");
const policy = readFileSync(new URL("../../../plurnk-meta/POLICY.md", import.meta.url), "utf8");

test("concrete compact examples in plurnk.md parse as one clean operation", () => {
    const examples = [...teaching.matchAll(/^[*|].*?((`{3,})[A-Z]+[^`\n]*\2)/gm)].map((match) => match[1]!);
    assert.ok(examples.length > 0, "the reference demonstrates compact operations");
    for (const source of examples) {
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.items.length, 1, source);
        assert.equal(parsed.items[0]?.kind, "statement", source);
        assert.equal(parsed.unparsedTail, undefined, source);
    }
});

test("the complete policy workflow example parses as an executable turn", () => {
    const workflow = [...policy.matchAll(/^(`{3,})example\n([\s\S]*?)\n\1$/gm)]
        .map((match) => match[2]!.trim()).find((source) => /^`{3,}EDIT /.test(source));
    assert.ok(workflow, "the default policy includes a workflow");
    const parsed = PlurnkParser.parse(workflow);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    assert.equal(parsed.unparsedTail, undefined);
    const statements = parsed.items.filter((item) => item.kind === "statement");
    assert.equal(statements[0]?.statement.op, "EDIT");
    assert.equal(statements.at(-1)?.statement.op, "TASK");
    assert.ok(statements.some(({ statement }) => statement.op === "EXEC"), "the turn composes native OPs and named executors");
});

test("plurnk.md retains broad operation coverage without pinning prose", () => {
    for (const op of PLURNK_OPS) {
        if (op === "EXEC") continue;
        assert.match(teaching, new RegExp("^`{3,}" + op + "(?: |$)", "m"), `operation signature is missing ${op}`);
    }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ClientStatement, ParseResult } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warnings = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const errors = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []);
const RECEIPT = (tag: string) => `\`${tag}\` took a bare option object; the taught form is \`[{…}]\`.`;
const MATCHER_ADVISORY = "`{…}` was read as the matcher; an option block is `[{…}]`.";

test("{§bare-option-object}: SEND reads one JSON object after the target as its option block, the body beneath intact", () => {
    const result = PlurnkParser.parse("````SEND (node:///40968898) {\"eof\": true}\noranges\n````\n");
    const [send] = statements(result);
    assert.equal(send?.op, "SEND");
    if (send?.op !== "SEND") return;
    assert.deepEqual(send.metadata, ["{\"eof\": true}"], "the block is the array form's inner text");
    assert.equal(send.body?.raw, "oranges", "the body is what stood beneath the heading");
    assert.deepEqual(warnings(result), [RECEIPT("SEND")], "one receipt, and no inline-body advisory");
    assert.deepEqual(errors(result), []);
    assert.equal(PlurnkParser.heading(send), "SEND (node:///40968898) [{\"eof\": true}]", "consumers see the taught shape");
});

test("{§bare-option-object}: an executor fence, BARE and WORK lift the same way", () => {
    const sh = PlurnkParser.parse("````sh {\"stdin\": \"open\"}\ncat\n````\n", { executors: ["sh"] });
    const [run] = statements(sh);
    assert.ok(run !== undefined && "runtime" in run && run.runtime === "sh", "the executor fence parsed");
    if (!(run !== undefined && "runtime" in run)) return;
    assert.deepEqual(run.metadata, ["{\"stdin\": \"open\"}"]);
    assert.equal(run.body, "cat");
    assert.deepEqual(warnings(sh), [RECEIPT("sh")]);
    const bare = PlurnkParser.parse("````BARE (worker:///question.md) {\"model\": \"dumbox\"}\nAnswer briefly.\n````\n");
    const [ask] = statements(bare);
    assert.equal(ask?.op, "BARE");
    if (ask?.op !== "BARE") return;
    assert.deepEqual([ask.metadata, ask.body], [["{\"model\": \"dumbox\"}"], "Answer briefly."]);
    assert.deepEqual(warnings(bare), [RECEIPT("BARE")]);
    const work = PlurnkParser.parse("````WORK (worker://child) {\"model\": \"dumbox\"}\nDo the thing.\n````\n");
    const [spawn] = statements(work);
    assert.equal(spawn?.op, "WORK");
    if (spawn?.op !== "WORK") return;
    assert.deepEqual([spawn.metadata, spawn.body], [["{\"model\": \"dumbox\"}"], "Do the thing."]);
    assert.deepEqual(warnings(work), [RECEIPT("WORK")]);
});

test("{§bare-option-object}: a heading that already carries a block keeps the object as inline body, and braces that are not JSON stay body", () => {
    const carried = PlurnkParser.parse("````SEND (worker://peer) [{\"a\": 1}] {\"b\": 2}\nbody\n````\n");
    const [send] = statements(carried);
    assert.equal(send?.op, "SEND");
    if (send?.op !== "SEND") return;
    assert.deepEqual(send.metadata, ["{\"a\": 1}"], "the carried block stands alone");
    assert.equal(send.body?.raw, "{\"b\": 2}\nbody", "the second object is body, as it always was");
    assert.match(warnings(carried).join("\n"), /body text was on the OP line/, "the inline-body advisory, not the receipt");
    const notJson = PlurnkParser.parse("````SEND (worker://peer) {nope\nbody\n````\n");
    const [plain] = statements(notJson);
    assert.equal(plain?.op === "SEND" ? plain.body?.raw : null, "{nope\nbody");
    assert.match(warnings(notJson).join("\n"), /body text was on the OP line/);
});

test("{§bare-option-object}: on FIND and READ the object is the matcher, and the advisory names the option form", () => {
    for (const heading of ["FIND (src/**) {\"debug\": true}", "READ (notes.md) {\"debug\": true}"]) {
        const result = PlurnkParser.parse(`\`\`\`\`${heading}\n\`\`\`\`\n`);
        const [statement] = statements(result);
        assert.ok(statement !== undefined && "matcher" in statement, heading);
        if (!(statement !== undefined && "matcher" in statement)) return;
        assert.equal(statement.matcher?.raw, "{\"debug\": true}", heading);
        assert.equal(statement.metadata, null, heading);
        assert.deepEqual(warnings(result), [MATCHER_ADVISORY], heading);
    }
});

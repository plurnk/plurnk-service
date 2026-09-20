import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";
import { type ClientStatement, type ParseResult } from "@plurnk/plurnk-contracts";
import { writtenOp } from "@plurnk/plurnk-contracts";

const task = PlurnkParser.frame("WAIT", "Reported the result.");
const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);

// The shape of the dogfood emission of 2026-09-20 (#784): an essay about reasoning streams whose
// table mentions a reasoning tag in prose, then a diagram, then a fenced worked example holding a
// tagged trace and an EDIT. The EDIT ran against a file the answer only imagined.
const essay = (mention: string) => [
    "Every harness reads the same content stream.",
    "",
    "| Surface | Today | Plurnk |",
    "|---|---|---|",
    `| **Reasoning Stream** | Redacted or summarized | **Raw plaintext tokens (${mention})** |`,
    "",
    "The flow is:",
    "",
    "```mermaid",
    "graph TD",
    "  A[User Message] --> B[Model Thinks]",
    "```",
    "",
    "With Plurnk the operator sees the whole trace:",
    "",
    "```plurnk",
    "<think>",
    "Let's check the migration logic in src/db/v2.ts.",
    "````NOTE",
    "Hypothesis 1: the table locks are not acquired in order.",
    "````",
    "Now I'll construct the EDIT operation...",
    "</think>",
    "````EDIT (src/config.ts) <@c8e11>",
    "  poolIdleTimeout: 10000,",
    "````",
    "```",
    "",
    "That is the whole loop.",
    "",
    task,
].join("\n");

test("{§quotation}: a reasoning tag written in prose does not unquote the fences after it", () => {
    // The only difference between these two essays is one phrase of prose, 20 lines above the
    // example. Prose is data: it may not change how the program after it is read.
    for (const [mention, source] of [
        ["a tag in inline code", essay("open `<think>` blocks")],
        ["the same sentence without one", essay("open reasoning blocks")],
    ] as const) {
        const result = PlurnkParser.parse(source);
        assert.deepEqual(errors(result), [], mention);
        assert.deepEqual(statements(result).map(writtenOp), ["WAIT"], mention);

        const lines = source.split("\n");
        const live = PlurnkParser.unquoted(source).split("\n");
        for (const quoted of ["```mermaid", "```plurnk", "````EDIT (src/config.ts) <@c8e11>"]) {
            assert.equal(live[lines.indexOf(quoted)].trim(), "", `${mention}: ${quoted} must be data`);
        }
    }
});

test("{§provider-tagged-reasoning}: the grammar peels no reasoning envelope, so a tag hides nothing after it", () => {
    // A route that delivers reasoning inline declares it and the provider peels one leading
    // envelope. The grammar reads tags as text, so what follows one is read exactly as written.
    const source = `<think>\n${PlurnkParser.frame("NOTE", "Considering the timeout.")}\n</think>\n${task}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(writtenOp), ["NOTE", "WAIT"]);
    assert.equal(PlurnkParser.unquoted(source), source);
});

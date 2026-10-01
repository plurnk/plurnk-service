import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";

const frame = PlurnkParser.frame;
const parse = (source: string) => PlurnkParser.parseReasoningOperations(source);

test("{§reasoning-operations}: complete NOTE, FIND and READ retain source order and repeated occurrences", () => {
    const source = [
        "I need the actual contents before editing.",
        frame("NOTE", "Check the exported interface."),
        frame("FIND (worker:///*) /interface/", null),
        frame("READ (worker:///api.ts) <1,16>", null),
        frame("READ (worker:///api.ts) <1,16>", null),
    ].join("\n\n");
    assert.deepEqual(parse(source).map(({ op }) => op), ["NOTE", "FIND", "READ", "READ"]);
});


test("{§reasoning-operations}: quotations and other operations do not execute fact-finding examples", () => {
    const example = frame("READ (worker:///quoted.txt)", null);
    for (const fence of ["```", "`````", "`````text", "~~~markdown", "````EDIT (file.txt)", "````sh", "````WAIT"]) {
        const closer = fence.match(/^[`~]+/u)![0];
        assert.deepEqual(parse(`${fence}\n${example}\n${closer}`), [], fence);
    }
    for (const source of [
        `Example: ${example}`,
        example.split("\n").map((line) => `> ${line}`).join("\n"),
        example.split("\n").map((line) => `    ${line}`).join("\n"),
        "READ (worker:///naked.txt)",
        "<tool_call><function=READ><parameter=path>file.txt</parameter></function></tool_call>",
    ]) assert.deepEqual(parse(source), [], source);
});

test("{§reasoning-operations}: fact-finding quoted inside a NOTE remains note content", () => {
    const example = frame("READ (worker:///quoted.txt)", null);
    const source = frame("NOTE", example);
    const operations = parse(source);
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.op, "NOTE");
    assert.equal(operations[0]!.body, example);
});

test("{§reasoning-operations}: only authored, closed operations survive an unfinished suffix", () => {
    for (const suffix of ["````READ (unfinished", "````READ (file.txt)\n", "````NOTE\nUnfinished", "````FIND (*)\n"]) {
        assert.deepEqual(parse(suffix), [], suffix);
        const source = `${frame("READ (worker:///complete.txt)", null)}\n\n${suffix}`;
        assert.deepEqual(parse(source).map(({ op }) => op), ["READ"], suffix);
    }
    assert.deepEqual(parse("````READ (missing close\n````"), []);
});

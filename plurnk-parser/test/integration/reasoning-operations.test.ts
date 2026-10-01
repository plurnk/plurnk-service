import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, ReasoningStream } from "../../src/index.ts";

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

test("{§parser-reasoning-frontier}: batch boundaries are independent of transport chunking", () => {
    const before = `I need facts. 🧪\n${frame("NOTE", "Use observed evidence.")}\n\n`;
    const batch = `${frame("FIND (worker:///*)", null)}\n\n${frame("READ (worker:///fact.txt)", null)}\n`;
    const after = `\nNow I could speculate.\n${frame("READ (worker:///too-late.txt)", null)}\n`;
    const source = before + batch + after;
    for (const width of [1, 2, 3, 7, 23, source.length]) {
        const stream = new ReasoningStream();
        let end: number | undefined;
        for (let size = width; size < source.length && end === undefined; size += width) {
            end = stream.inspect(source.slice(0, size));
        }
        end ??= stream.inspect(source);
        assert.equal(end, before.length + batch.length, `chunk width ${width}`);
        assert.deepEqual(parse(source.slice(0, end)).map(({ op }) => op), ["NOTE", "FIND", "READ"]);
    }
});

test("{§reasoning-yield}: incomplete successors await syntax; NOTE terminates a fact-finding batch", () => {
    const first = `${frame("READ (worker:///first.txt)", null)}\n`;
    const stream = new ReasoningStream();
    assert.equal(stream.inspect(first), undefined);
    assert.equal(stream.inspect(`${first}\n\`\`\`\`REA`), undefined);
    assert.equal(stream.inspect(`${first}\n\`\`\`\`READ (worker:///second.txt)\n`), undefined);
    const complete = `${first}\n${frame("READ (worker:///second.txt)", null)}\n`;
    assert.equal(stream.inspect(complete), undefined);
    assert.equal(stream.inspect(`${complete}\n\`\`\`\`NOTE\nPending thought`), complete.length);
    assert.equal(new ReasoningStream().inspect(first.trimEnd(), true), first.trimEnd().length);
});

test("{§reasoning-yield}: quotations, incomplete operations and NOTE-only reasoning never yield", () => {
    for (const source of [
        frame("NOTE", "Retain memory without yielding."),
        frame("sh", frame("READ (worker:///quoted.txt)", null)),
        "````READ (unfinished",
        "````READ (worker:///no-closer)\n",
        `\`\`\`\`\`text\n${frame("READ (worker:///quoted.txt)", null)}`,
    ]) {
        assert.equal(new ReasoningStream().inspect(source, true), undefined, source);
    }
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
    assert.equal(new ReasoningStream().inspect(source, true), undefined);
});

test("{§reasoning-operations}: only authored, closed operations survive an unfinished suffix", () => {
    for (const suffix of ["````READ (unfinished", "````READ (file.txt)\n", "````NOTE\nUnfinished", "````FIND (*)\n"]) {
        assert.deepEqual(parse(suffix), [], suffix);
        const source = `${frame("READ (worker:///complete.txt)", null)}\n\n${suffix}`;
        assert.deepEqual(parse(source).map(({ op }) => op), ["READ"], suffix);
    }
    assert.deepEqual(parse("````READ (missing close\n````"), []);
});

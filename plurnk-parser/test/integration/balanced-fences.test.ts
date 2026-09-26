import assert from "node:assert/strict";
import test from "node:test";
import { writtenOp, type ClientStatement, type ParseResult } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyText = (statement: ClientStatement) => "body" in statement ? typeof statement.body === "string" ? statement.body : statement.body?.raw : undefined;
const clean = (result: ParseResult<ClientStatement>) => {
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
};

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["stored", PlurnkParser.parseStatements],
    ["client", PlurnkParser.parseClient],
] as const) {
    test(`{§balanced-fences}: ${name} preserves the dogfood nested syntax example and the rest of the answer`, () => {
        const body = [
            "# Architecture 🙂",
            "```mermaid", "graph TD", "A --> B", "```",
            "The operation syntax:",
            "```text", "````OP (path)? <scope|range>? [metadata]? pattern? <!-- aside -->?", "body?", "````", "```",
            "The rest of the answer must reach the recipient.",
            "```mermaid", "graph LR", "B --> C", "```",
            "## Summary", "Complete answer.",
        ].join("\n");
        const result = parse(`\`\`\`\`SEND\n${body}\n\`\`\`\``);
        clean(result);
        assert.deepEqual(statements(result).map(writtenOp), ["SEND"]);
        assert.equal(bodyText(statements(result)[0]), body);
    });

    test(`{§balanced-fences}: ${name} keeps executable examples literal and real siblings executable`, () => {
        const body = "Example:\n````sh\necho must-not-execute\n````\n````READ (example.md)````\nExplanation continues.";
        const result = parse(`\`\`\`\`SEND\n${body}\n\`\`\`\`\n\n\`\`\`\`READ (actual.md)\n\`\`\`\``);
        clean(result);
        const ops = statements(result);
        assert.deepEqual(ops.map(writtenOp), ["SEND", "READ"]);
        assert.equal(bodyText(ops[0]), body);
        assert.ok(ops[1].op === "READ");
        assert.equal(ops[1].target?.raw, "actual.md");
    });
}

test("{§balanced-fences}: exact bodies survive nested widths, indentation, Unicode, newlines and operation families", () => {
    for (const header of ["SEND", "EDIT (notes.md)", "sh", "NOTE", "BARE", "WORK", "FORK"]) {
        for (const width of [4, 5, 7]) {
            for (const newline of ["\n", "\r\n"]) {
                for (const indent of ["", "   "]) {
                    const fence = "`".repeat(width);
                    const body = ["🦝 漢字", `${indent}${fence}text`, `${indent}${fence}sh`, "echo example", `${indent}${fence}`, `${indent}${fence}`, "trailing body", ""].join(newline);
                    const result = PlurnkParser.parse(`${fence}${header}${newline}${body}${newline}${indent}${fence}${newline}\n\`\`\`\`READ (after.md)\n\`\`\`\``);
                    clean(result);
                    const ops = statements(result);
                    assert.deepEqual(ops.map(writtenOp), [header.split(" ")[0], "READ"], `${header}, ${width}`);
                    assert.equal(bodyText(ops[0]), body);
                }
            }
        }
    }
});

test("{§balanced-fences}: a wider enclosing fence keeps unfinished examples literal", () => {
    const body = "```text\n```sh\nunfinished literal\nAfter the example.";
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND", body) + "\n\n```READ (after.md)\n```");
    clean(result);
    assert.deepEqual(statements(result).map(writtenOp), ["SEND", "READ"]);
    assert.equal(bodyText(statements(result)[0]), body);
});

test("{§balanced-fences}: a genuinely missing enclosing closer still recovers the subsequent operations", () => {
    const result = PlurnkParser.parse("````EDIT (notes.md)\nThe edit.\n````sh\necho actual-command\n````\n````NOTE\nRemember this.\n````");
    clean(result);
    const ops = statements(result);
    assert.deepEqual(ops.map(writtenOp), ["EDIT", "sh", "NOTE"]);
    assert.equal(bodyText(ops[0]), "The edit.");
    assert.equal(bodyText(ops[1]), "echo actual-command");
});

test("{§balanced-fences}: reasoning quotations cannot promote nested NOTE examples", () => {
    const source = "````text\nA quoted example:\n````NOTE\nNot a memory.\n````\nExplanation.\n````\n````NOTE\nActual memory.\n````";
    assert.deepEqual(PlurnkParser.parseReasoningNotes(source).map(({ body }) => body), ["Actual memory."]);
});

test("{§balanced-fences}: equal totals with incompatible widths or labels do not establish nesting", () => {
    for (const closer of ["```", "````9"]) {
        const result = PlurnkParser.parse(`\`\`\`\`SEND\nPrefix.\n\`\`\`\`sh\necho actual-command\n${closer}\n\`\`\`\``);
        clean(result);
        assert.deepEqual(statements(result).map(writtenOp), ["SEND", "sh"]);
    }
});

test("{§balanced-fences}: compact examples use ordinary heading boundaries, not backticks inside slots", () => {
    for (const example of [
        "````READ (a.md)```` <1,2> <!-- scoped -->",
        "````sh [{\"stdin\": \"````\"}]\necho literal\n````",
        "````READ (a````.md)\n````",
        "````NOTE <!-- delimiter: ```` -->\nLiteral note.\n````",
        "````READ (a.md)```` ````READ (b.md)````",
    ]) {
        const body = `Example:\n${example}\nStill the answer.`;
        const result = PlurnkParser.parse(`\`\`\`\`SEND\n${body}\n\`\`\`\``);
        clean(result);
        assert.deepEqual(statements(result).map(writtenOp), ["SEND"], example);
        assert.equal(bodyText(statements(result)[0]), body);
    }
});

test("{§balanced-fences}: inline chains can close a nested example or continue after the enclosing reply", () => {
    for (const body of [
        "Example:\n````sh\necho literal\n```` ````READ (example.md)````\nStill the answer.",
        "Example:\n````READ (example.md)```` ````sh\necho literal\n````\nStill the answer.",
    ]) {
        const result = PlurnkParser.parse(`\`\`\`\`SEND\n${body}\n\`\`\`\` \`\`\`\`READ (actual.md)\n\`\`\`\``);
        clean(result);
        const ops = statements(result);
        assert.deepEqual(ops.map(writtenOp), ["SEND", "READ"]);
        assert.equal(bodyText(ops[0]), body);
        assert.ok(ops[1].op === "READ");
        assert.equal(ops[1].target?.raw, "actual.md");
    }
});

test("{§pairing-algorithm}: two stray fences after closed operations are an empty quotation, not a reason to hide an operation", () => {
    const emission = [
        "````BARE", "Quote the exact hint string.", "````",
        "",
        "````WORK (worker://fresh)", "Answer from memory.", "````",
        "````",
        "````",
    ].join("\n");
    const result = PlurnkParser.parse(emission);
    assert.deepEqual(statements(result).map(writtenOp), ["BARE", "WORK"]);
    assert.deepEqual(statements(result).map(bodyText), ["Quote the exact hint string.", "Answer from memory."]);
});

test("{§pairing-objective}: once every reading needs a repair, operations written without closers all run", () => {
    const emission = [
        "```NOTE", "Fix the import, then verify.",
        "```EDIT (a.py) <1>", "from b import c",
        "```sh", "python -m pytest -q",
        "```WAIT",
        "```KILL", "Fixed.", "", "```python", "from b import c", "```", "",
        "Verified.",
        "```",
    ].join("\n");
    const result = PlurnkParser.parse(emission, { executors: ["sh"] });
    assert.deepEqual(statements(result).map(writtenOp), ["NOTE", "EDIT", "sh", "WAIT", "KILL"]);
    assert.equal(bodyText(statements(result).at(-1)!), "Fixed.\n\n```python\nfrom b import c\n```\n\nVerified.");
});

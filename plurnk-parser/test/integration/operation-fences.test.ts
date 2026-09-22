import assert from "node:assert/strict";
import test from "node:test";
import { PLURNK_FENCE, writtenOp, type ClientStatement, type ParseResult } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

const block = (width: number, header: string, body = "") => `${"`".repeat(width)}${header}\n${body}\n${"`".repeat(width)}`;
const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyText = (statement: ClientStatement) => "body" in statement ? typeof statement.body === "string" ? statement.body : statement.body?.raw : undefined;
const clean = (result: ParseResult<ClientStatement>) => {
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
};

for (const [tier, parse] of [
    ["model", PlurnkParser.parse],
    ["stored", PlurnkParser.parseStatements],
    ["client", PlurnkParser.parseClient],
] as const) {
    for (const width of [3, 4, 6]) {
        test(`{§operation-fences}: ${tier} accepts ${width}-backtick native and registered executor operations; three is told the taught width`, () => {
            const source = [
                block(width, "READ (notes.md) <1,2> <!-- inspect -->"),
                block(width, "NOTE", "Keep this determination."),
                block(width, "SH", "echo 42"),
                block(width, "gitea (list_issues)", '{"repo_id":42}'),
            ].join("\n\n");
            const result = parse(source, { executors: ["sh", "gitea"] });
            assert.equal(result.unparsedTail, undefined);
            const receipts = result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []);
            assert.deepEqual(receipts, width === 3
                ? ["READ", "NOTE", "SH", "gitea"].map((op) => `\`${op}\` ran with three backticks; the taught fence is four.`)
                : [], "a three-backtick operation ran and was told the taught width once each, in the model's own spelling; four and wider draw nothing");
            const ops = statements(result);
            assert.deepEqual(ops.map(writtenOp), ["READ", "NOTE", "sh", "gitea"]);
            assert.ok(ops[0].op === "READ");
            assert.equal(ops[0].aside, "inspect");
            assert.deepEqual(ops[0].lineMarker?.marks, [1, 2]);
            assert.equal(bodyText(ops[1]), "Keep this determination.");
            assert.equal(bodyText(ops[2]), "echo 42");
            assert.equal(bodyText(ops[3]), '{"repo_id":42}');
            assert.ok(PlurnkParser.stringify(ops).startsWith(PLURNK_FENCE));
        });
    }

    test(`{§quotation}: ${tier} keeps indented and enclosed three-backtick operations inert`, () => {
        const example = block(3, "KILL (notes.md)");
        const examples = [
            example.split("\n").map((line) => ` ${line}`).join("\n"),
            example.split("\n").map((line) => `\t${line}`).join("\n"),
            block(3, "text", example),
            block(3, "", example),
            `~~~markdown\n${example}\n~~~`,
        ];
        const result = parse([...examples, block(4, "NOTE", "Actual note.")].join("\n\n"));
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []),
            ["`KILL` inside a code block was shown, not run."],
            "the unlabeled wrapper is told once; offset, labeled and tilde examples draw nothing");
        assert.deepEqual(statements(result).map(writtenOp), ["NOTE"]);
        assert.equal(bodyText(statements(result)[0]), "Actual note.");
    });
}

test("{§balanced-fences}: complete nested three-backtick operations stay literal bodies", () => {
    for (const width of [3, 4]) {
        const body = ["Example:", block(3, "sh", "echo example"), block(3, "KILL (notes.md)"), "Still the answer."].join("\n");
        const result = PlurnkParser.parse(block(width, "KILL", body));
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(statements(result).map(writtenOp), ["KILL"]);
        assert.equal(bodyText(statements(result)[0]), body);
    }
});

test("{§fence-heading-in-body}: a three-backtick known heading cannot escape an unfinished wider body", () => {
    for (const [outer, inner] of [[4, 3], [5, 3]]) {
        const body = `${"`".repeat(inner)}sh\necho must-not-execute`;
        const result = PlurnkParser.parse(`${"`".repeat(outer)}EDIT (notes.md)\n${body}`);
        clean(result);
        assert.deepEqual(statements(result).map(writtenOp), ["EDIT"]);
        assert.equal(bodyText(statements(result)[0]), body);
    }
});

test("{§fence-heading-in-body}: equal-width missing-closer recovery and numeric delimiters work at three backticks", () => {
    const recovered = PlurnkParser.parse("```EDIT (notes.md)\nFirst body.\n```sh\necho actual-command\n```");
    assert.equal(recovered.unparsedTail, undefined);
    assert.deepEqual(statements(recovered).map(writtenOp), ["EDIT", "sh"]);
    assert.equal(bodyText(statements(recovered)[0]), "First body.");
    const body = "```sh\nunfinished example";
    const delimited = PlurnkParser.parse(block(3, "42EDIT (notes.md)", body).replace(/```$/u, "```42"));
    assert.equal(delimited.unparsedTail, undefined);
    assert.deepEqual(statements(delimited).map(writtenOp), ["EDIT"]);
    assert.equal(bodyText(statements(delimited)[0]), body);
});

test("{§inline-chain}: compact and inline-chained operations accept either fence width", () => {
    for (const [first, second] of [[3, 3], [3, 4], [4, 3]]) {
        const a = "`".repeat(first);
        const b = "`".repeat(second);
        const result = PlurnkParser.parse(`${a}READ (a.md)${a} ${b}READ (b.md)${b}`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(statements(result).map(writtenOp), ["READ", "READ"]);
        assert.deepEqual(statements(result).map((op) => op.op === "READ" ? op.target?.raw : null), ["a.md", "b.md"]);
    }
});

test("{§reasoning-notes}: reasoning accepts three-backtick NOTE only, preserving enclosing quotations", () => {
    const quoted = block(3, "NOTE", "An example, not retained memory.");
    const reasoning = [
        block(3, "NOTE", "Actual memory."),
        block(3, "sh", "echo never-executed"),
        block(3, "SEND", quoted),
        block(3, "text", quoted),
        quoted.split("\n").map((line) => ` ${line}`).join("\n"),
    ].join("\n\n");
    assert.deepEqual(PlurnkParser.parseReasoningNotes(reasoning).map(({ body }) => body), ["Actual memory."]);
});

test("{§operation-fences}: canonical output stays four-backtick with shorter body fences intact", () => {
    assert.equal(PLURNK_FENCE, "````");
    const body = block(3, "sh", "echo example");
    assert.equal(PlurnkParser.frame("KILL", body), block(4, "KILL", body));
    const result = PlurnkParser.parse(PlurnkParser.frame("KILL", body));
    clean(result);
    assert.equal(bodyText(statements(result)[0]), body);
});

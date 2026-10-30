import test, { describe } from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "../../src/PlurnkParser.ts";
import FencePairing from "../../src/FencePairing.ts";
import { TurnDisposition, type DispositionStatement, isExecution, writtenOp, type PlurnkStatement, type ParseResult, PLURNK_FENCE } from "@plurnk/plurnk-contracts";
import { cells } from "./fence-matrix.ts";
import { readFileSync } from "node:fs";

describe("fenced-language", () => {
const ops = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ReturnType<typeof PlurnkParser.parse>) =>
    result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const frame = PlurnkParser.frame;
const task = (content: string, op: DispositionStatement["op"] = "WAIT") => frame(op, content);

for (const entrypoint of ["parse", "parseStatements"] as const) {
    test(`{§fence-pairing}: ${entrypoint} canonicalizes ts, javascript, typescript, and node to js without shadowing a registered executor`, () => {
        for (const alias of ["ts", "javascript", "typescript", "node"]) {
            for (const { executors, tag, runtime } of [
                { executors: ["js"], tag: alias, runtime: "js" },
                { executors: ["JS"], tag: alias.toUpperCase(), runtime: "JS" },
                { executors: ["js", alias], tag: alias, runtime: alias },
                { executors: [alias, "js"], tag: alias, runtime: alias },
                { executors: [alias], tag: alias.toUpperCase(), runtime: alias },
                { executors: [], tag: alias, runtime: null },
            ]) {
                const body = "console.log(42);";
                const source = frame(tag, body) + "\n" + task("Inspect the result.");
                const parsed = PlurnkParser[entrypoint](source, { executors });
                const diagnostics = parsed.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
                assert.deepEqual(diagnostics.map((error) => ({ severity: error.severity, message: error.message })), [], "an unknown tag is a code block, silently");
                assert.equal(parsed.unparsedTail, undefined);
                const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
                assert.deepEqual(statements.map(writtenOp), runtime === null ? ["WAIT"] : [runtime, "WAIT"]);
                if (runtime === null) continue;
                const execution = statements[0];
                assert.ok(isExecution(execution));
                assert.equal(execution.body, body);
                assert.equal(PlurnkParser.stringify([execution]), frame(runtime, body), "serialization uses the canonical executor");
            }
        }
    });
}

test("{§fence-pairing}: a nested alias example remains a literal message body", () => {
    for (const alias of ["ts", "javascript", "typescript", "node"]) {
        const body = frame(alias, "console.log(42);");
        const parsed = PlurnkParser.parse(frame("SEND", body) + "\n" + task("Explained."), { executors: ["js"] });
        assert.deepEqual(errors(parsed), []);
        assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT"]);
        const send = ops(parsed)[0];
        assert.equal(send.op === "SEND" ? send.body?.raw : null, body);
    }
});

// {§operation-fences}
test("{§operation-fences} independent fenced operations retain exact bodies and typed fields", () => {
    const input = [
        frame("EDIT (workspace:///note.md) <1,-1>", "alpha\nbeta"),
        frame("READ (workspace:///note.md)", null),
        task("Waiting for the read result."),
    ].join("\n");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    assert.equal(parsed.unparsedTail, undefined);
    const statements = ops(parsed);
    assert.deepEqual(statements.map(writtenOp), ["EDIT", "READ", "WAIT"]);
    assert.equal(statements[0].op === "EDIT" ? statements[0].body : null, "alpha\nbeta");
    assert.equal(statements[1].op === "READ" ? statements[1].body : "wrong op", null);
    assert.equal(statements[2].op === "WAIT" ? statements[2].body : null, "Waiting for the read result.");
});

// {§operation-fences}
test("{§operation-fences} framing removes its own newline, not body whitespace or interstatement padding", () => {
    const input = frame("EDIT (notes.md)", "alpha\n") + "\n\n" + task("done");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(errors(parsed), []);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, "alpha\n");
});

// {§operation-fences}
test("{§operation-fences} a quoted turn remains one exact literal body", () => {
    const body = [frame("SEND", "Paris."), task("Answered.")].join("\n");
    const parsed = PlurnkParser.parse([frame("EDIT (quoted.md)", body), task("Stored it.")].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.equal(ops(parsed).length, 2);
    const edit = ops(parsed)[0];
    assert.equal(edit.op === "EDIT" ? edit.body : null, body);
});

test("{§whitespace-contract}: exact closing fences bound bodies before ignored outside text", () => {
    for (const newline of ["\n", "\r\n"]) {
        for (const { source, names, bodies } of [
            { source: "````READ (note.md)````\nOutside.", names: ["READ"], bodies: [null] },
            { source: "````READ (first.md)````\n`````sh\necho 42\n`````\n\nOutside.", names: ["READ", "sh"], bodies: [null, "echo 42"] },
            { source: "```````READ (note.md)\n```````\nOutside.", names: ["READ"], bodies: [null] },
        ]) {
            const parsed = PlurnkParser.parse((source + "\n" + task("Done.")).replaceAll("\n", newline));
            assert.equal(parsed.unparsedTail, undefined);
            assert.deepEqual(errors(parsed), []);
            assert.deepEqual(ops(parsed).map(writtenOp), [...names, "WAIT"]);
            assert.deepEqual(ops(parsed).slice(0, -1).map((op) => isExecution(op) ? op.body : op.op === "SEND" ? op.body?.raw : null), bodies.map((body) => body?.replaceAll("\n", newline) ?? null));
        }
    }
});

test("{§operation-fences}: complete same-width examples remain body", () => {
    for (const newline of ["\n", "\r\n"]) {
        const bare = PlurnkParser.parse("````SEND\nCode:\n```ts\nconst value = 42;\n```\nVerified.\n````\n".replaceAll("\n", newline) + task("Done."));
        assert.equal(bare.unparsedTail, undefined);
        assert.deepEqual(errors(bare), []);
        assert.deepEqual(ops(bare).map(writtenOp), ["SEND", "WAIT"]);
        const bareSend = ops(bare)[0];
        assert.equal(bareSend.op === "SEND" ? bareSend.body?.raw : null, "Code:\n```ts\nconst value = 42;\n```\nVerified.".replaceAll("\n", newline), "the complete nesting preserves the example and the following prose");
    }
});

test("{§whitespace-contract}: a text-only statement list is empty", () => {
    const parsed = PlurnkParser.parseStatements("Outside.");
    assert.deepEqual(parsed.items, []);
    assert.equal(parsed.unparsedTail, undefined);
});

// {§whitespace-contract}
test("{§op-shapes} parseStatements retains consecutive turns with independently chosen fence lengths", () => {
    const source = "````SEND\nOne.\n````\n````WAIT\n````\n\n`````SEND\nTwo.\n`````\n`````WAIT\n`````";
    const parsed = PlurnkParser.parseStatements(source);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT", "SEND", "WAIT"]);
    assert.deepEqual(ops(parsed).flatMap((op) => op.op === "SEND" ? [op.body?.raw] : []), ["One.", "Two."]);
});

// {§op-shapes}
test("{§operation-fences} operations after a disposition are admitted in authored order without a diagnostic", () => {
    for (const op of ["WAIT"] as const) {
        for (const precedingRead of [false, true]) {
            const input = [
                ...(precedingRead ? [frame("READ (early.md)", null)] : []),
                task("Answer.", op),
                frame("KILL (log:///3/3/1/READ)", null),
                frame("READ (notes.md)", null),
                frame("SEND (session://reviewer)", "Check this."),
            ].join("\n");
            const parsed = PlurnkParser.parse(input);
            assert.equal(parsed.unparsedTail, undefined);
            assert.deepEqual(errors(parsed), []);
            assert.deepEqual(ops(parsed).map(writtenOp), [...(precedingRead ? ["READ"] : []), op, "KILL", "READ", "SEND"]);
            const disposition = ops(parsed).find(TurnDisposition.is);
            assert.ok(disposition !== undefined);
            assert.equal(disposition.body, "Answer.");
        }
    }
});

// {§operation-fences} {§op-shapes}
test("{§whitespace-contract} literal examples inside a SEND stay literal while a KILL after WAIT is admitted", () => {
    const body = "Example:\n" + frame("KILL (notes.md)", null);
    const parsed = PlurnkParser.parse([frame("SEND", body), task("Explained."), frame("KILL (log:///1/2/3/READ)", null)].join("\n"));
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["SEND", "WAIT", "KILL"]);
    const send = ops(parsed)[0];
    assert.equal(send.op === "SEND" ? send.body?.raw : null, body);
});

// {§whitespace-contract}
test("{§whitespace-contract} statement lists retain source order without inventing turn boundaries", () => {
    const turn = [frame("KILL (log:///1/1/1/READ)", null), task("Continue.")].join("\n");
    const parsed = PlurnkParser.parseStatements(turn + "\n" + turn);
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(ops(parsed).map(writtenOp), ["KILL", "WAIT", "KILL", "WAIT"]);
    const unfinished = PlurnkParser.parseStatements(turn + "\n" + frame("READ (unfinished.md)", null));
    assert.deepEqual(errors(unfinished), []);
    assert.deepEqual(ops(unfinished).map(writtenOp), ["KILL", "WAIT", "READ"]);
});

test("{§whitespace-contract} prose without executable fences is not a program", () => {
    const parsed = PlurnkParser.parse("First consider the request.\nThen send the answer.");
    assert.equal(ops(parsed).length, 0);
    assert.ok(errors(parsed).length > 0);
});
});

describe("balanced-fences", () => {
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyText = (statement: PlurnkStatement) => "body" in statement ? typeof statement.body === "string" ? statement.body : statement.body?.raw : undefined;
const clean = (result: ParseResult) => {
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
};

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["stored", PlurnkParser.parseStatements],
] as const) {
    test(`{§operation-fences}: ${name} preserves the dogfood nested syntax example and the rest of the answer`, () => {
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

    test(`{§operation-fences}: ${name} keeps executable examples literal and real siblings executable`, () => {
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

test("{§operation-fences}: exact bodies survive nested widths, indentation, Unicode, newlines and operation families", () => {
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

test("{§operation-fences}: a wider enclosing fence keeps unfinished examples literal", () => {
    const body = "```text\n```sh\nunfinished literal\nAfter the example.";
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND", body) + "\n\n```READ (after.md)\n```");
    clean(result);
    assert.deepEqual(statements(result).map(writtenOp), ["SEND", "READ"]);
    assert.equal(bodyText(statements(result)[0]), body);
});

test("{§operation-fences}: a genuinely missing enclosing closer still recovers the subsequent operations", () => {
    const result = PlurnkParser.parse("````EDIT (notes.md)\nThe edit.\n````sh\necho actual-command\n````\n````NOTE\nRemember this.\n````");
    clean(result);
    const ops = statements(result);
    assert.deepEqual(ops.map(writtenOp), ["EDIT", "sh", "NOTE"]);
    assert.equal(bodyText(ops[0]), "The edit.");
    assert.equal(bodyText(ops[1]), "echo actual-command");
});

test("{§operation-fences}: reasoning quotations cannot promote nested NOTE examples", () => {
    const source = "````text\nA quoted example:\n````NOTE\nNot a memory.\n````\nExplanation.\n````\n````NOTE\nActual memory.\n````";
    assert.deepEqual(PlurnkParser.parseReasoningOperations(source).map(({ body }) => body), ["Actual memory."]);
});

test("{§operation-fences}: equal totals with incompatible widths or labels do not establish nesting", () => {
    for (const closer of ["```", "````9"]) {
        // {§fence-pairing} keeps an executor block inside a SEND; an EDIT body has no such rule.
        const result = PlurnkParser.parse(`\`\`\`\`EDIT (notes.md)\nPrefix.\n\`\`\`\`sh\necho actual-command\n${closer}\n\`\`\`\``);
        clean(result);
        assert.deepEqual(statements(result).map(writtenOp), ["EDIT", "sh"]);
    }
});

test("{§operation-fences}: compact examples use ordinary heading boundaries, not backticks inside slots", () => {
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

test("{§operation-fences}: inline chains can close a nested example or continue after the enclosing reply", () => {
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

test("{§fence-pairing}: two stray fences after closed operations are an empty quotation, not a reason to hide an operation", () => {
    const emission = [
        "````BARE", "Quote the exact hint string.", "````",
        "",
        "````WORK (session://fresh)", "Answer from memory.", "````",
        "````",
        "````",
    ].join("\n");
    const result = PlurnkParser.parse(emission);
    assert.deepEqual(statements(result).map(writtenOp), ["BARE", "WORK"]);
    assert.deepEqual(statements(result).map(bodyText), ["Quote the exact hint string.", "Answer from memory."]);
});

test("{§fence-pairing}: once every reading needs a repair, operations written without closers all run", () => {
    const emission = [
        "```NOTE", "Fix the import, then verify.",
        "```EDIT (a.py) <1>", "from b import c",
        "```sh", "python -m pytest -q",
        "```WAIT",
        "```SEND [200]", "Fixed.", "", "```python", "from b import c", "```", "",
        "Verified.",
        "```",
    ].join("\n");
    const result = PlurnkParser.parse(emission, { executors: ["sh"] });
    assert.deepEqual(statements(result).map(writtenOp), ["NOTE", "EDIT", "sh", "WAIT", "SEND"]);
    assert.equal(bodyText(statements(result).at(-1)!), "Fixed.\n\n```python\nfrom b import c\n```\n\nVerified.");
});
});

describe("closer-aside", () => {
const statements = (input: string) => PlurnkParser.parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

test("{§fence-pairing} the recorded corrupting EDIT deletes its line instead of writing the fence into the file", () => {
    const edits = statements("````EDIT (returns/converters.py) <9>\n```` <!-- remove duplicated Result import -->\n\n````READ (returns/converters.py)\n````");
    assert.deepEqual(edits.map((statement) => [statement.op, "body" in statement ? statement.body : undefined]), [["EDIT", null], ["READ", null]]);
});

test("{§fence-pairing} a bodied EDIT keeps exactly its body; a closer followed by prose is still body", () => {
    assert.equal((statements("````EDIT (a.md) <3>\nnew line\n```` <!-- why -->")[0] as { body: string | null }).body, "new line");
    assert.equal((statements("````EDIT (doc.md) <1,-1>\nbody\n```` then prose\n````")[0] as { body: string | null }).body, "body\n```` then prose");
});

test("{§fence-pairing} a closing fence with stray trailing text closes the operation as a repair and discards the trailing characters and retry closers (#1329)", () => {
    const executors = ["sh", "gitea", "plurnk_members"];
    for (const [openerFence, closer] of [
        ["```", "```!] Nail it."],
        ["```", "``` // end"],
        ["````", "```!] Nail it.\n````"],
        ["````", "````lier? No—clean close! :] Let's make sure the closing fence has NO trailing text! Wait—I just wrote `lier? No—clean close!` on the closing fence line in my draft! Let me fix that right now! :]\n````"],
        ["```", "```=] No! Why did I write `=]` after the closing fence?! Let me close with a clean fence on its own line!\n``` Perform clean close:\n```"],
    ] as const) {
        for (const [header, body, expectedOp] of [
            ["gitea (issue_read)", '{"owner":"plurnk","repo":"plurnk-service","issue_number":1}', "gitea"],
            ["plurnk_members (list)", "{}", "plurnk_members"],
            ["sh", "echo hello", "sh"],
            ["NOTE", "Thinking through the steps.", "NOTE"],
            ["EDIT (a.md) <1,1>", "replacement", "EDIT"],
            ["SEND [200]", "Final answer.", "SEND"],
        ] as const) {
            const source = `${openerFence}${header}\n${body}\n${closer}`;
            const pairing = FencePairing.pair(source, {
                executors: new Set(executors),
                reasoning: false,
                heading: (_h, name) => ({
                    selfClosed: false,
                    bodiless: false,
                    prose: name === "SEND",
                    mutation: name === "EDIT",
                }),
            });
            const end = pairing.ends.get(0);
            assert.equal(end?.kind, "closer", `${header} (${closer})`);
            assert.equal(end?.line, 2, `${header} (${closer})`);
            assert.deepEqual(pairing.repairs, [2], `${header} (${closer})`);

            const parsed = PlurnkParser.parse(source, { executors });
            assert.equal(parsed.unparsedTail, undefined, `${header} (${closer})`);
            assert.deepEqual(parsed.items.filter((item) => item.kind === "text"), [], `${header} (${closer}) discards closer trailing text`);
            assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), [], `${header} (${closer})`);
            const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(ops.map(writtenOp), [expectedOp], `${header} (${closer})`);
            const actualBody = ops[0].op === "SEND" ? ops[0].body?.raw : "body" in ops[0] ? ops[0].body : null;
            assert.equal(actualBody, body, `${header} (${closer})`);
        }
    }
});
});

describe("fence-matrix", () => {
const bodyOf = (body: unknown): string => typeof body === "string" ? body : (body as { raw?: string } | null)?.raw ?? "";

for (const cell of cells()) {
    test(`{§operation-fences} {§fence-pairing}: ${cell.name}`, () => {
        const statements = PlurnkParser.parse(cell.text, { executors: ["sh"] }).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements[0]?.op, cell.op, cell.text);
        assert.equal(bodyOf(statements[0] !== undefined && "body" in statements[0] ? statements[0].body : null), cell.body, cell.text);
        assert.deepEqual(statements.slice(1).map((statement) => statement.op), cell.following, cell.text);
    });
}
});

describe("interstitial-fence", () => {
const task = PlurnkParser.frame("WAIT", '[{"content":"Explain the example.","status":"completed"}]');
const unlabeled = (body: string, ticks = 4, newline = "\n") => `${"`".repeat(ticks)}${newline}${body}${newline}${"`".repeat(ticks)}`;
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["statements", PlurnkParser.parseStatements],
    ["log", PlurnkParser.parseStatements],
] as const) {
    test(`{§fence-pairing}: ${name} reads unlabeled fences outside a block as literal text, never as executable contents`, () => {
        const bodies = [
            "Do not route this text.",
            "<!-- literal, not aside -->",
            "plain words about the example",
        ];
        const source = ["Do not execute these examples:", ...bodies.map((body) => unlabeled(body)), task].join("\n\n");
        const result = parse(source);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        assert.deepEqual(statements(result).map(({ op }) => op), ["WAIT"]);
    });

    test(`{§fence-pairing}: ${name} reads a code-block tag outside a block as prose and inside a body as body`, () => {
        const outside = parse("````ts\nconst x = 1;\n````\n" + task);
        assert.deepEqual(errors(outside), [], "the tag opened nothing, silently");
        assert.deepEqual(statements(outside).map(({ op }) => op), ["WAIT"]);
        const body = "````ts\nconst x = 1;\n````";
        const inside = parse(PlurnkParser.frame("EDIT (notes.md)", body) + "\n" + task);
        assert.deepEqual(errors(inside), []);
        const ops = statements(inside);
        assert.deepEqual(ops.map(({ op }) => op), ["EDIT", "WAIT"]);
        assert.equal(ops[0].op === "EDIT" ? ops[0].body : null, body);
    });
}

test("{§whitespace-contract}: an unfenced heading is not response text, and says it did not run ({§whitespace-contract})", () => {
    for (const bare of ["READ (notes.md)", "WAIT for it", "FIND (src/**) /x/"]) {
        const result = PlurnkParser.parse("Prelude.\n" + bare + "\n" + task);
        assert.deepEqual(statements(result).map(({ op }) => op), ["WAIT"], bare);
        assert.deepEqual(errors(result).map(({ line, column, severity, message }) => [line, column, severity, message]),
            [[2, 0, "warning", `Unfenced \`${bare.split(/[ (]/u)[0]}\` ignored.`]]);
        assert.deepEqual(result.items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Prelude.\n"], "the unfenced line is not response text");
    }
    // {§operation-fences} — the bare name alone is not unfenced prose: it opens, up to the next heading.
    const naked = PlurnkParser.parse("Prelude.\nWAIT\n" + task);
    assert.deepEqual(statements(naked).map(({ op }) => op), ["WAIT", "WAIT"]);
    assert.deepEqual(errors(naked).map(({ line, column, severity, message }) => [line, column, severity, message]),
        [[2, 0, "warning", "`WAIT` opened with no fence; the taught form is three backticks."]]);
    assert.deepEqual(naked.items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Prelude.\n"]);
});

test("{§whitespace-contract}: headings inside bodies remain body content", () => {
    const body = "READ (notes.md)\nTASK";
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND", body) + "\n" + task);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(({ op }) => op), ["SEND", "WAIT"]);
});

test("{§fence-pairing}: a heading under a bare fence at the top level runs, and one warning states the form", () => {
    const source = unlabeled("KILL (workspace:///notes.md)") + "\n" + task;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(statements(result).map(({ op }) => op), ["KILL", "WAIT"]);
    assert.deepEqual(errors(result).map(({ severity, message }) => [severity, message]), [["warning", "`KILL` ran, though its fence was malformed: the opening fence, OP, parameters, and aside share one line."]]);
});

test("{§fence-pairing}: explicit SEND keeps its aside, target, and literal body", () => {
    const aside = "reply";
    const body = "````KILL (workspace:///notes.md)````\n<!-- body comment -->";
    const source = `${PlurnkParser.frame(`SEND <!-- ${aside} -->`, body)}\n${task}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(errors(result), []);
    const ops = statements(result);
    assert.deepEqual(ops.map(({ op }) => op), ["SEND", "WAIT"]);
    const send = ops[0];
    assert.ok(send.op === "SEND");
    assert.equal(send.aside, aside);
    assert.equal(send.body?.raw, body);
    assert.equal(send.target, null);
});

test("{§operation-fences}: unlabeled fences already inside a body remain ordinary body content", () => {
    const body = unlabeled("KILL (workspace:///notes.md)");
    for (const header of ["SEND", "EDIT (workspace:///example.md)", "sh"]) {
        const result = PlurnkParser.parseStatements(PlurnkParser.frame(header, body));
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.equal(ops.length, 1);
        assert.ok(ops[0].op === "SEND" || ops[0].op === "EDIT" || isExecution(ops[0]));
        const actual = ops[0].body;
        assert.equal(typeof actual === "object" && actual !== null && "raw" in actual ? actual.raw : actual, body);
    }
});

test("{§operation-fences}: an unlabeled fence after an unclosed block is that block's closer, not a message", () => {
    for (const tail of ["````", "````\nprose after", "````\nbody\n````"]) {
        const source = "````READ (workspace:///notes.md)\n" + tail;
        const result = PlurnkParser.parseStatements(source);
        assert.equal(result.unparsedTail, undefined, tail);
        assert.deepEqual(statements(result).map(({ op }) => op), ["READ"], tail);
    }
});

test("{§fence-pairing}: an executor tag in any case opens the registered executor with its registered spelling", () => {
    const upper = PlurnkParser.parseStatements("````SH\necho hi\n````\n", { executors: ["sh", "python3"] });
    const ops = upper.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(ops.length, 1);
    assert.equal(isExecution(ops[0]), true);
    assert.equal(isExecution(ops[0]) ? ops[0].runtime : null, "sh", "the AST carries the registered spelling");
    const mixed = PlurnkParser.parseStatements("````Python3 (script.py)\nprint(1)\n````\n", { executors: ["sh", "python3"] });
    const py = mixed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(py[0] !== undefined && isExecution(py[0]) ? py[0].runtime : null, "python3");
    const unknown = PlurnkParser.parseStatements("````Python\nprint(1)\n````\n", { executors: ["sh", "python3"] });
    assert.equal(unknown.items.some((item) => item.kind === "statement"), false, "an unregistered name in any case is still prose");
});
});

describe("interstitial-text", () => {
const task = PlurnkParser.frame("WAIT", '[{"content":"Observe the result.","status":"completed"}]');
const statements = (result: ReturnType<typeof PlurnkParser.parse>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

test("{§whitespace-contract}: provider preamble is text; an opener after text on its line is prose ({§fence-pairing})", () => {
    const own = PlurnkParser.parse("plain preamble\n" + PlurnkParser.frame("READ (workspace:///x)", null) + "\n" + task);
    assert.deepEqual(statements(own).map(({ op }) => op), ["READ", "WAIT"]);
    assert.deepEqual(statements(own)[0].position, { line: 2, column: 0 });
    const inline = PlurnkParser.parse("harmless status." + PlurnkParser.frame("READ (workspace:///x)", null) + "\n" + task);
    assert.deepEqual(statements(inline).map(({ op }) => op), ["WAIT"], "the READ is prose; its orphaned closer quotes nothing, so the WAIT still runs");
});

test("{§operation-fences}: preamble text does not promote headings or inline body examples", () => {
    const body = "keep inline ### READ_ (workspace:///not-an-operation) as body";
    const result = PlurnkParser.parse("ordinary.## Heading! remains preamble\n" + PlurnkParser.frame("WAIT", body));
    assert.deepEqual(result.items.map((item) => item.kind), ["text", "statement"]);
    const first = statements(result)[0];
    assert.equal(first.op === "WAIT" ? first.body : undefined, body);
});

test("{§whitespace-contract}: the topology witness retains a model-written result between intact operations", () => {
    const source = [
        "I'll confirm the count exactly with js, then reply.",
        "````js (tools/count.js)",
        "data/users.json",
        "````",
        "3",
        "````SEND",
        "3",
        "Top-level JSON array.",
        "````",
        task,
        "Postscript: finished.",
    ].join("\n");
    const parsed = PlurnkParser.parse(source, { executors: ["js"] });
    assert.equal(parsed.unparsedTail, undefined);
    assert.deepEqual(parsed.items.map((item) => item.kind), ["text", "statement", "text", "statement", "statement", "text"]);
    const ops = statements(parsed);
    assert.deepEqual(ops.map(writtenOp), ["js", "SEND", "WAIT"]);
    assert.equal(isExecution(ops[0]) ? ops[0].body : null, "data/users.json");
    assert.equal(ops[1].op === "SEND" ? ops[1].body?.raw : null, "3\nTop-level JSON array.");
    assert.deepEqual(ops[1].position, { line: 6, column: 0 });
});

test("{§whitespace-contract}: only the model tier exposes outside text; all tiers preserve body bytes and positions", () => {
    for (const newline of ["\n", "\r\n"]) {
        const body = ["literal text", "````READ (not-executed.md)````", "3", ""].join(newline);
        const source = [
            "Prelude 🌱",
            PlurnkParser.frame("EDIT (note.md)", body),
            "3 — intermediate prose",
            PlurnkParser.frame("SEND", "Only this is a message."),
            task,
            "Trailing prose.",
        ].join(newline);
        for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements]) {
            const parsed = parse(source);
            assert.equal(parsed.unparsedTail, undefined);
            assert.deepEqual(parsed.items.map((item) => item.kind), parse === PlurnkParser.parse
                ? ["text", "statement", "text", "statement", "statement", "text"]
                : ["statement", "statement", "statement"]);
            const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(ops.map(({ op }) => op), ["EDIT", "SEND", "WAIT"]);
            assert.equal(ops[0].op === "EDIT" ? ops[0].body : null, body);
            assert.deepEqual(ops[0].position, { line: 2, column: 0 });
        }
    }
});

test("{§whitespace-contract}: outside text supplies neither an operation nor a task inventory", () => {
    const empty = PlurnkParser.parse("Only commentary.\nTASK completed.");
    assert.equal(statements(empty).length, 0);
    assert.deepEqual(empty.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), [PlurnkParser.NO_VALID_OPERATION]);
    const missing = PlurnkParser.parse("Prelude.\n````READ (note.md)````\nEverything is completed.");
    assert.deepEqual(statements(missing).map(({ op }) => op), ["READ"]);
    assert.deepEqual(missing.items.filter((item) => item.kind === "error"), []);
});

test("{§op-shapes}: outside text hides neither an operation after WAIT nor a second WAIT", () => {
    const parsed = PlurnkParser.parse(task + "\nSome prose.\n````READ (late.md)````\nMore prose.");
    assert.deepEqual(statements(parsed).map(({ op }) => op), ["WAIT", "READ"]);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const repeated = PlurnkParser.parse(task + "\nCommentary.\n" + task);
    assert.deepEqual(statements(repeated).map(({ op }) => op), ["WAIT", "WAIT"]);
    assert.deepEqual(repeated.items.filter((item) => item.kind === "error"), []);
    const log = PlurnkParser.parseStatements(task + "\nCommentary.\n" + task + "\nAfterword.");
    assert.deepEqual(log.items.map((item) => item.kind), ["statement", "statement"]);
});

test("{§operation-fences}: a shorter, longer, or missing closer all end the block after its literal body", () => {
    for (const closer of ["", "```", "`````"]) {
        const parsed = PlurnkParser.parse("Prelude.\n````EDIT (note.md)\nLiteral body.\n" + closer);
        assert.equal(parsed.unparsedTail, undefined, closer);
        assert.deepEqual(statements(parsed).map(({ op }) => op), ["EDIT"], closer);
        const edit = statements(parsed)[0];
        assert.equal(edit.op === "EDIT" ? edit.body : null, "Literal body.", closer);
    }
});
});

describe("naked-operation", () => {
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warnings = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const bodyOf = (statement: PlurnkStatement | undefined) => statement !== undefined && "body" in statement ? typeof statement.body === "string" ? statement.body : statement.body?.raw ?? null : null;
const RECEIPT = (op: string) => `\`${op}\` opened with no fence; the taught form is three backticks.`;

for (const [tier, parse] of [["model", PlurnkParser.parse], ["stored", PlurnkParser.parseStatements]] as const) {
    test(`{§operation-fences}: ${tier} opens a name alone on a line as the operation, its body whole to the end of the turn`, () => {
        const answer = "The answer is **42**.\n\n```python\nprint(42)\n```\n\nDone.";
        const result = parse(`SEND\n${answer}\n`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(statements(result).map((s) => s.op), ["SEND"]);
        assert.equal(bodyOf(statements(result)[0]), answer, "a three-backtick code block inside is body, and nothing is cut back");
        assert.deepEqual(warnings(result), [RECEIPT("SEND")], "one receipt, naming the taught form");
    });
    test(`{§operation-fences}: ${tier} recovers one complete aside without changing the answer or executing its example`, () => {
        const answer = "First line.\nSecond line.";
        for (const gap of ["", " ", "\t"]) {
            for (const ending of ["\n", "\r\n"]) {
                const result = parse(`SEND${gap}<!-- deliverable (notes.md) <1,-1> \`\`\` é𝄞 -->\t${ending}${answer.replaceAll("\n", ending)}`);
                const executed = statements(result);
                assert.deepEqual(executed.map((s) => [s.op, "target" in s ? s.target : null]), [["SEND", null]]);
                assert.equal(executed[0]?.aside, "deliverable (notes.md) <1,-1> ``` é𝄞");
                assert.equal(bodyOf(executed[0]), answer.replaceAll("\n", ending));
                assert.deepEqual(warnings(result), [RECEIPT("SEND")]);
                assert.equal(result.items.some((item) => item.kind === "error" && item.error.severity !== "warning"), false);
                assert.equal(result.unparsedTail, undefined);
            }
        }
    });
}

test("{§operation-fences}: aside recovery uses every native operation's ordinary admission", () => {
    for (const op of ["FIND", "READ", "EDIT", "COPY", "MOVE", "SEND", "BARE", "NOTE", "WAIT", "WORK", "FORK", "KILL"]) {
        const expected = statements(PlurnkParser.parse(`\`\`\`${op} <!-- purpose -->\n\`\`\``));
        assert.deepEqual(statements(PlurnkParser.parse(`${op} <!-- purpose -->\n`)), expected, op);
    }
});

test("{§operation-fences}: an aside at end of input still permits an bodyless operation", () => {
    for (const aside of ["", "answer"]) {
        const result = PlurnkParser.parse(`SEND<!--${aside}-->`);
        assert.deepEqual(statements(result).map((s) => [s.op, s.aside, bodyOf(s)]), [["SEND", aside, null]]);
        assert.deepEqual(warnings(result), [RECEIPT("SEND")]);
    }
});

test("{§whitespace-contract}: aside recovery never admits operands, extra text, or incomplete/repeated asides", () => {
    for (const header of [
        "SEND (notes.md) <!-- delete -->", "SEND <1,-1> <!-- scope -->", "SEND [{\"x\":1}] <!-- metadata -->",
        "SEND <!-- aside --> (notes.md)", "SEND <!-- aside --> trailing", "SEND <!-- a --> <!-- b -->", "SEND <!-- unclosed",
        `SEND${" ".repeat(65_536)}still prose`,
    ]) {
        const result = PlurnkParser.parse(`${header}\n\`\`\`NOTE\nSibling.\n\`\`\``);
        assert.deepEqual(statements(result).map((s) => [s.op, bodyOf(s)]), [["NOTE", "Sibling."]], header);
        assert.deepEqual(warnings(result), ["Unfenced `SEND` ignored."], header);
    }
});

test("{§operation-fences} {§fence-pairing}: asides do not admit indented, quoted, or reasoning-channel names", () => {
    for (const op of ["NOTE", "FIND", "READ", "SEND"]) {
        const text = `${op} <!-- example -->\nOnly an example.\n`;
        for (const prefix of [" ", "\t", "> "]) assert.deepEqual(statements(PlurnkParser.parse(`${prefix}${text}`)), [], prefix + op);
        assert.deepEqual(statements(PlurnkParser.parse(`\`\`\`text\n${text}\`\`\``)), [], op);
        assert.deepEqual(PlurnkParser.parseReasoningOperations(text), [], op);
    }
    assert.deepEqual(statements(PlurnkParser.parse("sh <!-- example -->\necho hi\n", { executors: ["sh"] })), []);
});

test("{§operation-fences}: the name alone again closes the block; a heading ends it; the end of the turn ends it", () => {
    const closed = PlurnkParser.parse("SEND\nThe answer.\nSEND\n");
    assert.deepEqual(statements(closed).map((s) => [s.op, bodyOf(s)]), [["SEND", "The answer."]]);
    assert.deepEqual(warnings(closed), [RECEIPT("SEND")], "the closing name draws nothing of its own");
    const headed = PlurnkParser.parse("NOTE\nRemember this.\n```READ (x.md)\n```");
    assert.deepEqual(statements(headed).map((s) => [s.op, bodyOf(s)]), [["NOTE", "Remember this."], ["READ", null]]);
    const shown = PlurnkParser.parse("SEND\nThe answer.\n```READ (x.md)\n```");
    assert.deepEqual(statements(shown).map((s) => [s.op, bodyOf(s)]), [["SEND", "The answer."], ["READ", null]]);
    const last = PlurnkParser.parse("Text first.\nSEND");
    assert.deepEqual(statements(last).map((s) => [s.op, bodyOf(s)]), [["SEND", null]], "a bare name as the last line has no body");
});

test("{§operation-fences}: bare native names open, but prose and executor names do not", () => {
    assert.deepEqual(statements(PlurnkParser.parse("WAIT\n")).map((s) => s.op), ["WAIT"]);
    const note = PlurnkParser.parse("NOTE\nRemember this.\n");
    assert.deepEqual(statements(note).map((s) => [s.op, bodyOf(s)]), [["NOTE", "Remember this."]]);
    assert.deepEqual(statements(PlurnkParser.parse("READ\n")).map((s) => [s.op, (s as { target?: unknown }).target ?? null]), [["READ", null]], "a naked READ has no target; dispatch refuses it as any targetless READ");
    assert.deepEqual(statements(PlurnkParser.parse("  SEND\nThe answer.\n")), [], "an offset name is prose, as every offset example is");
    assert.deepEqual(statements(PlurnkParser.parse("SEND delivers messages.\n")), [], "prose after a name is not an aside or a naked heading");
    assert.deepEqual(warnings(PlurnkParser.parse("SEND delivers messages.\n")), ["Unfenced `SEND` ignored."], "it is the unfenced form, and still says so");
    assert.deepEqual(statements(PlurnkParser.parse("sh\necho hi\n", { executors: ["sh"] })), [], "an executor's name is a runtime, not an operation");
});

test("{§whitespace-contract}: a name with an operand and no fence still did not run, and says so", () => {
    for (const line of ["SEND (notes.md)", "READ (a.md) <1,-1>", "EDIT <3>", "FIND (src/**) /x/"]) {
        const result = PlurnkParser.parse(`${line}\n`);
        assert.deepEqual(statements(result), [], line);
        assert.deepEqual(warnings(result), [`Unfenced \`${line.split(/[ (<[]/u)[0]}\` ignored.`], line);
    }
    assert.deepEqual(warnings(PlurnkParser.parse("READ the file first, then decide.\n")), ["Unfenced `READ` ignored."], "a verb opening a column-zero line is the unfenced form, as before");
});

test("{§operation-fences}: reasoning is never read this way", () => {
    assert.deepEqual(PlurnkParser.parseReasoningOperations("NOTE\nA rehearsal, not a note.\n"), []);
});
});

describe("nested-fences", () => {
const task = PlurnkParser.frame("WAIT", "Reported the result.");
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const bodyText = (op: PlurnkStatement) => "body" in op && typeof op.body === "object" && op.body !== null && "raw" in op.body ? op.body.raw : "body" in op ? op.body : null;

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["statements", PlurnkParser.parseStatements],
    ["log", PlurnkParser.parseStatements],
] as const) {
    test(`{§fence-pairing}: ${name} keeps a report holding same-width blocks intact under a framed SEND`, () => {
        const body = [
            "The process reversed the supplied bytes.",
            '````js [{"stdin": "open"}]',
            'process.stdin.on("data", value => process.stdout.write(value));',
            "````",
            "The input was delivered with:",
            '````SEND (js:///ab3d5678) [{"eof": true}]',
            "oranges",
            "````",
            "Observed stdout: segnaro. No further input is needed.",
        ].join("\n");
        const result = parse(`${PlurnkParser.frame("SEND", body)}\n\n${task}`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.deepEqual(ops.map(writtenOp), ["SEND", "WAIT"]);
        assert.ok(ops[0].op === "SEND");
        assert.equal(ops[0].target, null);
        assert.equal(bodyText(ops[0]), body);
        assert.equal(bodyText(ops[1]), "Reported the result.");
    });
}

test("{§operation-fences}: a shorter inner fence is body and an equal or longer bare fence closes an undelimited block", () => {
    const shorter = PlurnkParser.parse("````SEND\nCode:\n```ts\nconst value = 42;\n```\nDone.\n````\n" + task);
    assert.deepEqual(errors(shorter), []);
    assert.equal(bodyText(statements(shorter)[0]), "Code:\n```ts\nconst value = 42;\n```\nDone.");
    const equal = PlurnkParser.parse("````SEND\nCode:\n````\nAfter the closer.\n" + task);
    assert.deepEqual(errors(equal), []);
    assert.deepEqual(statements(equal).map(writtenOp), ["SEND", "WAIT"]);
    assert.equal(bodyText(statements(equal)[0]), "Code:");
    const longer = PlurnkParser.parse("````SEND\nCode:\n`````\n" + task);
    assert.deepEqual(errors(longer), []);
    assert.equal(bodyText(statements(longer)[0]), "Code:");
});

test("{§operation-fences}: nesting preserves exact bodies across widths, depths, newlines, and operation families", () => {
    for (const header of ["SEND", "EDIT (notes.md)", "sh", "BARE", "WORK", "FORK"]) {
        for (const width of [3, 4, 5, 8]) {
            for (const depth of [1, 2, 8]) {
                for (const newline of ["\n", "\r\n"]) {
                    const fence = "`".repeat(width);
                    const body = [
                        `${fence}KILL (notes.md)${fence}`,
                        ...Array.from({ length: depth }, (_, index) => `${fence}unknown${index} [not valid metadata`),
                        "literal 🙂 content",
                        ...Array.from({ length: depth }, () => `${fence}\t `),
                        "  trailing content  ",
                        "",
                    ].join(newline);
                    const result = PlurnkParser.parse(`${PlurnkParser.frame(header, body)}\n${task}`);
                    const context = `${header}, width=${width}, depth=${depth}, newline=${JSON.stringify(newline)}`;
                    assert.equal(result.unparsedTail, undefined, context);
                    assert.deepEqual(errors(result), [], context);
                    const ops = statements(result);
                    assert.deepEqual(ops.map(writtenOp), [header.split(" ")[0], "WAIT"], context);
                    assert.equal(bodyText(ops[0]), body, context);
                }
            }
        }
    }
});

test("{§operation-fences}: a bare fence closes the innermost block of its width, else the outermost it reaches", () => {
    const wider = PlurnkParser.parse("````EDIT (notes.md)\n```sh\necho literal\n````\n" + task);
    assert.deepEqual(errors(wider), []);
    assert.deepEqual(statements(wider).map(writtenOp), ["EDIT", "WAIT"]);
    assert.equal(bodyText(statements(wider)[0]), "```sh\necho literal", "the wider closer closes the wider block; the unfinished example inside is body");
    const equal = PlurnkParser.parse("```EDIT (notes.md)\n```sh\necho literal\n```\n```\n" + task);
    assert.deepEqual(errors(equal), []);
    assert.deepEqual(statements(equal).map(writtenOp), ["EDIT", "WAIT"]);
    assert.equal(bodyText(statements(equal)[0]), "```sh\necho literal\n```", "equal widths nest when every inner block closes");
    const taught = PlurnkParser.parse("````EDIT (edit-example.md) <!-- nesting -->\n```EDIT (create-example.md)\nnested content\n```\n````\n" + task);
    assert.deepEqual(errors(taught), []);
    assert.deepEqual(statements(taught).map(writtenOp), ["EDIT", "WAIT"]);
    assert.equal(bodyText(statements(taught)[0]), "```EDIT (create-example.md)\nnested content\n```", "the hot path's nesting example");
});

test("{§operation-fences}: a heading ends an unclosed block and opens the next statement", () => {
    const source = "````READ (safe.md)````\n````EDIT (notes.md)\n````sh\nnot the edit\n````\n````NOTE\n````";
    const result = PlurnkParser.parseStatements(source);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(statements(result).map(writtenOp), ["READ", "EDIT", "sh", "NOTE"]);
    assert.equal(bodyText(statements(result)[1]), null, "the EDIT ended at the sh heading with nothing left over");
    assert.equal(bodyText(statements(result)[2]), "not the edit");
});

test("{§operation-fences}: a closer glued to the next opener never swallows the turn", () => {
    const glued = "````READ (a.md) <1,-1>\n````````READ (b.md) <1,-1>\n````````EDIT (c.md) <@abcde>\nreplacement\n````";
    const result = PlurnkParser.parse(glued + "\n" + task);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(statements(result).map(writtenOp), ["READ", "READ", "EDIT", "WAIT"]);
    assert.equal(bodyText(statements(result)[2]), "replacement");
});

test("{§operation-fences}: a complete three-backtick executor block inside a four-backtick block is body", () => {
    const body = "```sh\necho sample\n```";
    const result = PlurnkParser.parse(`\`\`\`\`EDIT (README.md)\n${body}\n\`\`\`\`\n${task}`);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(writtenOp), ["EDIT", "WAIT"]);
    assert.equal(bodyText(statements(result)[0]), body);
});

test("{§operation-fences}: the host names its executors and unknown tags stay body", () => {
    const source = "````EDIT (notes.md)\n````js\nconsole.log(1)\n````\n" + task;
    const unknown = PlurnkParser.parse(source);
    assert.deepEqual(statements(unknown).map(writtenOp), ["EDIT", "WAIT"]);
    assert.equal(bodyText(statements(unknown)[0]), "````js\nconsole.log(1)");
    const known = PlurnkParser.parse(source, { executors: ["js"] });
    assert.deepEqual(statements(known).map(writtenOp), ["EDIT", "js", "WAIT"]);
});

test("{§operation-fences}: a block ended by a heading or the end of input keeps its body up to its last bare fence", () => {
    const byHeading = PlurnkParser.parse("````EDIT (a.md)\nline one\n```\nprose after a short closer\n````READ (b.md)\n" + task);
    assert.deepEqual(errors(byHeading), []);
    assert.deepEqual(statements(byHeading).map(writtenOp), ["EDIT", "READ", "WAIT"]);
    assert.equal(bodyText(statements(byHeading)[0]), "line one");
    const byEof = PlurnkParser.parseStatements("````EDIT (a.md)\nline one\nline two");
    assert.equal(byEof.unparsedTail, undefined);
    assert.equal(bodyText(statements(byEof)[0]), "line one\nline two");
    const emptyByEof = PlurnkParser.parseStatements("````READ (a.md)");
    assert.equal(emptyByEof.unparsedTail, undefined);
    assert.deepEqual(statements(emptyByEof).map(writtenOp), ["READ"]);
});

test("{§operation-fences}: shell heredoc Markdown and complete inline examples are not additional operations", () => {
    const body = "cat <<'EOF'\n````json\n{\"ok\":true}\n````\n````READ (notes.md)````\nEOF";
    const result = PlurnkParser.parse(PlurnkParser.frame("sh", body) + "\n" + task);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(writtenOp), ["sh", "WAIT"]);
    assert.equal(bodyText(statements(result)[0]), body);
});

test("{§fence-pairing}: a wider canonical wrapper preserves arbitrary unfinished and unlabeled examples", () => {
    for (const body of ["````sh\nunfinished", "````not a closer", "````\nunlabeled\n````", "````js\n````sh\nunfinished twice"]) {
        const result = PlurnkParser.parse(PlurnkParser.frame("EDIT (notes.md)", body) + "\n" + task);
        assert.equal(result.unparsedTail, undefined, body);
        assert.deepEqual(errors(result), [], body);
        assert.deepEqual(statements(result).map(writtenOp), ["EDIT", "WAIT"], body);
        assert.equal(bodyText(statements(result)[0]), body, body);
    }
});

test("{§fence-pairing}: frame chooses a fence wider than any run in the body, three at least", () => {
    assert.equal(PlurnkParser.frame("READ (a.md)", null), "```READ (a.md)\n```");
    assert.equal(PlurnkParser.frame("EDIT (a.md)", "```sh\nx\n```"), "````EDIT (a.md)\n```sh\nx\n```\n````");
    const framed = PlurnkParser.frame("EDIT (a.md)", "```READ (b.md)\n```");
    const reparsed = PlurnkParser.parseStatements(framed);
    assert.deepEqual(statements(reparsed).map(writtenOp), ["EDIT"]);
    assert.equal(bodyText(statements(reparsed)[0]), "```READ (b.md)\n```");
});

test("{§fence-pairing}: a closer followed by the next opener on the same line closes and opens", () => {
    const source = "Reviewing the state.\n````READ (a.ts) <1,30> <!-- imports --> ```` ````READ (a.ts) <140,245> <!-- picker --> ```` ````READ (b.ts) <1,-1> ````\n" + task;
    const result = PlurnkParser.parse(source);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(errors(result).filter(({ severity }) => severity === "error"), []);
    assert.deepEqual(statements(result).map(writtenOp), ["READ", "READ", "READ", "WAIT"]);
    const marks = statements(result).slice(0, 3).map((op) => (op as { lineMarker?: { marks: unknown[] } | null }).lineMarker?.marks);
    assert.deepEqual(marks, [[1, 30], [140, 245], [1, -1]]);
});

test("{§fence-pairing}: `@` with one to four digits is that line, with one advisory; five characters stay an anchor", () => {
    const result = PlurnkParser.parseStatements("````EDIT (a.ts) <@210,@211>\nx\n````\n````EDIT (a.ts) <@ab12c>\ny\n````");
    const ops = statements(result);
    assert.deepEqual(ops.map(writtenOp), ["EDIT", "EDIT"]);
    assert.deepEqual((ops[0] as { lineMarker: { marks: unknown[] } }).lineMarker.marks, [210, 211]);
    assert.deepEqual((ops[1] as { lineMarker: { marks: unknown[] } }).lineMarker.marks, ["@ab12c"]);
    const advisories = errors(result);
    assert.equal(advisories.length, 2);
    assert.ok(advisories.every(({ severity }) => severity === "warning"));
    assert.match(advisories[0].message, /`@210` was read as line 210; an anchor is five characters/u);
});

test("{§fence-pairing}: an aside that never closes on its line is the aside to the end of the line, with one advisory", () => {
    const result = PlurnkParser.parseStatements("````EDIT (a.rs) <1,-1> <!-- full rewrite: ErrorInner{kind,cored}\nbody\n````");
    const ops = statements(result);
    assert.deepEqual(ops.map(writtenOp), ["EDIT"]);
    assert.equal((ops[0] as { aside: string | null }).aside, "full rewrite: ErrorInner{kind,cored}");
    assert.equal((ops[0] as { body: string | null }).body, "body");
    const advisories = errors(result);
    assert.deepEqual(advisories.map(({ severity }) => severity), ["warning"]);
    assert.match(advisories[0].message, /not closed with `-->`; it was read to the end of the line/u);
    const closed = PlurnkParser.parseStatements("````READ (a.rs) <!-- ok --> ````");
    assert.deepEqual(errors(closed), []);
    assert.equal((statements(closed)[0] as { aside: string | null }).aside, "ok");
});

test("{§fence-pairing}: an offset operation fence is shown, not run, and draws no complaint", () => {
    const source = [
        "    ````EDIT (ark/json-schema/scope.ts) <@VaKRz> <!-- restore the union -->",
        "    \t\"boolean|TypeWithNoKeywords\",",
        "    ````",
        "",
        "    ````READ (ark/json-schema/scope.ts) <71,80> <!-- verify -->",
        "    ````",
        "",
        "    ````sh <!-- typecheck -->",
        "    ./node_modules/.bin/tsc --noEmit",
        "    ````",
        task,
    ].join("\n");
    const result = PlurnkParser.parse(source);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(statements(result).map(writtenOp), ["WAIT"], "only the column-0 WAIT runs");
    assert.deepEqual(errors(result), [], "plurnk.md tells the model to offset an example, so the form is correct and silent");
});

test("{§fence-pairing}: a whole turn on one line parses from its line start, including opener after heading", () => {
    const prose = "I'll read the files and repair the mangled regions. ";
    const program = "````READ (packages/quill/src/themes/base.ts) <1,30> <!-- imports + WeakMap --> ```` ````READ (packages/quill/src/themes/base.ts) <200,240> <!-- the rest --> ```` ````WAIT ````";
    assert.deepEqual(statements(PlurnkParser.parse(prose + program)).map(writtenOp), [], "{§fence-pairing}: an opener after text on its line is prose");
    const chained = PlurnkParser.parse(program);
    assert.equal(chained.unparsedTail, undefined);
    assert.deepEqual(errors(chained).filter(({ severity }) => severity === "error"), []);
    assert.deepEqual(statements(chained).map(writtenOp), ["READ", "READ", "WAIT"]);
    assert.equal(bodyText(statements(chained)[2]), null);

    const direct = PlurnkParser.parse("````EDIT (crates/wasmi/src/engine/config.rs) <60,66> <!-- drop mangled duplicate Default fields --> ````EDIT (crates/wasmi/src/error.rs) <31,38> <!-- repair mangled imports --> ````WAIT ````");
    assert.deepEqual(errors(direct).filter(({ severity }) => severity === "error"), []);
    const ops = statements(direct);
    assert.deepEqual(ops.map(writtenOp), ["EDIT", "EDIT", "WAIT"]);
    assert.deepEqual(ops.slice(0, 2).map((op) => [(op as { lineMarker?: { marks: unknown[] } | null }).lineMarker?.marks, bodyText(op)]), [[[60, 66], null], [[31, 38], null]], "each heading ends bodyless where the next opener begins");
    assert.deepEqual(ops.slice(0, 2).map(({ aside }) => aside), ["drop mangled duplicate Default fields", "repair mangled imports"]);

    const bare = PlurnkParser.parseStatements("````READ (a.rs) <1,10> ````READ (b.rs) <1,10>");
    assert.deepEqual(statements(bare).map((op) => [op.op, (op as { target: { raw: string } | null }).target?.raw]), [["READ", "a.rs"], ["READ", "b.rs"]]);

    const canonical = PlurnkParser.parse("````NOTE\nRepair\n````");
    assert.deepEqual(errors(canonical), [], "the body beneath the heading draws no advisory");
});
});

describe("operation-fences", () => {
const block = (width: number, header: string, body = "") => `${"`".repeat(width)}${header}\n${body}\n${"`".repeat(width)}`;
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyText = (statement: PlurnkStatement) => "body" in statement ? typeof statement.body === "string" ? statement.body : statement.body?.raw : undefined;
const clean = (result: ParseResult) => {
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
};

for (const [tier, parse] of [
    ["model", PlurnkParser.parse],
    ["stored", PlurnkParser.parseStatements],
] as const) {
    for (const width of [3, 4, 6]) {
        test(`{§operation-fences}: ${tier} accepts ${width}-backtick native and registered executor operations without a receipt`, () => {
            const source = [
                block(width, "READ (notes.md) <1,2> <!-- inspect -->"),
                block(width, "NOTE", "Keep this determination."),
                block(width, "SH", "echo 42"),
                block(width, "gitea (list_issues)", '{"repo_id":42}'),
            ].join("\n\n");
            const result = parse(source, { executors: ["sh", "gitea"] });
            assert.equal(result.unparsedTail, undefined);
            const receipts = result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []);
            assert.deepEqual(receipts, [], "every accepted width draws nothing");
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

    test(`{§fence-pairing}: ${tier} keeps indented and enclosed three-backtick operations inert`, () => {
        const example = block(3, "KILL (notes.md)");
        const examples = [
            example.split("\n").map((line) => `    ${line}`).join("\n"),
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

test("{§fence-pairing}: up to three spaces still open, close and end a block; four, or a tab, are body", () => {
    const three = PlurnkParser.parse("   ```READ (notes.md)\n   ```\n" + block(3, "NOTE", "Kept."));
    clean(three);
    assert.deepEqual(statements(three).map(writtenOp), ["READ", "NOTE"], "three spaces are CommonMark's allowance");
    const four = PlurnkParser.parse("    ```READ (notes.md)\n    ```\n" + block(3, "NOTE", "Kept."));
    clean(four);
    assert.deepEqual(statements(four).map(writtenOp), ["NOTE"], "four spaces are indented code");
    for (const indent of ["    ", "\t"]) {
        const result = PlurnkParser.parse(`\`\`\`EDIT (notes.md)\nkept\n${indent}\`\`\`\n${indent}\`\`\`sh\necho literal\n\`\`\`\n` + block(3, "NOTE", "Kept."));
        clean(result);
        assert.deepEqual(statements(result).map(writtenOp), ["EDIT", "NOTE"], JSON.stringify(indent));
        assert.equal(bodyText(statements(result)[0]), `kept\n${indent}\`\`\`\n${indent}\`\`\`sh\necho literal`, "an indented fence neither closes nor ends the block");
    }
    const closer = PlurnkParser.parse("```EDIT (notes.md)\nkept\n   ```\n" + block(3, "NOTE", "Kept."));
    clean(closer);
    assert.equal(bodyText(statements(closer)[0]), "kept", "a closer within three spaces closes");
});

test("{§operation-fences}: complete nested three-backtick operations stay literal bodies", () => {
    for (const width of [3, 4]) {
        const body = ["Example:", block(3, "sh", "echo example"), block(3, "KILL (notes.md)"), "Still the answer."].join("\n");
        const result = PlurnkParser.parse(block(width, "SEND [200]", body));
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(statements(result).map(writtenOp), ["SEND"]);
        assert.equal(bodyText(statements(result)[0]), body);
    }
});

test("{§operation-fences}: a known heading ends an unfinished wider body; the wider fence holds it only while it closes", () => {
    for (const outer of [4, 5]) {
        const body = "```sh\necho literal";
        const unfinished = PlurnkParser.parse(`${"`".repeat(outer)}EDIT (notes.md)\n${body}`);
        assert.deepEqual(statements(unfinished).map(writtenOp), ["EDIT", "sh"], "the unfinished wider block ends at the heading");
        assert.equal((statements(unfinished)[0] as { body: string | null }).body, null);
        const closed = PlurnkParser.parse(`${"`".repeat(outer)}EDIT (notes.md)\n${body}\n${"`".repeat(outer)}`);
        clean(closed);
        assert.deepEqual(statements(closed).map(writtenOp), ["EDIT"]);
        assert.equal(bodyText(statements(closed)[0]), body);
    }
});

test("{§operation-fences}: equal-width missing-closer recovery works at three backticks", () => {
    const recovered = PlurnkParser.parse("```EDIT (notes.md)\nFirst body.\n```sh\necho actual-command\n```");
    assert.equal(recovered.unparsedTail, undefined);
    assert.deepEqual(statements(recovered).map(writtenOp), ["EDIT", "sh"]);
    assert.equal(bodyText(statements(recovered)[0]), "First body.");
    assert.equal(bodyText(statements(recovered)[1]), "echo actual-command");
});

test("{§fence-pairing}: compact and inline-chained operations accept either fence width", () => {
    for (const [first, second] of [[3, 3], [3, 4], [4, 3]]) {
        const a = "`".repeat(first);
        const b = "`".repeat(second);
        const result = PlurnkParser.parse(`${a}READ (a.md)${a} ${b}READ (b.md)${b}`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(statements(result).map(writtenOp), ["READ", "READ"]);
        assert.deepEqual(statements(result).map((op) => op.op === "READ" ? op.target?.raw : null), ["a.md", "b.md"]);
    }
});

test("{§op-shapes}: reasoning accepts three-backtick NOTE while preserving enclosing quotations", () => {
    const quoted = block(3, "NOTE", "An example, not retained memory.");
    const reasoning = [
        block(3, "NOTE", "Actual memory."),
        block(3, "sh", "echo never-executed"),
        block(3, "SEND", quoted),
        block(3, "text", quoted),
        quoted.split("\n").map((line) => `    ${line}`).join("\n"),
    ].join("\n\n");
    assert.deepEqual(PlurnkParser.parseReasoningOperations(reasoning).map(({ body }) => body), ["Actual memory."]);
});

test("{§operation-fences}: canonical output is three-backtick, one wider than any fence in the body", () => {
    assert.equal(PLURNK_FENCE, "```");
    assert.equal(PlurnkParser.frame("SEND [200]", "Done."), block(3, "SEND [200]", "Done."));
    const body = block(3, "sh", "echo example");
    assert.equal(PlurnkParser.frame("SEND [200]", body), block(4, "SEND [200]", body));
    const result = PlurnkParser.parse(PlurnkParser.frame("SEND [200]", body));
    clean(result);
    assert.equal(bodyText(statements(result)[0]), body);
});
});

describe("prose-code-blocks", () => {
const recorded = (name: string) => readFileSync(new URL(`../fixtures/recorded/${name}`, import.meta.url), "utf8");
const parse = (input: string, executors = ["sh", "python3"]) => PlurnkParser.parse(input, { executors });
const statements = (input: string, executors?: string[]) => parse(input, executors).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const bodyOf = (statement: ReturnType<typeof statements>[number] | undefined): string | null => {
    if (statement === undefined || !("body" in statement) || statement.body === null) return null;
    return typeof statement.body === "string" ? statement.body : statement.body.raw;
};

test("{§operation-fences} replies keep every line after a balanced inner fence pair", () => {
    const fenced = statements("```SEND [200]\nRan the tests:\n```\ntraceback\n```\nAll done.\n```");
    assert.deepEqual(fenced.map(({ op }) => op), ["SEND"]);
    assert.equal(bodyOf(fenced[0]), "Ran the tests:\n```\ntraceback\n```\nAll done.");
    for (const op of ["SEND", "WORK (session://verify)"]) {
        const [statement] = statements(`\`\`\`${op}\nRan the tests:\n\`\`\`\ntraceback\n\`\`\`\nAll done.\n\`\`\``);
        assert.equal(bodyOf(statement), "Ran the tests:\n```\ntraceback\n```\nAll done.", op);
    }
});

test("{§operation-fences} a naked SEND's final unpaired fence is its closer, not the deliverable's last line", () => {
    const [kill] = statements("SEND\nRan the tests:\n```\ntraceback\n```\nAll done.\n```");
    assert.equal(bodyOf(kill), "Ran the tests:\n```\ntraceback\n```\nAll done.");
    assert.equal(bodyOf(statements("SEND\nAll done.\n```")[0]), "All done.");
    assert.equal(bodyOf(statements("SEND\n```\ncode\n```")[0]), "```\ncode\n```", "a paired final fence stays body");
});



test("{§fence-pairing} qflash run218's WORK task keeps the `sh` script it hands the child, and the parent runs nothing (recorded)", () => {
    const executed = statements(recorded("qflash-run218-packet015.md"));
    assert.deepEqual(executed.map((statement) => "runtime" in statement ? statement.runtime : statement.op), ["EDIT", "WORK"]);
    const task = bodyOf(executed[1]);
    assert.match(task!, /^Run this test in the sympy repository/u);
    assert.match(task!, /```sh\ncd \/home\/user\/repos\/sympy && python3 -c "/u);
    assert.match(task!, /print\(result\.stderr\[-500:\] if len\(result\.stderr\) > 500 else result\.stderr\)\n"\n```$/u, "the script's own closer ends it; the task runs to the end of the turn");
});

test("{§fence-pairing} qflash run118's SEND report keeps its quoted code and every paragraph after it (recorded)", () => {
    const text = recorded("qflash-run118-packet046.md");
    const result = parse(text, ["sh", "python", "python3"]);
    const executed = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(executed.map(({ op }) => op), ["SEND"], "the quoted `python` block never runs in the parent");
    assert.match(bodyOf(executed[0])!, /```python\n# Current broken code/u);
    assert.match(bodyOf(executed[0])!, /This means no tests can run/u, "the paragraph after the last inner block is still the message");
    assert.deepEqual(result.items.filter((item) => item.kind === "text"), []);
});

test("{§fence-pairing} a native operation's heading still ends an unclosed message; an executor heading ends a non-prose body", () => {
    assert.deepEqual(statements("```SEND\nDone.\n```WAIT\n```").map(({ op }) => op), ["SEND", "WAIT"]);
    assert.deepEqual(statements("```WORK (session://a)\nRun:\n```sh\nls\n```").map((statement) => "runtime" in statement ? statement.runtime : statement.op), ["WORK"]);
    assert.deepEqual(statements("```EDIT (notes.md)\nRun:\n```sh\nls\n```").map((statement) => "runtime" in statement ? statement.runtime : statement.op), ["EDIT", "sh"]);
});



test("{§fence-pairing} running on never hides an operation the author wrote: a closed WORK keeps its WAIT (recorded)", () => {
    const executed = statements(recorded("django-12747-packet043.md"));
    assert.deepEqual(executed.map(({ op }) => op), ["NOTE", "WORK", "WAIT"]);
    assert.match(bodyOf(executed[1])!, /^Run from the repository root[\s\S]*including any FAILED\/ERROR blocks and tracebacks\.$/u);
});





test("{§fence-pairing} glm run158: an unclosed EDIT never swallows the EDIT after it; both run and no heading is written (recorded)", () => {
    const text = recorded("glm-run158-packet007.md");
    const result = parse(text);
    const executed = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(executed.map((statement) => [statement.op, "target" in statement ? statement.target?.raw : null]), [
        ["EDIT", "django/utils/functional.py"],
        ["EDIT", "tests/utils_tests/test_simplelazyobject.py"],
    ]);
    const [first, second] = executed;
    assert.equal(bodyOf(first), text.split("\n").slice(1, 7).join("\n"), "the first body ends before the second heading, its blank line the supplied closer's line ending");
    assert.match(bodyOf(first)!, /return other \+ self\._wrapped$/u);
    assert.match(bodyOf(second)!, /^\n    def test_radd\(self\):[\s\S]*self\.assertEqual\(6, 1 \+ x\)$/u);
    for (const statement of executed) assert.doesNotMatch(bodyOf(statement)!, /```EDIT/u, "no body carries an EDIT heading");
    const text2 = result.items.filter((item) => item.kind === "text").map((item) => item.kind === "text" ? item.content : "");
    assert.equal(text2.length, 1);
    assert.match(text2[0], /Now verify with the existing and new tests:```sh/u, "the trailing prose and inline sh are outside text, not a body");
});

test("{§fence-pairing} an EDIT body holds a same-width native heading only inside a wider fence; equal widths run it", () => {
    const unclosed = statements("```EDIT (a.md) <1,-1>\nBefore.\n```KILL (x)\n```\nAfter.\n");
    assert.deepEqual(unclosed.map((statement) => [statement.op, bodyOf(statement)]), [["EDIT", "Before."], ["KILL", null]], "shape (c): the closer is supplied before the heading, and KILL (x) runs");
    const closed = statements("```EDIT (a.md) <1,-1>\nBefore.\n```KILL (x)\n```\nAfter.\n```\n");
    assert.deepEqual(closed.map((statement) => [statement.op, bodyOf(statement)]), [["EDIT", "Before."], ["KILL", null]], "shape (b) is fence-identical to run158 and reads the same way");
    const wider = statements("````EDIT (a.md) <1,-1>\nBefore.\n```KILL (x)\n```\nAfter.\n````\n");
    assert.deepEqual(wider.map((statement) => [statement.op, bodyOf(statement)]), [["EDIT", "Before.\n```KILL (x)\n```\nAfter."]], "shape (a): the taught wider fence holds the example as text");
});
});

describe("reply-framing", () => {
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);

for (const [tier, parse] of [
    ["model", PlurnkParser.parse],
    ["stored", PlurnkParser.parseStatements],
] as const) {
    test(`{§operation-fences}: ${tier} preserves nested examples in a final reply's ordinary body`, () => {
        for (const body of ["All done.", "```python\nprint(42)\n```", "```\n42\n```", "A\n````READ (example.md)````\nB"]) {
            const result = parse(PlurnkParser.frame("SEND [200]", body));
            assert.equal(result.unparsedTail, undefined);
            assert.deepEqual(result.items.filter((item) => item.kind === "error" || item.kind === "text"), []);
            const ops = statements(result);
            assert.deepEqual(ops.map(writtenOp), ["SEND"]);
            assert.equal(ops[0].op === "SEND" ? ops[0].body?.raw : null, body);
            assert.deepEqual(ops[0].op === "SEND" ? ops[0].metadata : null, ["200"]);
        }
    });

    test(`{§operation-fences}: ${tier} final reply closers preserve subsequent operations`, () => {
        for (const reply of ["```SEND [200]```", "```SEND [200]\nDone.\n```", "````SEND [200] <!-- answer -->\nDone.\n````"]) {
            const result = parse(`${reply}\n\n${PlurnkParser.frame("EDIT (next.md)", "replacement")}`);
            assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
            const ops = statements(result);
            assert.deepEqual(ops.map(writtenOp), ["SEND", "EDIT"]);
            assert.equal(ops[1].op === "EDIT" ? ops[1].body : null, "replacement");
        }
    });

    test(`{§op-shapes}: ${tier} a missing KILL target is refused without discarding siblings`, () => {
        const result = parse(`${PlurnkParser.frame("KILL", null)}\n${PlurnkParser.frame("READ (actual.md)", null)}`);
        assert.deepEqual(statements(result).map(writtenOp), ["READ"]);
        assert.ok(result.items.some((item) => item.kind === "error" && item.error.message === "KILL requires a target."));
    });
}

test("{§fence-pairing}: a quoted operation does not claim the rest of the document", () => {
    const result = PlurnkParser.parse("````text\n```KILL (notes.md)\n```\n````\n```READ (actual.md)\n```");
    assert.deepEqual(statements(result).map(writtenOp), ["READ"]);
    assert.deepEqual(PlurnkParser.parseReasoningOperations("````text\n```SEND [200]\n```NOTE\nQuoted.\n```\n````\n```NOTE\nActual.\n```").map(({ body }) => body), ["Actual."]);
});
});

describe("response-text", () => {
const textItems = (source: string) => PlurnkParser.parse(source).items.filter((item) => item.kind === "text");

test("{§whitespace-contract}: the model tier partitions outside text and operations in source order", () => {
    const source = "Before.\n\n````READ (notes.md)\n````\n\nBetween.\n\n````SEND\nAfter.\n````\nTail.";
    const items = PlurnkParser.parse(source).items;
    assert.deepEqual(items.map(({ kind }) => kind), ["text", "statement", "text", "statement", "text"]);
    assert.deepEqual(items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Before.\n\n", "\n\nBetween.\n\n", "\nTail."]);
    assert.deepEqual(items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["READ", "SEND"]);
});

test("{§whitespace-contract}: whitespace, operation bodies and asides are not outside response text", () => {
    const body = "READ (literal.md)\n\n```READ (also-literal.md)\n```\n<!-- literal comment -->";
    const source = " \r\n" + PlurnkParser.frame("SEND <!-- reply -->", body) + "\r\n\t";
    assert.deepEqual(textItems(source), []);
    const items = PlurnkParser.parse(source).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind === "statement" && items[0].statement.op === "SEND" ? items[0].statement.body?.raw : null, body);
});

for (const quote of [
    "`````text\n````SEND\nExample only.\n````\n`````",
    "```\n````KILL (workspace:///keep.md)\n````\n```",
    "    ```READ (quoted.md)\n    ```",
    "~~~markdown\nExample.\n~~~",
]) {
    test(`{§whitespace-contract}: quotation stays one literal text span: ${JSON.stringify(quote)}`, () => {
        const items = PlurnkParser.parse(quote).items;
        assert.deepEqual(items.filter((item) => item.kind === "statement"), []);
        assert.deepEqual(items.flatMap((item) => item.kind === "text" ? [item.content] : []), [quote]);
    });
}

test("{§whitespace-contract}: a malformed operation and a lost boundary are not delivered as text", () => {
    const source = "Before.\n````EDIT (note.md) <bad>\nnot a message\n````\nAfter.\n````READ (unclosed";
    const parsed = PlurnkParser.parse(source);
    assert.deepEqual(parsed.items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["Before.\n", "\nAfter.\n"]);
    assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "error"));
    assert.equal(parsed.unparsedTail?.from.line, 6);
});

test("{§whitespace-contract}: text positions use the lexer's Unicode and CRLF coordinates", () => {
    const source = "🐹 first\r\n````NOTE\r\nmemory\r\n````\r\n第二";
    assert.deepEqual(textItems(source).map((item) => ({ content: item.content, position: item.position })), [
        { content: "🐹 first\r\n", position: { line: 1, column: 0 } },
        { content: "\r\n第二", position: { line: 4, column: 4 } },
    ]);
});

test("{§whitespace-contract}: statement and client tiers still ignore outside text", () => {
    const source = "Before.\n````READ (notes.md)\n````\nAfter.";
    for (const parse of [PlurnkParser.parseStatements]) {
        assert.deepEqual(parse(source).items.map(({ kind }) => kind), ["statement"]);
    }
});

test("{§whitespace-contract}: a prose line that opens with an operation's name draws one warning; quoted, offset and mid-sentence names draw none", () => {
    const warnings = (source: string) => PlurnkParser.parse(source, { executors: ["sh", "js"] }).items
        .flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [[item.error.line, item.error.column, item.error.message]] : []);
    assert.deepEqual(warnings("KILL The recovery site is **CEDAR-HARBOR-27**."), [[1, 0, "Unfenced `KILL` ignored."]]);
    assert.deepEqual(warnings("Let me look.\nREAD (workspace:///notes.md)\nSEND"), [
        [2, 0, "Unfenced `READ` ignored."],
        [3, 0, "`SEND` opened with no fence; the taught form is three backticks."],
    ], "{§operation-fences} the bare name alone opens; the operand line still refuses");
    assert.deepEqual(warnings("Example:\n```\nKILL (workspace:///notes.md)\n```"), [[2, 0, "`KILL` ran, though its fence was malformed: the opening fence, OP, parameters, and aside share one line."]], "{§fence-pairing} a heading under a bare fence at the top level runs");
    for (const quiet of [
        "Example:\n\t````KILL (notes.md)\n\t````\n    KILL (notes.md)",
        "To delete it you would issue KILL (notes.md) yourself.",
        "NOTE: remember the hash.",
        "js is installed; sh works too.",
        "````SEND\nKILL (workspace:///inside-a-body.md)\n````",
    ]) assert.deepEqual(warnings(quiet), [], JSON.stringify(quiet));
});
});

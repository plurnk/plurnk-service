import test, { describe } from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";
import { writtenOp, type FindStatement, type ReadStatement } from "@plurnk/plurnk-contracts";

describe("PlurnkParser", () => {
test("{§fence-pairing}: canonical frames close on their own line and preserve ordinary nested code", () => {
    assert.equal(PlurnkParser.frame("READ (note.md)", null), "```READ (note.md)\n```");
    const body = "```json\n{\"ok\":true}\n```";
    assert.equal(PlurnkParser.frame("SEND", body), `\`\`\`\`SEND\n${body}\n\`\`\`\``);
    const nested = "````SEND\n" + body + "\n````";
    // {§operation-fences} — a body holding a four-backtick heading is framed one wider.
    assert.equal(PlurnkParser.frame("EDIT (example.md)", nested), "`````EDIT (example.md)\n" + nested + "\n`````");
});

test("{§fence-pairing}: inline input remains legal but is never the canonical rendering", () => {
    const parsed = PlurnkParser.parse("````READ (note.md) <1,-1> <!-- inspect note -->````");
    assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    const rendered = PlurnkParser.stringify(statements);
    assert.equal(rendered, "```READ (note.md) <1,-1> <!-- inspect note -->\n```");
    const reparsed = PlurnkParser.parse(rendered);
    assert.deepEqual(reparsed.items, parsed.items);
});

test("{§fence-pairing}: programs separate fenced operations without changing body whitespace", () => {
    const body = "# Example\n\n````sh\necho 42\n````\n";
    const blocks = [
        PlurnkParser.frame("READ (note.md)", null),
        PlurnkParser.frame("EDIT (example.md)", body),
        PlurnkParser.frame("SEND", "The edit is ready for verification."),
    ];
    const parsed = PlurnkParser.parse(blocks.join("\n"));
    assert.ok(parsed.items.every((item) => item.kind === "statement"));
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    const source = PlurnkParser.stringify(statements);
    assert.equal(source, blocks.join("\n\n"));
    const reparsed = PlurnkParser.parse(source);
    assert.deepEqual(reparsed.items.map((item) => item.kind), ["statement", "statement", "statement"]);
    const edit = reparsed.items[1];
    assert.equal(edit?.kind === "statement" && edit.statement.op === "EDIT" ? edit.statement.body : null, body);
});

test("{§operation-fences} framing a large body does not spread its backtick runs into function arguments", () => {
    const body = "`quoted` ".repeat(100_000);
    assert.equal(PlurnkParser.frame("EDIT (large.md)", body), "```EDIT (large.md)\n" + body + "\n```");
});

test("{§operation-fences} quoted programs are exact body content without speculative diagnostics", () => {
    const body = "````sh\necho hello\n````\n## PLAN_\n### READ_ (example.md)";
    const input = PlurnkParser.frame("SEND", body) + "\n" + PlurnkParser.frame("NOTE", "Example delivered.");
    const parsed = PlurnkParser.parse(input);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const send = parsed.items.find((item) => item.kind === "statement" && item.statement.op === "SEND");
    assert.equal(send?.kind === "statement" && send.statement.op === "SEND" ? send.statement.body?.raw : null, body);
});

test("{§operation-fences} an unfinished wider body ends at the next known heading; the wider fence holds it only while it closes", () => {
    const unfinished = PlurnkParser.parseStatements("````READ (before.md)````\n````EDIT (notes.md)\n```sh\necho literal\n```");
    assert.deepEqual(unfinished.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []), ["READ", "EDIT", "sh"]);
    assert.equal(unfinished.unparsedTail, undefined);
    const closed = PlurnkParser.parseStatements("````READ (before.md)````\n````EDIT (notes.md)\n```sh\necho literal\n```\n````");
    assert.deepEqual(closed.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []), ["READ", "EDIT"]);
    const edit = closed.items.find((item) => item.kind === "statement" && item.statement.op === "EDIT");
    assert.equal(edit?.kind === "statement" && edit.statement.op === "EDIT" ? edit.statement.body : null, "```sh\necho literal\n```");
});

test("{§whitespace-contract}: prose and operation-shaped text stay literal, without guessing intent", () => {
    const executors = ["sh", "js"];
    for (const source of [
        "The answer is 42.\n\n```rust\nconst x = 1;\n```",
        "Example:\n\n```text\n````READ (x.md\n````\n```",
        "I will look.\n\n    ```FIND (ledger.md) /shutdown/i\n    ```",
        "Thinking.\n\n    ```NOTE\nhello\n    ```",
        "Run:\n\n    ```sh (x)\nnpm test\n    ```",
        "sh [{\"cwd\":\"/\"}]",
        "### log:///1/2/3/READ\n{}",
    ]) {
        const parsed = PlurnkParser.parse(source, { executors });
        assert.deepEqual(parsed.items.filter((item) => item.kind === "statement"), []);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "text" ? [item.content] : []), [source]);
    }
});

test("{§whitespace-contract}: an operation written without its fence is not response text; the prose beside it is", () => {
    // A column-zero line that opens with an operation's name and anything else is the unfenced
    // shape, whether an operand or a sentence follows ("KILL The answer…" in the declaration).
    for (const [source, texts] of [
        ["Let me look.\nREAD (x.md)", ["Let me look.\n"]],
        ["READ the file first, then decide.\nsh is a shell.", ["sh is a shell."]],
    ] as const) {
        const parsed = PlurnkParser.parse(source, { executors: ["sh", "js"] });
        assert.deepEqual(parsed.items.filter((item) => item.kind === "statement"), [], source);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "text" ? [item.content] : []), [...texts], source);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []),
            ["Unfenced `READ` ignored."], source);
    }
});

test("{§operation-fences}: three backticks open an operation and draw nothing; ordinary code stays prose", () => {
    const warnings = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items.flatMap((item) =>
        item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
    const statements = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items.filter((item) => item.kind === "statement").length;
    assert.equal(statements("```READ (notes.md)\n```\n\n```sh\nnpm test\n```"), 2, "three backticks open an operation");
    assert.deepEqual(warnings("```READ (notes.md)\n```"), [], "the taught width draws nothing");
    assert.deepEqual(warnings("```sh\nnpm test\n```"), []);
    assert.deepEqual(warnings("````READ (notes.md)\n````"), [], "a wider fence is the same statement");
    assert.equal(statements("````READ (notes.md)\n````"), 1);
    assert.deepEqual(warnings("The config:\n\n```ts\nexport default {};\n```"), [], "an ordinary code block draws nothing");
    // {§fence-pairing} — an operation inside an unlabeled code block is shown, not run; it is told once.
    assert.deepEqual(warnings("Example:\n\n````\n```READ (notes.md)\n```\n````"), ["`READ` inside a code block was shown, not run."]);
    assert.deepEqual(warnings("```\n```READ (notes.md)\n```"), ["`READ` inside a code block was shown, not run."], "a same-width wrapper is told the same");
    assert.deepEqual(warnings("    ```READ (notes.md)\n    ```"), [], "the taught offset draws nothing");
    assert.deepEqual(warnings("```plurnk\n```READ (notes.md)\n```\n```"), [], "a labeled code block is an example by declaration");
    assert.deepEqual(warnings("````typo (x)\n````"), [], "an explicit invocation is resolved at dispatch");
    assert.deepEqual(warnings("````typo\n````"), [], "an unknown name without a slot is a code block at any width");
    assert.equal(statements("````typo (x)\n````"), 1);
});

test("{§whitespace-contract}: an executor's name with an operand slot did not run either; inside a sentence it is a word", () => {
    const parse = (source: string) => PlurnkParser.parse(source, { executors: ["sh", "gitea"] });
    const warnings = (source: string) => parse(source).items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
    const texts = (source: string) => parse(source).items.flatMap((item) => item.kind === "text" ? [item.content] : []);
    const call = 'gitea (list_issues) <!-- List issues -->\n{"owner": "plurnk"}';
    assert.deepEqual(warnings(call), ["Unfenced `gitea` ignored."]);
    assert.deepEqual(texts(call), ['{"owner": "plurnk"}'], "the heading line leaves response text; its body line is what remains");
    assert.deepEqual(warnings("sh(build.sh)"), ["Unfenced `sh` ignored."], "a glued operand counts");
    assert.deepEqual(warnings("sh is a shell.\nGitea (list_issues) works too."), ["Unfenced `Gitea` ignored."], "the name inside a sentence is a word; the executor's case rule applies");
    assert.deepEqual(warnings("Use gitea (list_issues) for that."), [], "only at column zero");
});

test("{§fence-pairing} {§fence-pairing}: explicit unknown invocations parse; code blocks remain quoted", () => {
    const parse = (source: string) => PlurnkParser.parse(source, { executors: ["sh"] }).items;
    const runtime = (source: string) => parse(source).flatMap((item) => item.kind === "statement" && "runtime" in item.statement ? [item.statement.runtime] : []);
    assert.ok(parse('```OP (gitea) (search_issues)\n{"query": "open"}\n```').some((item) =>
        item.kind === "error" && item.error.message === "op accepts one `(program)` path at most once"));
    assert.deepEqual(runtime("```Read (notes.md)\n```"), ["read"], "native names remain case-sensitive");
    assert.deepEqual(runtime("```OP (gitea)```"), ["op"], "the inline form is also an invocation");
    for (const source of ["```python\nprint(1)\n```", "~~~OP (x)\n~~~", "    ```OP (x)\n    ```"]) {
        assert.deepEqual(runtime(source), []);
        assert.deepEqual(parse(source).filter((item) => item.kind === "error" && item.error.severity === "warning"), []);
    }
});

test("{§fence-pairing}: at the top level, an operation heading under a bare fence runs, with one warning", () => {
    const parse = (source: string) => PlurnkParser.parse(source, { executors: ["sh", "gitea"] }).items;
    const ran = (source: string) => parse(source).flatMap((item) => item.kind === "statement" ? [item.statement.op ?? (item.statement as { runtime?: string }).runtime] : []);
    const warnings = (source: string) => parse(source).flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
    const malformed = (tag: string) => `\`${tag}\` ran, though its fence was malformed: the opening fence, OP, parameters, and aside share one line.`;
    assert.deepEqual(ran("```\nREAD (notes.md) <1,-1>\n```"), ["READ"]);
    assert.deepEqual(warnings("```\nREAD (notes.md) <1,-1>\n```"), [malformed("READ")]);
    assert.deepEqual(ran("```\nNOTE\nDone.\n```"), ["NOTE"], "a native name alone qualifies");
    assert.deepEqual(warnings("```\nNOTE\nDone.\n```"), [malformed("NOTE")]);
    assert.deepEqual(ran("```\ngitea (list_issues)\n{\"owner\": \"plurnk\"}\n```"), ["gitea"], "an executor with its operand");
    assert.deepEqual(warnings("```\nsh\n$ npm test\n```"), [], "an executor's bare name is a word in a transcript");
    assert.deepEqual(warnings("```\ndef f():\n    pass\n```"), [], "a code snippet draws nothing");
    assert.deepEqual(ran("```text\nREAD (notes.md)\n```"), [], "a labeled block is an example by declaration");
    assert.deepEqual(ran("```NOTE\nshown:\n```\nREAD (x)\n```\n```"), ["NOTE"], "inside a body the same shape stays literal");
    assert.deepEqual(warnings("```\n```READ (notes.md)\n```\n```"), ["`READ` inside a code block was shown, not run."], "a fenced example inside keeps its own receipt");
});

test("{§parse-recovery} a refused statement carries its attempt, its verb and its text as written; a diagnostic outside every statement carries none", () => {
    const attempts = (source: string) => PlurnkParser.parse(source).items
        .flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.attempt ?? null] : []);
    assert.deepEqual(attempts("````READ (a.md) <1,\n````"), [{ verb: "READ", text: "````READ (a.md) <1,\n````" }, null],
        "the refused READ as written; the turn's absence of an operation refuses no statement");
    assert.deepEqual(attempts("````sh\necho hi\n````\n````FIND (*.md) <x>\n````"), [{ verb: "FIND", text: "````FIND (*.md) <x>\n````" }],
        "a sibling that parsed leaves the refusal its own attempt");
    assert.deepEqual(attempts("````READ (b.md\n````")[0], { verb: "READ", text: "````READ (b.md\n" }, "an unclosed slot is read as far as the parser read it");
});
});

describe("matcher-refusal", () => {
const parse = (source: string) => {
    const parsed = PlurnkParser.parse(source);
    const errors = parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []);
    const warnings = parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    return { errors, warnings, statements, items: parsed.items };
};
const matcherOf = (statement: FindStatement | ReadStatement) => statement.matcher;

test("{§matcher-prefix-claims}: a matcher the parser cannot read is admitted with its statement, carrying the diagnostic and the working form; siblings stand", () => {
    const { errors, warnings, statements } = parse("```FIND (tests/migrations/test_writer.py) /Enum/{5,40} <!-- enum test regions -->\n```\n\n```NOTE\nnext\n```");
    assert.deepEqual(errors, [], "no parse error: the fumble is not a contract violation");
    assert.deepEqual(warnings, []);
    assert.deepEqual(statements.map(({ op }) => op), ["FIND", "NOTE"]);
    const matcher = matcherOf(statements[0] as FindStatement);
    if (matcher?.dialect !== "unreadable") assert.fail("the matcher is unreadable");
    assert.equal(matcher.raw, "/Enum/{5,40}");
    assert.match(matcher.message, /^pattern leads with `\/` but is not a valid `\/pattern\/flags` regex - Invalid flags/u);
    assert.match(matcher.recovery, /^A pattern is a regex written `\/pattern\/flags`/u);
    assert.equal((statements[0] as FindStatement).aside, "enum test regions", "the aside is still the aside");
});

test("{§matcher-prefix-claims} {§fence-pairing}: an unreadable matcher renders back as written and reparses equal", () => {
    for (const source of ["```FIND (a.py) /Enum/{5,40}\n```", "```READ (a.py) /set_ticks|set_ticklabels/_/\n```", "```READ (a.md) //[bad\n```"]) {
        const parsed = PlurnkParser.parse(source);
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements.length, 1, source);
        assert.equal(PlurnkParser.stringify(statements), source);
        assert.deepEqual(PlurnkParser.parse(PlurnkParser.stringify(statements)).items, parsed.items);
    }
});

test("{§matcher-prefix-claims}: grep's `\\|` is alternation, `-i` after the slash is the flag, a glob-shaped pattern is its glob over the line; one advisory each, and a compiling regex is never rewritten", () => {
    const alternation = parse("```FIND (django/forms/forms.py) /render\\|_html_output\\|get_context/\n```");
    assert.deepEqual(alternation.errors, []);
    const read = matcherOf(alternation.statements[0] as FindStatement);
    assert.deepEqual(read?.dialect === "regex" ? [read.pattern, read.flags, read.raw] : null, ["render|_html_output|get_context", "", "/render\\|_html_output\\|get_context/"]);
    assert.deepEqual(alternation.warnings, ["`\\|` was read as alternation, `|`; a literal pipe is `[|]`."]);

    const flags = parse("```FIND (django/db/models/*) /collector/ -i\n```");
    assert.deepEqual(flags.errors, []);
    const flagged = matcherOf(flags.statements[0] as FindStatement);
    assert.deepEqual(flagged?.dialect === "regex" ? [flagged.pattern, flagged.flags] : null, ["collector", "i"]);
    assert.deepEqual(flags.warnings, ["`-i` after the pattern was read as the flags `i`; flags go right after the closing `/`."]);

    for (const [source, pattern] of [
        ["```FIND (sklearn/decomposition/tests/) /*kernel_pca*/\n```", ".*kernel_pca.*"],
        ["```FIND (sklearn/decomposition/kernel_pca.py) /*/\n```", ".*"],
        ["```FIND (sympy/printing/**/*.py) /**/\n```", ".*"],
    ] as const) {
        const glob = parse(source);
        assert.deepEqual(glob.errors, [], source);
        const body = matcherOf(glob.statements[0] as FindStatement);
        assert.equal(body?.dialect === "regex" ? body.pattern : null, pattern, source);
        assert.equal(glob.warnings.length, 1, source);
        assert.match(glob.warnings[0], /was read as the glob .* over each line/u, source);
    }

    const plain = parse("```FIND (a.py) /a*b|c/i\n```");
    const kept = matcherOf(plain.statements[0] as FindStatement);
    assert.deepEqual(kept?.dialect === "regex" ? [kept.pattern, kept.flags] : null, ["a*b|c", "i"]);
    assert.deepEqual(plain.warnings, [], "a regex that compiles is never rewritten");
    const literalPipe = parse("```FIND (a.py) /a[|]b/\n```");
    assert.equal(matcherOf(literalPipe.statements[0] as FindStatement)?.dialect, "regex");
    assert.deepEqual(literalPipe.warnings, []);
});
});

describe("metadata-order", () => {
const parse = (heading: string, body: string | null = null) => {
    const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(heading, body), { executors: ["sh", "gitea"] });
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), [], heading);
    assert.equal(parsed.unparsedTail, undefined, heading);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

test("{§slot-order}: SEND accepts completion metadata before its message path", () => {
    const result = PlurnkParser.parse("```SEND [200] (message://dogfood04/6094c6e9)\nFinal deliverable\n```");
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    const statement = statements[0];
    assert.equal(statement.op, "SEND");
    assert.equal(statement.target?.raw, "message://dogfood04/6094c6e9");
    assert.deepEqual(statement.metadata, ["200"]);
    assert.deepEqual(statement.body, { raw: "Final deliverable", json: null });
});

for (const op of ["FIND", "READ", "EDIT", "KILL", "SEND", "sh", "gitea"]) {
    test(`{§slot-order}: ${op} accepts metadata before or after its path/scope pair`, () => {
        const metadata = '[{"request":{"value":"]"}}]';
        const body = op === "EDIT" || op === "SEND" || op === "sh" || op === "gitea" ? "literal body" : null;
        const canonical = parse(`${op} (item) <1,3> ${metadata}`, body);
        for (const slots of [
            `${metadata} (item) <1,3>`,
            `(item) ${metadata} <1,3>`,
            `${metadata}(item)<1,3>`,
        ]) assert.deepEqual(parse(`${op} ${slots}`, body), canonical, slots);
    });
}

for (const op of ["FIND", "READ", "EDIT", "KILL"]) {
    test(`{§slot-order}: ${op} retains single-path scope-first tolerance around metadata`, () => {
        const metadata = '[{"keep":1}]';
        const canonical = parse(`${op} (item) <1,3> ${metadata}`);
        for (const slots of [
            `${metadata} <1,3> (item)`,
            `<1,3> ${metadata} (item)`,
            `<1,3> (item) ${metadata}`,
        ]) assert.deepEqual(parse(`${op} ${slots}`), canonical, slots);
    });
}

for (const op of ["BARE", "WORK", "FORK", "WAIT"]) {
    test(`{§slot-order}: ${op} accepts leading metadata without changing its body`, () => {
        const metadata = op === "WAIT" ? "[60]" : '[{"x":1}]';
        assert.deepEqual(parse(`${op} ${metadata} (session://child)`, "literal body"),
            parse(`${op} (session://child) ${metadata}`, "literal body"));
    });
}

test("{§slot-order}: prefix and suffix blocks retain exact bytes in authored order", () => {
    const statements = parse('READ [opaque] (item) <1> [{"x": [1,2]}]');
    assert.ok(statements[0]?.op === "READ");
    assert.deepEqual(statements[0].metadata, ["opaque", '{"x": [1,2]}']);
    assert.deepEqual(statements, parse('READ (item) <1> [opaque] [{"x": [1,2]}]'));
});

test("{§slot-order} {§op-shapes}: reasoning uses the same metadata binding", () => {
    const canonical = ["FIND (item) <1,3> /needle/", "READ (item) <4,6> [{\"keep\":1}]"];
    const reordered = ["FIND (item) <1,3> /needle/", "READ [{\"keep\":1}] (item) <4,6>"];
    const program = (headings: string[]) => headings.map((heading) => PlurnkParser.frame(heading, null)).join("\n\n");
    const warnings: string[] = [];
    const statements = PlurnkParser.parseReasoningOperations(program(reordered), (warning) => warnings.push(warning.message));
    assert.equal(statements.length, 2);
    assert.deepEqual(statements, PlurnkParser.parseReasoningOperations(program(canonical)));
    assert.deepEqual(warnings, []);
});

test("{§slot-order}: metadata ordering does not add NOTE metadata", () => {
    const parsed = PlurnkParser.parse("```NOTE [200]\nliteral body\n```");
    assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "error"));
    assert.equal(parsed.items.some((item) => item.kind === "statement"), false);
});
});

describe("selection-binding", () => {
const parse = (heading: string) => PlurnkParser.parse(`\`\`\`${heading}\n\`\`\``);
const statements = (heading: string) => {
    const parsed = parse(heading);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], heading);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

for (const op of ["READ", "KILL"] as const) {
    test(`{§slot-order}: ${op} compiles each path with its own scope and metadata`, () => {
        for (const heading of [
            `${op} (a)<1,3>[{"keep":1}](b)[{"keep":2}]<4,6>`,
            `${op} (a) [{"keep":1}] <1,3> (b) <4,6> [{"keep":2}]`,
            `${op} [{"keep":1}] (a) <1,3> (b) <4,6> [{"keep":2}]`,
        ]) {
            const ops = statements(heading);
            assert.equal(ops.length, 2);
            assert.deepEqual(ops.map((statement) => {
                assert.equal(statement.op, op);
                assert.ok(statement.op === "READ" || statement.op === "KILL");
                assert.equal("group" in statement, false, "the AST has one representation per selection");
                return [statement.target?.raw, statement.lineMarker?.marks, statement.metadata];
            }), [["a", [1, 3], ['{"keep":1}']], ["b", [4, 6], ['{"keep":2}']]]);
        }
    });

    test(`{§slot-order}: ${op} applies the naked matcher to every member independently of member options`, () => {
        for (const own of [0, 1]) {
            const paths = ["a", "b"].map((path, index) => `(${path})${index === own ? ' [{"keep":1}]' : ""}`).join(" ");
            const ops = statements(`${op} ${paths} /shared/`);
            assert.deepEqual(ops.map((statement) => {
                assert.ok(statement.op === "READ" || statement.op === "KILL");
                return [statement.target?.raw, statement.matcher?.raw, statement.metadata];
            }), [["a", "/shared/", own === 0 ? ['{"keep":1}'] : null], ["b", "/shared/", own === 1 ? ['{"keep":1}'] : null]]);
        }
    });

    test(`{§parse-recovery}: ${op} refuses ambiguous scope relocation without executing any group member`, () => {
        const parsed = PlurnkParser.parse(`\`\`\`${op} (a) (b) /pattern/ <1,3>\n\`\`\`\n\n\`\`\`NOTE\nsibling retained\n\`\`\``);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["NOTE"]);
        const errors = parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error");
        assert.equal(errors.length, 1);
        assert.ok(errors[0]?.kind === "error");
        assert.equal(errors[0].error.message, "The scope `<1,3>` follows the shared pattern of a target group.");
        assert.equal(errors[0].error.recovery, "In a target group each `(path)` carries its own scope and option block, and the one shared pattern comes last.");
        assert.equal(parsed.items.some((item) => item.kind === "error" && item.error.severity === "warning"), false, "no false claim that the scope was applied");
    });

    test(`{§parse-recovery}: ${op} retains unambiguous single-path scope recovery`, () => {
        const parsed = parse(`${op} (a) /pattern/ <1,3>`);
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
        const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(ops.length, 1);
        assert.ok(ops[0]?.op === op);
        assert.equal(ops[0].target?.raw, "a");
        assert.deepEqual(ops[0].lineMarker, { marks: [1, 3] });
        assert.equal(ops[0].matcher?.raw, "/pattern/");
        assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "warning"));
    });
}

for (const op of ["COPY", "MOVE"] as const) {
    test(`{§op-shapes}: ${op} keeps both operand pairs through adjacency and metadata order`, () => {
        for (const heading of [
            `${op} (a)<1,3>[{"first":1}](b)[{"second":2}]<4,6>`,
            `${op} (a) [{"first":1}] <1,3> (b) <4,6> [{"second":2}]`,
            `${op} [{"first":1}] (a) <1,3> (b) <4,6> [{"second":2}]`,
        ]) {
            const ops = statements(heading);
            assert.equal(ops.length, 1);
            assert.ok(ops[0]?.op === op);
            assert.deepEqual([ops[0].source, ops[0].destination].map(({ target, lineMarker, metadata }) =>
                [target.raw, lineMarker?.marks, metadata]), [["a", [1, 3], ['{"first":1}']], ["b", [4, 6], ['{"second":2}']]]);
        }
    });
}

for (const op of ["READ", "KILL", "COPY", "MOVE"] as const) {
    test(`{§slot-order}: ${op} binds leading metadata to the first operand and inter-path metadata to the preceding operand`, () => {
        const ops = statements(`${op} [{"first":1}] (a) [{"second":2}] (b) [{"third":3}]`);
        const selections = ops.flatMap((statement) => {
            if (statement.op === "COPY" || statement.op === "MOVE") {
                return [statement.source, statement.destination].map(({ target, metadata }) => [target.raw, metadata]);
            }
            assert.ok(statement.op === "READ" || statement.op === "KILL");
            return [[statement.target?.raw, statement.metadata]];
        });
        assert.deepEqual(selections, [
            ["a", ['{"first":1}', '{"second":2}']],
            ["b", ['{"third":3}']],
        ]);
    });
}
});

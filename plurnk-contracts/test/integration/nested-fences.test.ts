import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type ClientStatement, type ParseResult } from "../../src/index.ts";

const task = PlurnkParser.frame("TASK", '[{"content":"Reported the result.","status":"completed"}]');
const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const bodyText = (op: ClientStatement) => "body" in op && typeof op.body === "object" && op.body !== null && "raw" in op.body ? op.body.raw : "body" in op ? op.body : null;

for (const [name, parse] of [
    ["model", PlurnkParser.parse],
    ["statements", PlurnkParser.parseStatements],
    ["log", PlurnkParser.parseLog],
    ["client", PlurnkParser.parseClient],
] as const) {
    test(`{§numeric-delimiter}: ${name} keeps a report holding same-width blocks intact under a delimited SEND`, () => {
        const body = [
            "The process reversed the supplied bytes.",
            '````node [{"stdin": "open"}]',
            'process.stdin.on("data", value => process.stdout.write(value));',
            "````",
            "The input was delivered with:",
            '````SEND (node:///ab3d5678) [{"eof": true}]',
            "oranges",
            "````",
            "Observed stdout: segnaro. No further input is needed.",
        ].join("\n");
        const result = parse(`\`\`\`\`42SEND\n${body}\n\`\`\`\`42\n\n${task}`);
        assert.equal(result.unparsedTail, undefined);
        assert.deepEqual(errors(result), []);
        const ops = statements(result);
        assert.deepEqual(ops.map(({ op }) => op), ["SEND", "TASK"]);
        assert.ok(ops[0].op === "SEND");
        assert.equal(ops[0].target, null);
        assert.equal(bodyText(ops[0]), body);
        assert.deepEqual(bodyText(ops[1]), [{ content: "Reported the result.", status: "completed" }]);
    });
}

test("{§fence-closer}: a shorter inner fence is body and an equal or longer bare fence closes an undelimited block", () => {
    const shorter = PlurnkParser.parse("````SEND\nCode:\n```ts\nconst value = 42;\n```\nDone.\n````\n" + task);
    assert.deepEqual(errors(shorter), []);
    assert.equal(bodyText(statements(shorter)[0]), "Code:\n```ts\nconst value = 42;\n```\nDone.");
    const equal = PlurnkParser.parse("````SEND\nCode:\n````\nAfter the closer.\n" + task);
    assert.deepEqual(errors(equal), []);
    assert.deepEqual(statements(equal).map(({ op }) => op), ["SEND", "TASK"]);
    assert.equal(bodyText(statements(equal)[0]), "Code:");
    const longer = PlurnkParser.parse("```SEND\nCode:\n`````\n" + task);
    assert.deepEqual(errors(longer), []);
    assert.equal(bodyText(statements(longer)[0]), "Code:");
});

test("{§numeric-delimiter}: nesting preserves exact bodies across widths, depths, newlines, and operation families", () => {
    for (const header of ["SEND", "EDIT (notes.md)", "sh", "BARE", "WORK", "FORK"]) {
        for (const width of [3, 4, 8]) {
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
                    const result = PlurnkParser.parse(`${fence}7${header}${newline}${body}${newline}${fence}7\n${task}`);
                    const context = `${header}, width=${width}, depth=${depth}, newline=${JSON.stringify(newline)}`;
                    assert.equal(result.unparsedTail, undefined, context);
                    assert.deepEqual(errors(result), [], context);
                    const ops = statements(result);
                    assert.deepEqual(ops.map(({ op }) => op), [header === "sh" ? "EXEC" : header.split(" ")[0], "TASK"], context);
                    assert.equal(bodyText(ops[0]), body, context);
                }
            }
        }
    }
});

test("{§numeric-delimiter}: a bare fence never closes a delimited block and a foreign delimiter never closes it either", () => {
    const body = "````\n````9\nstill body";
    const result = PlurnkParser.parse(`\`\`\`\`42EDIT (notes.md)\n${body}\n\`\`\`\`42\n${task}`);
    assert.deepEqual(errors(result), []);
    assert.equal(bodyText(statements(result)[0]), body);
    const bare = PlurnkParser.parse("````EDIT (notes.md)\nbody\n````42\nmore\n````\n" + task);
    assert.deepEqual(errors(bare), []);
    assert.equal(bodyText(statements(bare)[0]), "body\n````42\nmore", "a delimited fence is body inside a bare block");
});

test("{§fence-heading-in-body}: a four-backtick heading ends an undelimited block and opens the next statement", () => {
    const source = "````READ (safe.md)````\n````EDIT (notes.md)\n````sh\nnot the edit\n````\n````TASK\n[]\n````";
    const result = PlurnkParser.parseStatements(source);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(statements(result).map(({ op }) => op), ["READ", "EDIT", "EXEC", "TASK"]);
    assert.equal(bodyText(statements(result)[1]), null, "the EDIT ended at the sh heading with nothing left over");
    assert.equal(bodyText(statements(result)[2]), "not the edit");
});

test("{§fence-heading-in-body}: a closer glued to the next opener never swallows the turn", () => {
    const glued = "````READ (a.md) <1,-1>\n````````READ (b.md) <1,-1>\n````````EDIT (c.md) <@abcde>\nreplacement\n````";
    const result = PlurnkParser.parse(glued + "\n" + task);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(statements(result).map(({ op }) => op), ["READ", "READ", "EDIT", "TASK"]);
    assert.equal(bodyText(statements(result)[2]), "replacement");
});

test("{§fence-heading-in-body}: a three-backtick executor line inside a four-backtick block is body", () => {
    const body = "```sh\necho sample\n```";
    const result = PlurnkParser.parse(`\`\`\`\`EDIT (README.md)\n${body}\n\`\`\`\`\n${task}`);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(({ op }) => op), ["EDIT", "TASK"]);
    assert.equal(bodyText(statements(result)[0]), body);
});

test("{§fence-heading-in-body}: the host names its executors and unknown tags stay body", () => {
    const source = "````EDIT (notes.md)\n````node\nconsole.log(1)\n````\n" + task;
    const unknown = PlurnkParser.parse(source);
    assert.deepEqual(statements(unknown).map(({ op }) => op), ["EDIT", "TASK"]);
    assert.equal(bodyText(statements(unknown)[0]), "````node\nconsole.log(1)");
    const known = PlurnkParser.parse(source, { executors: ["node"] });
    assert.deepEqual(statements(known).map(({ op }) => op), ["EDIT", "EXEC", "TASK"]);
});

test("{§closer-fallback}: a block ended by a heading or the end of input keeps its body up to its last bare fence", () => {
    const byHeading = PlurnkParser.parse("````EDIT (a.md)\nline one\n```\nprose after a short closer\n````READ (b.md)\n" + task);
    assert.deepEqual(errors(byHeading), []);
    assert.deepEqual(statements(byHeading).map(({ op }) => op), ["EDIT", "READ", "TASK"]);
    assert.equal(bodyText(statements(byHeading)[0]), "line one");
    const byEof = PlurnkParser.parseStatements("````EDIT (a.md)\nline one\nline two");
    assert.equal(byEof.unparsedTail, undefined);
    assert.equal(bodyText(statements(byEof)[0]), "line one\nline two");
    const emptyByEof = PlurnkParser.parseStatements("````READ (a.md)");
    assert.equal(emptyByEof.unparsedTail, undefined);
    assert.deepEqual(statements(emptyByEof).map(({ op }) => op), ["READ"]);
});

test("{§fence-boundary}: shell heredoc Markdown and complete inline examples are not additional operations", () => {
    const body = "cat <<'EOF'\n````json\n{\"ok\":true}\n````\n````READ (notes.md)````\nEOF";
    const result = PlurnkParser.parse(PlurnkParser.frame("sh", body) + "\n" + task);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(({ op }) => op), ["EXEC", "TASK"]);
    assert.equal(bodyText(statements(result)[0]), body);
});

test("{§statement-rendering}: a wider canonical wrapper preserves arbitrary unfinished and unlabeled examples", () => {
    for (const body of ["````sh\nunfinished", "````not a closer", "````\nunlabeled\n````", "````js\n````sh\nunfinished twice"]) {
        const result = PlurnkParser.parse(PlurnkParser.frame("EDIT (notes.md)", body) + "\n" + task);
        assert.equal(result.unparsedTail, undefined, body);
        assert.deepEqual(errors(result), [], body);
        assert.deepEqual(statements(result).map(({ op }) => op), ["EDIT", "TASK"], body);
        assert.equal(bodyText(statements(result)[0]), body, body);
    }
});

test("{§statement-rendering}: frame adds a numeric delimiter exactly when the body holds a four-backtick heading", () => {
    assert.equal(PlurnkParser.frame("EDIT (a.md)", "```sh\nx\n```"), "````EDIT (a.md)\n```sh\nx\n```\n````");
    const framed = PlurnkParser.frame("EDIT (a.md)", "````READ (b.md)\n````");
    assert.match(framed, /^`````42EDIT \(a\.md\)\n````READ \(b\.md\)\n````\n`````42$/u);
    const reparsed = PlurnkParser.parseStatements(framed);
    assert.deepEqual(statements(reparsed).map(({ op }) => op), ["EDIT"]);
    assert.equal(bodyText(statements(reparsed)[0]), "````READ (b.md)\n````");
});

test("{§inline-chain}: a closer followed by the next opener on the same line closes and opens", () => {
    const source = "Reviewing the state. ````READ (a.ts) <1,30> <!-- imports --> ```` ````READ (a.ts) <140,245> <!-- picker --> ```` ````READ (b.ts) <1,-1> ````\n" + task;
    const result = PlurnkParser.parse(source);
    assert.equal(result.unparsedTail, undefined);
    assert.deepEqual(errors(result).filter(({ severity }) => severity === "error"), []);
    assert.deepEqual(statements(result).map(({ op }) => op), ["READ", "READ", "READ", "TASK"]);
    const marks = statements(result).slice(0, 3).map((op) => (op as { lineMarker?: { marks: unknown[] } | null }).lineMarker?.marks);
    assert.deepEqual(marks, [[1, 30], [140, 245], [1, -1]]);
});

test("{§anchor-digits}: `@` with one to four digits is that line, with one advisory; five characters stay an anchor", () => {
    const result = PlurnkParser.parseStatements("````EDIT (a.ts) <@210,@211>\nx\n````\n````EDIT (a.ts) <@ab12c>\ny\n````");
    const ops = statements(result);
    assert.deepEqual(ops.map(({ op }) => op), ["EDIT", "EDIT"]);
    assert.deepEqual((ops[0] as { lineMarker: { marks: unknown[] } }).lineMarker.marks, [210, 211]);
    assert.deepEqual((ops[1] as { lineMarker: { marks: unknown[] } }).lineMarker.marks, ["@ab12c"]);
    const advisories = errors(result);
    assert.equal(advisories.length, 2);
    assert.ok(advisories.every(({ severity }) => severity === "warning"));
    assert.match(advisories[0].message, /`@210` was read as line 210; an anchor is five characters/u);
});

test("{§unclosed-aside}: an aside that never closes on its line is the aside to the end of the line, with one advisory", () => {
    const result = PlurnkParser.parseStatements("````EDIT (a.rs) <1,-1> <!-- full rewrite: ErrorInner{kind,cored}\nbody\n````");
    const ops = statements(result);
    assert.deepEqual(ops.map(({ op }) => op), ["EDIT"]);
    assert.equal((ops[0] as { aside: string | null }).aside, "full rewrite: ErrorInner{kind,cored}");
    assert.equal((ops[0] as { body: string | null }).body, "body");
    const advisories = errors(result);
    assert.deepEqual(advisories.map(({ severity }) => severity), ["warning"]);
    assert.match(advisories[0].message, /not closed with `-->`; it was read to the end of the line/u);
    const closed = PlurnkParser.parseStatements("````READ (a.rs) <!-- ok --> ````");
    assert.deepEqual(errors(closed), []);
    assert.equal((statements(closed)[0] as { aside: string | null }).aside, "ok");
});

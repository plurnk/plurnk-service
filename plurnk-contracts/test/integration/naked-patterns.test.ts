import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type ClientStatement, type ParseResult } from "../../src/index.ts";

const statements = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const diagnostics = (result: ParseResult<ClientStatement>) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const one = (source: string) => {
    const result = PlurnkParser.parseStatements(source);
    const ops = statements(result);
    assert.equal(ops.length, 1, source);
    return { op: ops[0]! as ClientStatement & { matcher?: { dialect: string; raw: string } | null; body?: unknown; metadata?: unknown }, diagnostics: diagnostics(result) };
};

test("{§naked-pattern}: `^` claims the regex dialect without slashes, and a trailing aside on the same line stays the aside", () => {
    const { op, diagnostics: notes } = one("````READ (reasoning:///1/1) ^NOTE:.* <!-- pluck notes from this turn's reasoning -->\n````\n");
    assert.deepEqual(notes, []);
    assert.deepEqual(op.matcher, { dialect: "regex", raw: "^NOTE:.*", pattern: "^NOTE:.*", flags: "" });
    assert.equal(op.aside, "pluck notes from this turn's reasoning");
    assert.equal(op.metadata, null);
    assert.equal(PlurnkParser.stringify([op]), "````READ (reasoning:///1/1) ^NOTE:.* <!-- pluck notes from this turn's reasoning -->\n````");
    const slash = one("````READ (notes.md) /NOTE:.*/i <!-- the slash spelling keeps its flags -->\n````\n");
    assert.deepEqual(slash.diagnostics, []);
    assert.deepEqual(slash.op.matcher, { dialect: "regex", raw: "/NOTE:.*/i", pattern: "NOTE:.*", flags: "i" });
    assert.equal(slash.op.aside, "the slash spelling keeps its flags");
    const broken = PlurnkParser.parseStatements("````READ (notes.md) ^(unclosed\n````\n");
    assert.match(diagnostics(broken)[0]?.message ?? "", /pattern leads with `\^` but is not a valid regex/u);
});

test("{§naked-pattern}: a sigil-less glob or literal on the heading line is the matcher on FIND, READ and KILL, silently", () => {
    for (const [source, raw] of [
        ["````FIND (src/**/*.ts) TODO\n````\n", "TODO"],
        ["````FIND (worker:///) *.test.ts <!-- the suites -->\n````\n", "*.test.ts"],
        ["````READ (worker:///a.md) bats <!-- lines naming bats -->\n````\n", "bats"],
        ["````KILL (log:///1/**) stale receipt\n````\n", "stale receipt"],
    ] as const) {
        const { op, diagnostics: notes } = one(source);
        assert.deepEqual(notes, [], source);
        assert.deepEqual(op.matcher, { dialect: "glob", raw }, source);
        assert.equal(op.body, null);
        assert.equal(PlurnkParser.stringify([op]), source.trimEnd(), "the bare form is the rendered form");
    }
    assert.equal(one("````FIND (worker:///) *.test.ts <!-- the suites -->\n````\n").op.aside, "the suites");
});

test("{§naked-pattern}: on EDIT a heading-line sigil is the matcher and the lines beneath are the replacement; plain heading text stays the body", () => {
    const replace = one("````EDIT (worker:///a.txt) /foo/\nbar\nbaz\n````\n");
    assert.deepEqual(replace.diagnostics, []);
    assert.deepEqual(replace.op.matcher, { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" });
    assert.equal(replace.op.body, "bar\nbaz");
    assert.equal(PlurnkParser.stringify([replace.op]), "````EDIT (worker:///a.txt) /foo/\nbar\nbaz\n````");
    const remove = one("````EDIT (books.xml) //book[price > 35.00] <!-- an empty body removes each match -->\n````\n");
    assert.deepEqual(remove.diagnostics, []);
    assert.deepEqual(remove.op.matcher, { dialect: "xpath", raw: "//book[price > 35.00]" });
    assert.equal(remove.op.body, null);
    assert.equal(remove.op.aside, "an empty body removes each match");
    const literal = one("````EDIT (worker:///a.txt) hello\n````\n");
    assert.equal(literal.op.matcher, null);
    assert.equal(literal.op.body, "hello", "EDIT heading-line text without a sigil is the replacement it always was");
    assert.match(literal.diagnostics[0]?.message ?? "", /body text was on the OP line/u);
    assert.equal(literal.diagnostics[0]?.severity, "warning");
});

test("{§matcher-body-redirect}: text beneath a FIND, READ or KILL heading is still an ignored body with one gentle advisory; the heading line lifts regardless", () => {
    const below = one("````FIND (worker:///src)\nTODO\n````\n");
    assert.equal(below.op.matcher, null);
    assert.equal(below.diagnostics.length, 1);
    assert.equal(below.diagnostics[0]!.severity, "warning");
    assert.equal(below.diagnostics[0]!.message, "FIND takes no body; the body was ignored. A pattern belongs on the opening fence line after the path.");
    const sigilBelow = one("````FIND (worker:///src)\n/TODO/\n````\n");
    assert.deepEqual(sigilBelow.diagnostics, []);
    assert.equal(sigilBelow.op.matcher?.raw, "/TODO/", "one sigil line beneath the heading is the bare form written a line low");
    const both = one("````FIND (worker:///src) TODO\nand a stray second line\n````\n");
    assert.deepEqual(both.op.matcher, { dialect: "glob", raw: "TODO" });
    assert.equal(both.diagnostics.length, 1);
    assert.match(both.diagnostics[0]!.message, /^FIND takes no body/u);
});

test("{§matcher-option}: the option form is still read, and it is the rendered escape when the bare form could not read back", () => {
    const option = one('````READ (worker:///a.md) [{"pattern":"(a|b) or [c]"}]\n````\n');
    assert.deepEqual(option.diagnostics, []);
    assert.deepEqual(option.op.matcher, { dialect: "glob", raw: "(a|b) or [c]" });
    assert.equal(option.op.metadata, null);
    assert.equal(PlurnkParser.stringify([option.op]), '````READ (worker:///a.md) [{"pattern":"(a|b) or [c]"}]\n````', "a matcher opening with `(` cannot ride bare");
    const commented = one('````FIND (worker:///) [{"pattern":"see <!-- this -->"}]\n````\n');
    assert.equal(PlurnkParser.stringify([commented.op]), '````FIND (worker:///) [{"pattern":"see <!-- this -->"}]\n````');
    const reparsed = one(PlurnkParser.stringify([commented.op]) + "\n");
    assert.deepEqual(reparsed.op.matcher, commented.op.matcher);
    const kept = one('````FIND (worker:///) [{"pattern":"~stale","limit":3}]\n````\n');
    assert.deepEqual(kept.op.matcher, { dialect: "fts", raw: "~stale" });
    assert.deepEqual(kept.op.metadata, ['{"pattern":"~stale","limit":3}'], "a block with other keys stays with its owner verbatim");
    assert.equal(PlurnkParser.stringify([kept.op]), '````FIND (worker:///) [{"pattern":"~stale","limit":3}]\n````');
    const transfer = one('````COPY (worker:///a.md) [{"pattern":"/x/"}] (worker:///b.md)\n````\n');
    assert.deepEqual(transfer.diagnostics, []);
    assert.equal(PlurnkParser.stringify([transfer.op]), '````COPY (worker:///a.md) [{"pattern":"/x/"}] (worker:///b.md)\n````', "COPY/MOVE operands keep the option form");
});

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import AstBuilder from "../../src/AstBuilder.ts";
import { PlurnkParser } from "../../src/index.ts";
import { writtenOp, type PlurnkStatement, type ParseResult } from "@plurnk/plurnk-contracts";
import { readFileSync } from "node:fs";
import { classify, CORPUS, localIdentifiers, type CorpusRecord } from "../../scriptify/extract-emission-corpus.ts";

describe("recovery", () => {
const statements = (r: ReturnType<typeof PlurnkParser.parseStatements>) => r.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
const errors = (r: ReturnType<typeof PlurnkParser.parseStatements>) => r.items.flatMap((i) => i.kind === "error" ? [i.error] : []);
const frame = PlurnkParser.frame;
const task = (op = "WAIT") => frame(op, "Observe the results.");
const turn = (...blocks: string[]) => [...blocks, task()].join("\n");

// {§parse-recovery}: a failed statement cannot lend its normalization warnings to another.
for (const [name, header, body] of [
    ["scope", "READ (data.json) <@12> $[", null],
    ["comment annotation", "READ (data.json) $[", "<!-- literal comment -->"],
    ["annotation", "READ (data.json) $[", "retained content"],
] as const) {
    for (const separate of [false, true]) {
        test(`{§matcher-prefix-claims} failed ${name} normalization does not leak advisories into ${separate ? "another parse" : "the next statement"}`, () => {
            const malformed = frame(header, body);
            const valid = frame("READ (data.json) $.ok", null);
            const results = separate
                ? [PlurnkParser.parseStatements(malformed), PlurnkParser.parseStatements(valid)]
                : [PlurnkParser.parseStatements([malformed, valid].join("\n"))];
            // {§matcher-prefix-claims} — the malformed matcher is its statement's own refusal; every advisory the
            // normalization drew stays on that statement's line, and the valid sibling is untouched.
            const diagnostics = results.flatMap(errors);
            assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === "warning" && diagnostic.line === 1), name);
            const admitted = results.flatMap(statements);
            assert.deepEqual(admitted.map(({ op }) => op), body === null ? ["READ", "READ"] : ["NOTE", "READ", "READ"]);
            if (body !== null) assert.equal(admitted[0].op === "NOTE" && admitted[0].body, body);
            const ops = admitted.filter((statement) => statement.op === "READ");
            assert.equal(ops[0].op, "READ");
            const refused = "matcher" in ops[0] ? ops[0].matcher : null;
            if (refused === null || refused === undefined || refused.dialect !== "unreadable") assert.fail(name);
            assert.match(refused.message, /pattern leads with `\$` but is not a valid jsonpath/u);
            assert.equal(ops[1].op, "READ");
            assert.deepEqual("matcher" in ops[1] && ops[1].matcher, { dialect: "jsonpath", raw: "$.ok" });

            const normalized = PlurnkParser.parseStatements(frame("READ (data.json) <@34> $.ok", null));
            assert.deepEqual(normalized.items.map((item) => item.kind), ["statement", "error"]);
            assert.deepEqual(errors(normalized).map((error) => [error.severity, error.message]), [
                ["warning", "`@34` was read as line 34; an anchor is five characters (`@abcde`)."],
            ]);
        });
    }
}

test("{§operation-fences} an internal builder failure propagates without leaking its advisories", (t) => {
    const build = AstBuilder.build;
    const failure = new Error("internal builder failure");
    const mocked = t.mock.method(AstBuilder, "build", (...args: Parameters<typeof build>) => {
        build(...args);
        throw failure;
    });
    assert.throws(() => PlurnkParser.parseStatements(frame("READ (data.json) <@12> $.ok", null)), (error) => error === failure);
    mocked.mock.restore();
    const parsed = PlurnkParser.parseStatements(frame("READ (data.json) $.ok", null));
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(statements(parsed).map(writtenOp), ["READ"]);
});

test("{§matcher-prefix-claims} a scope inside a target is applied with one factual warning per selection", () => {
    const r = PlurnkParser.parse(turn(frame("COPY (workspace:///src.md<2,3>) (workspace:///slice.md<1,-1>)", null), frame("READ (a.ts<4,5>)", null)));
    assert.equal(r.unparsedTail, undefined);
    const errs = errors(r);
    assert.deepEqual(errs.map((e) => [e.line, e.severity]), [[1, "warning"], [1, "warning"], [3, "warning"]]);
    assert.equal(errs[0].message, "The scope was inside the target slot; it was applied as the operation scope.");
    assert.equal(errs[0].column, 28);
    const ops = statements(r);
    assert.deepEqual(ops.map(writtenOp), ["COPY", "READ", "WAIT"]);
    const copy = ops[0];
    assert.ok(copy.op === "COPY");
    assert.equal(copy.source.target.raw, "workspace:///src.md");
    assert.deepEqual(copy.source.lineMarker, { marks: [2, 3] });
    assert.equal(copy.destination.target.raw, "workspace:///slice.md");
    assert.deepEqual(copy.destination.lineMarker, { marks: [1, -1] });
    const read = ops[1];
    assert.ok(read.op === "READ");
    assert.equal(read.target?.raw, "a.ts");
    assert.deepEqual(read.lineMarker, { marks: [4, 5] });
    assert.equal(r.items.findIndex((i) => i.kind === "error"), 1);

    const stray = PlurnkParser.parse(turn(frame("READ (a<b.ts) <1,-1>", null)));
    assert.ok(errors(stray).some((e) => e.severity === "error" && /unrecognized character '<'/.test(e.message)));
});

test("{§operation-fences} conflicting scopes on one resource selection are rejected without affecting the next block", () => {
    for (const header of ["READ (a.ts<1,2>) <3,4>", "COPY (a.ts<1>) <2> (b.ts)", "sh (script.js<5>) <10>"]) {
        const r = PlurnkParser.parse(turn(frame(header, null)));
        assert.equal(r.unparsedTail, undefined, header);
        assert.equal(errors(r).filter((e) => e.severity === "error").length, 1, header);
        assert.deepEqual(statements(r).map(writtenOp), ["WAIT"], header);
    }
});

test("{§matcher-prefix-claims} unclosed metadata does not consume the following WAIT", () => {
    const r = PlurnkParser.parse([frame("READ (b.ts) <1,-1>", null), frame("READ [unclosed (a.ts) <1,-1>", null), task()].join("\n"));
    assert.equal(errors(r).length, 1);
    assert.equal(errors(r)[0].severity, "error");
    assert.match(errors(r)[0].message, /^unexpected closing fence;/u);
    assert.deepEqual(statements(r).map(writtenOp), ["READ", "WAIT"]);
    const send = statements(r).find((s) => s.op === "WAIT");
    assert.equal(send?.op, "WAIT");
    assert.equal(send?.position.line, 5);
});

// {§op-shapes}
test("{§slot-order} bracket metadata belongs to a target, executor, or targetless SEND", () => {
    for (const [header, op, target, metadata] of [
        ["READ (a.ts) [+diff] <1,-1>", "READ", "a.ts", "+diff"],
        ["READ [+diff] (a.ts) <1,-1>", "READ", "a.ts", "+diff"],
        ["KILL (log://**) [memory]", "KILL", "log://**", "memory"],
        ["KILL [memory] (log://**)", "KILL", "log://**", "memory"],
        ['sh (greet.sh) [{"cwd": "sub"}]', "sh", "greet.sh", '{"cwd": "sub"}'],
        ['SEND [{"attachments":["report.pdf"]}]', "SEND", null, '{"attachments":["report.pdf"]}'],
    ] as const) {
        const r = PlurnkParser.parse(turn(frame(header, null)));
        assert.deepEqual(errors(r), [], header);
        assert.equal(r.unparsedTail, undefined, header);
        assert.deepEqual(statements(r).map(writtenOp), [op, "WAIT"], header);
        const [statement] = statements(r);
        if (!("metadata" in statement)) assert.fail(header);
        assert.equal(statement.target?.raw ?? null, target, header);
        assert.deepEqual(statement.metadata, [metadata], header);
    }
    const r = PlurnkParser.parse(turn(frame("sh (greet.sh)", "body")));
    assert.deepEqual(errors(r), []);
    assert.deepEqual(statements(r).map(writtenOp), ["sh", "WAIT"]);
});

// {§slot-order} — a second slot on READ or KILL is a member, not an extra slot.
for (const header of ["READ (a.md) <2,3> (extra.md)", "KILL (a.md) (extra.md)"]) {
    test(`{§slot-order}: ${header} is a target group of two`, () => {
        for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements]) {
            const r = parse(turn(frame(header, null)));
            assert.deepEqual(errors(r), [], header);
            const [first, second] = statements(r);
            assert.ok(first !== undefined && (first.op === "READ" || first.op === "KILL"));
            assert.ok(second !== undefined && second.op === first.op);
            assert.deepEqual([first.target?.raw, second.target?.raw], ["a.md", "extra.md"]);
            assert.deepEqual(first.lineMarker, first.op === "READ" ? { marks: [2, 3] } : null);
            assert.equal(second.lineMarker, null);
            assert.deepEqual(statements(r).map(writtenOp), [header.split(" ")[0], header.split(" ")[0], "WAIT"]);
        }
    });
}

for (const header of [
    "FIND (/needle/) (src/) <1,-1>",
    "EDIT (a.md) (extra.md)",
    "SEND (session://child) (extra.md)",
    "BARE (a.md) (extra.md)",
    "WORK (session://child) (extra.md)",
    "FORK (session://child) (extra.md)",
    "COPY (workspace:///src.md) <2,3> (to) (workspace:///slice.md)",
    "MOVE (😀.md) <2,3> (dest.md) <0> (extra.md)",
]) {
    test(`{§matcher-prefix-claims}: ${header} reports its unexpected slot without assuming intent`, () => {
        for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements]) {
            const r = parse(turn(frame(header, null)));
            const [error] = errors(r);
            assert.equal(errors(r).length, 1);
            assert.equal(error.severity, "error");
            assert.equal(error.source, "parser");
            assert.equal(error.line, 1);
            assert.equal(error.column, 3 + Array.from(header.slice(0, header.lastIndexOf("("))).length);
            assert.match(error.message, /^unexpected `\(` \(`\(path\)` slot opener\)/u);
            assert.doesNotMatch(error.message, /pattern|exactly one|OPEN_|LPAREN|RPAREN/u);
            assert.equal(r.unparsedTail, undefined);
            assert.deepEqual(statements(r).map(writtenOp), ["WAIT"]);
        }
    });
}

test("{§operation-fences} a plus-prefixed path is still a path, alone or as an extglob", () => {
    for (const [header, target] of [["READ (+page.svelte) <1,-1>", "+page.svelte"], ["READ (+diff) <1,-1>", "+diff"], ["FIND (src/+(a|b).ts) <1,-1>", "src/+(a|b).ts"]]) {
        const r = PlurnkParser.parse(turn(frame(header, null)));
        assert.deepEqual(errors(r), [], header);
        const op = statements(r)[0];
        assert.equal("target" in op ? op.target?.raw : null, target);
    }
});

test("{§op-shapes} any number of WAITs are admitted, each its own statement, with no diagnostic", () => {
    const r = PlurnkParser.parse([task("WAIT"), frame("READ (a.md) <1,-1>", null), task("WAIT")].join("\n"));
    assert.equal(r.unparsedTail, undefined);
    assert.deepEqual(errors(r), []);
    assert.deepEqual(statements(r).map(writtenOp), ["WAIT", "READ", "WAIT"]);
});
});

describe("naked-patterns", () => {
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const diagnostics = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
const one = (source: string) => {
    const result = PlurnkParser.parseStatements(source);
    const ops = statements(result);
    assert.equal(ops.length, 1, source);
    return { op: ops[0] as PlurnkStatement & { matcher?: { dialect: string; raw: string; message?: string } | null; body?: unknown; metadata?: unknown }, diagnostics: diagnostics(result) };
};

test("{§parse-recovery}: `^` claims the regex dialect without slashes, and a trailing aside on the same line stays the aside", () => {
    const { op, diagnostics: notes } = one("````READ (notes.md) ^Decision:.* <!-- select decisions -->\n````\n");
    assert.deepEqual(notes, []);
    assert.deepEqual(op.matcher, { dialect: "regex", raw: "^Decision:.*", pattern: "^Decision:.*", flags: "" });
    assert.equal(op.aside, "select decisions");
    assert.equal(op.metadata, null);
    assert.equal(PlurnkParser.stringify([op]), "```READ (notes.md) ^Decision:.* <!-- select decisions -->\n```");
    const slash = one("````READ (notes.md) /Decision:.*/i <!-- the slash spelling keeps its flags -->\n````\n");
    assert.deepEqual(slash.diagnostics, []);
    assert.deepEqual(slash.op.matcher, { dialect: "regex", raw: "/Decision:.*/i", pattern: "Decision:.*", flags: "i" });
    assert.equal(slash.op.aside, "the slash spelling keeps its flags");
    const broken = one("````READ (notes.md) ^(unclosed\n````\n");
    assert.deepEqual(broken.diagnostics, [], "{§matcher-prefix-claims}: the statement is admitted");
    assert.match(broken.op.matcher?.dialect === "unreadable" ? broken.op.matcher.message ?? "" : "", /pattern leads with `\^` but is not a valid regex/u);
});

test("{§parse-recovery}: a sigil-less glob or literal on the heading line is the matcher on FIND, READ and KILL, silently", () => {
    for (const [source, raw] of [
        ["```FIND (src/**/*.ts) TODO\n```\n", "TODO"],
        ["```FIND (workspace:///) *.test.ts <!-- the suites -->\n```\n", "*.test.ts"],
        ["```READ (workspace:///a.md) bats <!-- lines naming bats -->\n```\n", "bats"],
        ["```KILL (log:///1/**) stale receipt\n```\n", "stale receipt"],
    ] as const) {
        const { op, diagnostics: notes } = one(source);
        assert.deepEqual(notes, [], source);
        assert.deepEqual(op.matcher, { dialect: "glob", raw }, source);
        assert.equal(op.body, null);
        assert.equal(PlurnkParser.stringify([op]), source.trimEnd(), "the bare form is the rendered form");
    }
    assert.equal(one("````FIND (workspace:///) *.test.ts <!-- the suites -->\n````\n").op.aside, "the suites");
});

test("{§parse-recovery}: on EDIT a heading-line sigil is the matcher and the lines beneath are the replacement; plain heading text stays the body", () => {
    const replace = one("````EDIT (workspace:///a.txt) /foo/\nbar\nbaz\n````\n");
    assert.deepEqual(replace.diagnostics, []);
    assert.deepEqual(replace.op.matcher, { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" });
    assert.equal(replace.op.body, "bar\nbaz");
    assert.equal(PlurnkParser.stringify([replace.op]), "```EDIT (workspace:///a.txt) /foo/\nbar\nbaz\n```");
    const remove = one("````EDIT (books.xml) //book[price > 35.00] <!-- an empty body removes each match -->\n````\n");
    assert.deepEqual(remove.diagnostics, []);
    assert.deepEqual(remove.op.matcher, { dialect: "xpath", raw: "//book[price > 35.00]" });
    assert.equal(remove.op.body, null);
    assert.equal(remove.op.aside, "an empty body removes each match");
    const literal = one("````EDIT (workspace:///a.txt) hello\n````\n");
    assert.equal(literal.op.matcher, null);
    assert.equal(literal.op.body, "hello", "EDIT heading-line text without a sigil is the replacement it always was");
    assert.match(literal.diagnostics[0]?.message ?? "", /body text was on the OP line/u);
    assert.equal(literal.diagnostics[0]?.severity, "warning");
});

test("{§parse-recovery}: a non-log KILL never recovers its body as a selector", () => {
    const result = one(PlurnkParser.frame("KILL (a.txt)", "/delete-me/"));
    assert.equal(result.op.matcher, null);
    assert.equal(result.op.body, null);
    assert.deepEqual(result.diagnostics.map(({ severity, message }) => ({ severity, message })), [
        { severity: "warning", message: "This KILL takes no body; line 2 was not used." },
    ]);
});

for (const op of ["FIND", "READ", "EDIT", "KILL"]) {
    test(`{§parse-recovery}: ${op} composes owner metadata with a bare matcher and round-trips both`, () => {
        const patterns = ["/needle/i", "^needle", "//item", "$.needle", "~needle", "&needle"];
        if (op !== "EDIT") patterns.push("needle", "*needle*");
        for (const metadata of ['{}', '{"headers":{"Accept":"text/plain"}}', '{"first":1},{"second":2}']) {
            for (const pattern of patterns) {
                const body = op === "EDIT" ? "literal replacement" : null;
                const source = PlurnkParser.frame(`${op} (opaque:///notes) <1,-1> [${metadata}] ${pattern} <!-- selection -->`, body);
                const parsed = one(source);
                assert.deepEqual(parsed.diagnostics, [], source);
                assert.equal(parsed.op.matcher?.raw, pattern, source);
                assert.deepEqual(parsed.op.metadata, [metadata], "owner metadata remains verbatim");
                assert.equal(parsed.op.body, body, "the matcher does not become replacement text");
                assert.equal(parsed.op.aside, "selection");
                const rendered = PlurnkParser.stringify([parsed.op]);
                const reparsed = one(rendered);
                assert.deepEqual(reparsed.diagnostics, [], rendered);
                assert.deepEqual(reparsed.op, parsed.op, "rendering preserves the entire accepted selection");
            }
        }
    });
}

test("{§parse-recovery}: canonicalizing trailing owner metadata retains the matcher", () => {
    const parsed = one('````READ (notes.md) /todo/i [{"limit":3}] <1,-1> <!-- selected -->\n````');
    assert.equal(parsed.diagnostics.length, 2);
    const rendered = PlurnkParser.stringify([parsed.op]);
    assert.equal(rendered, '```READ (notes.md) <1,-1> [{"limit":3}] /todo/i <!-- selected -->\n```');
    const reparsed = one(rendered);
    assert.deepEqual(reparsed.diagnostics, []);
    assert.deepEqual(reparsed.op, parsed.op);
});

test("{§slot-order}: invalid owner blocks do not erase an independent bare matcher", () => {
    for (const block of ["[not-json]", "[3]", '[{"one":1}] [{"two":2}]']) {
        const source = PlurnkParser.frame(`READ (opaque:///notes) ${block} /needle/`, null);
        const parsed = one(source);
        assert.deepEqual(parsed.diagnostics, [], "the owner still receives its invalid metadata");
        assert.equal(parsed.op.matcher?.raw, "/needle/", source);
        assert.equal(PlurnkParser.stringify([parsed.op]), source, "no metadata is rewritten or discarded");
    }
});

test("{§parse-recovery}: a leading PCRE inline modifier lifts into the flags with one advisory", () => {
    const slash = one("````READ (ledger.md) /(?i)shutdown|reactor|code/ <!-- locate the code -->\n````\n");
    assert.deepEqual(slash.op.matcher, { dialect: "regex", raw: "/(?i)shutdown|reactor|code/", pattern: "shutdown|reactor|code", flags: "i" });
    assert.equal(slash.diagnostics.length, 1);
    assert.equal(slash.diagnostics[0].severity, "warning");
    assert.equal(slash.diagnostics[0].message, "`(?i)` was read as the `i` flag; an ECMAScript regex takes its flags after the closing `/`.");
    const merged = one("````FIND (src/**) /(?ms)^begin.*end$/i\n````\n");
    assert.deepEqual(merged.op.matcher, { dialect: "regex", raw: "/(?ms)^begin.*end$/i", pattern: "^begin.*end$", flags: "ims" }, "authored flags and lifted letters merge without duplicates");
    const caret = one("````READ (reasoning://alice/1/1) ^(?i)note:.*\n````\n");
    assert.deepEqual(caret.op.matcher, { dialect: "regex", raw: "^(?i)note:.*", pattern: "^note:.*", flags: "i" });
    assert.equal(caret.diagnostics.length, 1);
    const scoped = one("````READ (a.md) /(?i:note):.*/\n````\n");
    assert.deepEqual(scoped.diagnostics, [], "a scoped modifier group is valid ECMAScript and passes through");
    assert.equal(scoped.op.matcher?.dialect, "regex");
    const stillBroken = one("````READ (a.md) /(?x)loose/\n````\n");
    assert.match(stillBroken.op.matcher?.dialect === "unreadable" ? stillBroken.op.matcher.message ?? "" : "", /not a valid `\/pattern\/flags` regex/u, "an unsupported modifier keeps the native refusal ({§matcher-prefix-claims})");
});

test("{§op-shapes}: a bare path's #channel is its fragment, and stringify renders it back", () => {
    const targetOf = (statement: PlurnkStatement) => "target" in statement ? statement.target : null;
    const { op, diagnostics: notes } = one("````READ (data/users.html#readable) <1,-1>\n````\n");
    assert.deepEqual(notes, []);
    assert.deepEqual(targetOf(op), { kind: "local", raw: "data/users.html", fragment: "readable" });
    assert.equal(PlurnkParser.stringify([op]), "```READ (data/users.html#readable) <1,-1>\n```");
    assert.deepEqual(targetOf(one("````READ (data/users.html)\n````\n").op), { kind: "local", raw: "data/users.html" }, "no `#`, no field");
    assert.deepEqual(targetOf(one("````FIND (src/**#readable) /x/\n````\n").op), { kind: "local", raw: "src/**", fragment: "readable" });
});

test("{§parse-recovery}: a scope, an option block or an aside written after the matcher peels off the right end", () => {
    const markerOf = (statement: PlurnkStatement) => "lineMarker" in statement ? statement.lineMarker : null;
    const scoped = one("````READ (crates/wasmi/src/store/mod.rs) /fn resolve_(memory|global)/ <1,-1> <!-- store entity resolution -->\n````\n");
    assert.deepEqual(scoped.op.matcher, { dialect: "regex", raw: "/fn resolve_(memory|global)/", pattern: "fn resolve_(memory|global)", flags: "" });
    assert.deepEqual(markerOf(scoped.op), { marks: [1, -1] });
    assert.equal(scoped.op.aside, "store entity resolution");
    assert.equal(scoped.diagnostics.length, 1);
    assert.equal(scoped.diagnostics[0].severity, "warning");
    assert.match(scoped.diagnostics[0].message, /after the pattern was read as the scope; the scope goes before the pattern/u);
    const positions = one("````FIND (crates/wasmi/src/memory/*.rs) /fn data|as_slice/ <2>\n````\n");
    assert.deepEqual(markerOf(positions.op), { marks: [2] }, "FIND takes result positions after the pattern");
    assert.equal(positions.op.matcher?.raw, "/fn data|as_slice/");
    const anchored = one("````KILL (log:///1/**) stale receipt <@aZ09b,@0Aa9Z>\n````\n");
    assert.deepEqual(markerOf(anchored.op), { marks: ["@aZ09b", "@0Aa9Z"] });
    assert.deepEqual(anchored.op.matcher, { dialect: "glob", raw: "stale receipt" });
    const block = one('````READ (notes.md) /todo/i [{"limit":3}]\n````\n');
    assert.deepEqual(block.op.metadata, ['{"limit":3}'], "a trailing option block is the option block");
    assert.equal(block.op.matcher?.raw, "/todo/i");
    assert.match(block.diagnostics[0]?.message ?? "", /options go before the pattern/u);
    const canonical = one("````READ (a.rs) <1,-1> /fn x/ <!-- note -->\n````\n");
    assert.deepEqual(canonical.diagnostics, [], "the canonical order draws no advisory");
    assert.deepEqual([markerOf(canonical.op), canonical.op.matcher?.raw, canonical.op.aside], [{ marks: [1, -1] }, "/fn x/", "note"]);
    const twice = one("````READ (a.rs) <1,2> /fn x/ <3,4>\n````\n");
    assert.match(twice.op.matcher?.dialect === "unreadable" ? twice.op.matcher.message ?? "" : "", /trailing text/u, "a second scope is not a slot; it stays trailing text, the matcher's refusal");
});

test("{§fence-pairing}: a closing fence mid-heading reads as if it were not written", () => {
    const markerOf = (statement: PlurnkStatement) => "lineMarker" in statement ? statement.lineMarker : null;
    // Each pair is the same heading with and without the inline closer; the readings must agree,
    // because every slot after it is an ordinary slot of the operation the fence opened.
    const pairs: Array<[string, string]> = [
        ["EDIT (a.md)", " <1,2>"],
        ["READ (a.md)", " <!-- note -->"],
        ["READ (a.md)", ' [{"limit":3}]'],
        ["READ (a.md)", " /fn resolve_/"],
    ];
    for (const [heading, tail] of pairs) {
        const bare = one("````" + heading + tail + "\n");
        const closed = one("````" + heading + "````" + tail + "\n");
        assert.deepEqual(markerOf(closed.op), markerOf(bare.op), heading + tail + ": scope agrees");
        assert.deepEqual(closed.op.matcher ?? null, bare.op.matcher ?? null, heading + tail + ": matcher agrees");
        assert.deepEqual(closed.op.aside ?? null, bare.op.aside ?? null, heading + tail + ": aside agrees");
        assert.deepEqual(closed.op.metadata ?? null, bare.op.metadata ?? null, heading + tail + ": option block agrees");
    }
    // The block still ends with its line: a following operation is its own statement, not a body.
    const following = PlurnkParser.parseStatements("````EDIT (a.md)```` <1,2>\n````READ (b.md)\n````\n");
    const ops = following.items.filter((item) => item.kind === "statement").map((item) => item.statement.op);
    assert.deepEqual(ops, ["EDIT", "READ"], "the closed heading does not swallow the next operation as a body");
    // {§fence-pairing} still owns a closer followed by the next opener.
    const chained = PlurnkParser.parseStatements("````EDIT (a.md)```` ````READ (b.md)\n");
    assert.deepEqual(
        chained.items.filter((item) => item.kind === "statement").map((item) => item.statement.op),
        ["EDIT", "READ"],
        "an opener after the closer still chains",
    );
    // A real body under a canonical block is untouched.
    const block = one("````EDIT (a.md)\nnew content\n````\n");
    assert.equal(block.op.body, "new content");
});

test("{§parse-recovery} {§op-shapes}: `#channel` alone after a target that names no channel is the channel, on bare paths and URLs", () => {
    const targetOf = (op: unknown): { kind?: string; raw?: string; fragment?: string | null } | undefined => (op as { target?: { kind?: string; raw?: string; fragment?: string | null } }).target;
    const local = one("```READ (data/users.html) #readable <!-- the page as prose -->\n```\n");
    assert.deepEqual(local.diagnostics, []);
    assert.equal(local.op.matcher, null, "no matcher: the token was the channel");
    assert.deepEqual(targetOf(local.op), { kind: "local", raw: "data/users.html", fragment: "readable" });
    assert.equal(local.op.aside, "the page as prose");
    assert.equal(PlurnkParser.stringify([local.op]), "```READ (data/users.html#readable) <!-- the page as prose -->\n```", "it renders back on the path");
    const url = one("```READ (https://example.org/report) #readable\n```\n");
    assert.deepEqual(url.diagnostics, []);
    assert.equal(url.op.matcher, null);
    assert.equal(targetOf(url.op)?.fragment, "readable");
    assert.equal(targetOf(url.op)?.raw, "https://example.org/report#readable", "a URL target carries the channel in its raw spelling");
    const already = one("```READ (data/users.html#readable) #header\n```\n");
    assert.equal(targetOf(already.op)?.fragment, "readable", "a target that already names a channel keeps it");
    assert.deepEqual(already.op.matcher, { dialect: "glob", raw: "#header" }, "and the token stays its pattern");
    const glob = one("```FIND (src/**/*.md) #*.md\n```\n");
    assert.deepEqual(glob.op.matcher, { dialect: "glob", raw: "#*.md" }, "a `#` followed by more than one channel token is still a glob");
    const scoped = one("```READ (data/users.html) <1,40> #readable\n```\n");
    assert.equal(targetOf(scoped.op)?.fragment, "readable");
    assert.deepEqual((scoped.op as { lineMarker?: unknown }).lineMarker, { marks: [1, 40] }, "the scope rides beside it");
});
});

describe("native-tool-calls", () => {
const EXECUTORS = ["sh", "js"];
const read = (input: string) => PlurnkParser.parse(input, { executors: EXECUTORS });
const ops = (input: string) => read(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const canonical = (fence: string) => PlurnkParser.parse(fence, { executors: EXECUTORS }).items.flatMap((item) => item.kind === "statement" ? [{ ...item.statement, position: undefined }] : []);
const withoutPosition = <T extends object>(statements: T[]) => statements.map((statement) => ({ ...statement, position: undefined }));

test("{§fence-pairing} operand ownership comes from the same grammar as fenced headings", () => {
    for (const [heading, expected] of [
        ["READ <1> (a.md)", "READ (a.md) <1>"],
        ["READ → a.md <1>", "READ (a.md) <1>"],
        ["FIND <1,3> (src/**)", "FIND (src/**) <1,3>"],
        ["COPY (a.md) <1> (b.md)", "COPY (a.md) <1> (b.md)"],
    ]) {
        const name = heading.split(" ")[0];
        const slots = heading.slice(name.length).trim();
        for (const input of [
            `<invoke name="${heading}">\n</invoke>`,
            `<tool_call><function=${name}>\n${slots}\n</function></tool_call>`,
        ]) {
            assert.deepEqual(withoutPosition(ops(input)), canonical(`\`\`\`${expected}\n\`\`\``), input);
            assert.deepEqual(read(input).items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], input);
        }
    }
});

test("{§fence-pairing} a DSML READ with path and scope parameters is that READ (engine-edit-probe-kSoo0p)", () => {
    const input = [
        "<｜｜DSML｜｜ calls>",
        "<｜｜DSML｜｜ invoke name=\"READ\">",
        "<｜｜DSML｜｜ parameter name=\"path\" string=\"true\">Engine.ts</｜｜DSML｜｜ parameter>",
        "<｜｜DSML｜｜ parameter name=\"scope\" string=\"true\">440,470</｜｜DSML｜｜ parameter>",
        "</｜｜DSML｜｜ invoke>",
        "</｜｜DSML｜｜ calls>",
    ].join("\n");
    assert.deepEqual(read(input).items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(withoutPosition(ops(input)), canonical("````READ (Engine.ts) <440,470>\n````"));
});

test("{§fence-pairing} a DSML WAIT naming a session and a DSML sh with a verbatim heading and plain body lines", () => {
    const wait = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"WAIT\">", "<parameter name=\"path\">session://codename-lookup</｜｜DSML｜｜ parameter>", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(withoutPosition(ops(wait)), canonical("````WAIT (session://codename-lookup)\n````"));

    const sh = [
        "<｜｜DSML｜｜ calls>",
        "<｜｜DSML｜｜ invoke name=\"sh\" [{\"cwd\":\".\"}] <!-- rebuild and re-run -->",
        "go build . && echo ROOT_OK",
        "```",
        "",
        "<｜｜DSML｜｜ calls>",
        "<｜｜DSML｜｜ invoke name=\"WAIT\" <!-- await the build -->",
        "</｜｜DSML｜｜ parameter>",
        "</｜｜DSML｜｜ invoke>",
        "</｜｜DSML｜｜ calls>",
    ].join("\n");
    const statements = ops(sh);
    assert.deepEqual(read(sh).items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(withoutPosition(statements), canonical("````sh [{\"cwd\":\".\"}] <!-- rebuild and re-run -->\ngo build . && echo ROOT_OK\n````\n\n````WAIT <!-- await the build -->\n````"));
    assert.deepEqual(statements.map((statement) => statement.position?.line), [2, 7], "positions still name the source lines");
});

test("{§fence-pairing} an unknown invoke or parameter, or markup beside a real operation, is left as it was", () => {
    const unknownName = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"36\">", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(ops(unknownName), []);
    const unknownParameter = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"READ\">", "<｜｜DSML｜｜ parameter name=\"height\">3</｜｜DSML｜｜ parameter>", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(ops(unknownParameter), []);
    const beside = "````READ (a.md)\n````\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\" path=\"b.md\" />\n</｜｜DSML｜｜ calls>";
    assert.deepEqual(ops(beside).map((statement) => "target" in statement ? statement.target?.raw : null), ["a.md"]);
});

// {§fence-pairing} — the other popular families read the same way, from recorded emissions where
// they exist and from each vendor's documented shape.
test("{§fence-pairing} MiMo's inline <tool_call><function=READ><parameter=file_path> pair is two READs", () => {
    const input = "<tool_call><function=READ><parameter=file_path>/Users/dev/workspace-71d1a807/django/urls/resolvers.py</parameter></function></tool_call><tool_call><function=READ><parameter=file_path>/Users/dev/workspace-71d1a807/django/core/handlers/exception.py</parameter></function></tool_call>";
    assert.deepEqual(read(input).items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(withoutPosition(ops(input)), canonical("````READ (/Users/dev/workspace-71d1a807/django/urls/resolvers.py)\n````\n\n````READ (/Users/dev/workspace-71d1a807/django/core/handlers/exception.py)\n````"));
});

test("{§fence-pairing} MiMo's hybrid <function=NOTE> with a bare body and <function=READ (path) <scope>> with plurnk slots", () => {
    const input = "<tool_call><function=NOTE><resolve Http404 in path converter to_python → technical 404 response under DEBUG></function></tool_call><tool_call><function=READ (django/urls/resolvers.py) <1,-1></function></tool_call>";
    assert.deepEqual(withoutPosition(ops(input)), canonical("````NOTE\n<resolve Http404 in path converter to_python → technical 404 response under DEBUG>\n````\n\n````READ (django/urls/resolvers.py) <1,-1>\n````"));
});

test("{§fence-pairing} a Hermes JSON tool_call and a GLM key/value tool_call are the operations they name", () => {
    const hermes = "<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"workspace:///notes.md\", \"scope\": \"1,20\"}}\n</tool_call>";
    assert.deepEqual(withoutPosition(ops(hermes)), canonical("````READ (workspace:///notes.md) <1,20>\n````"));
    const glm = "<tool_call>FIND\n<arg_key>path</arg_key>\n<arg_value>django/urls/*.py</arg_value>\n<arg_key>pattern</arg_key>\n<arg_value>def resolve</arg_value>\n</tool_call>";
    assert.deepEqual(withoutPosition(ops(glm)), canonical("````FIND (django/urls/*.py) def resolve\n````"));
});

test("{§fence-pairing} Anthropic-style function_calls, Mistral [TOOL_CALLS], Llama <|python_tag|> and Kimi call sections", () => {
    const anthropic = "<function_calls>\n<invoke name=\"NOTE\">\n<parameter name=\"body\">Root cause found.</parameter>\n</invoke>\n<invoke name=\"sh\">\n<parameter name=\"command\">git status --short</parameter>\n</invoke>\n</function_calls>";
    assert.deepEqual(withoutPosition(ops(anthropic)), canonical("````NOTE\nRoot cause found.\n````\n\n````sh\ngit status --short\n````"));
    const mistral = "[TOOL_CALLS][{\"name\": \"READ\", \"arguments\": {\"path\": \"django/views/debug.py\"}}, {\"name\": \"WAIT\", \"arguments\": {}}]";
    assert.deepEqual(withoutPosition(ops(mistral)), canonical("````READ (django/views/debug.py)\n````\n\n````WAIT\n````"));
    const llama = "<|python_tag|>{\"name\": \"READ\", \"parameters\": {\"path\": \"django/views/debug.py\", \"range\": \"455,523\"}}<|eom_id|>";
    assert.deepEqual(withoutPosition(ops(llama)), canonical("````READ (django/views/debug.py) <455,523>\n````"));
    const kimi = "<|tool_calls_section_begin|><|tool_call_begin|>functions.READ:0<|tool_call_argument_begin|>{\"path\": \"django/views/debug.py\"}<|tool_call_end|><|tool_call_begin|>functions.sh:1<|tool_call_argument_begin|>{\"command\": \"python3 /tmp/repro.py\"}<|tool_call_end|><|tool_calls_section_end|>";
    assert.deepEqual(withoutPosition(ops(kimi)), canonical("````READ (django/views/debug.py)\n````\n\n````sh\npython3 /tmp/repro.py\n````"));
});

test("{§fence-pairing} a call naming a tool plurnk does not have, or a parameter it cannot place, leaves the emission as it was", () => {
    for (const input of [
        "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"x\"}}\n</tool_call>",
        "<tool_call><function=EDIT><parameter=old_string>a</parameter><parameter=new_string>b</parameter></function></tool_call>",
        "[TOOL_CALLS][{\"name\": \"READ\", \"arguments\": {\"encoding\": \"utf8\"}}]",
        "<|tool_call_begin|>functions.grep:0<|tool_call_argument_begin|>{\"pattern\": \"ls\"}<|tool_call_end|>",
    ]) {
        assert.deepEqual(ops(input), [], `no operation is invented from ${input.slice(0, 40)}`);
    }
});

test("{§fence-pairing} prose around a block survives on its own lines, and a quoted block is an example", () => {
    const input = "Let me look.\n<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"a.md\"}}\n</tool_call>\nThen decide.";
    const result = read(input);
    assert.deepEqual(withoutPosition(ops(input)), canonical("````READ (a.md)\n````"));
    assert.deepEqual(result.items.filter((item) => item.kind === "text").map((item) => item.kind === "text" ? item.content.trim() : ""), ["Let me look.", "Then decide."]);
    const quoted = "````\n<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"a.md\"}}\n</tool_call>\n````";
    assert.deepEqual(ops(quoted), [], "a fenced example of the markup never runs");
});

test("{§fence-pairing} start/end and offset/limit parameters are one scope; a DSML block on one line reads like one on many (deepdumb, django-11620)", () => {
    const deepdumb = "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\">\n<｜｜DSML｜｜ parameter name=\"path\" string=\"true\">ops://daeb2d14/1/25</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name=\"start\" string=\"false\">1</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name=\"end\" string=\"false\">-1</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
    assert.deepEqual(withoutPosition(ops(deepdumb)), canonical("````READ (ops://daeb2d14/1/25) <1,-1>\n````"));
    const offset = "<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"file_path\": \"django/views/debug.py\", \"offset\": 455, \"limit\": 20}}\n</tool_call>";
    assert.deepEqual(withoutPosition(ops(offset)), canonical("````READ (django/views/debug.py) <455,474>\n````"));
    const inline = "<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"READ\"><｜｜DSML｜｜ parameter name=\"path\" string=\"true\">sh:///9c471159#stdout</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name=\"range\" string=\"true\"><100,-1></｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>";
    assert.deepEqual(withoutPosition(ops(inline)), canonical("````READ (sh:///9c471159#stdout) <100,-1>\n````"));
    assert.deepEqual(ops("<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"a.md\", \"limit\": 5}}\n</tool_call>"), [], "a count without a first line names no scope");
});

// {§fence-pairing} — Qwen's own shapes, verbatim from recorded qflash no-operation turns (#853).
test("{§fence-pairing} a flat JSON call names its operation with an `op`, `OP`, `action` or `cmd` key, trailing closers being noise", () => {
    for (const [input, fence] of [
        ["<tool_call>\n{\"op\": \"READ\", \"path\": \"django/forms/widgets.py\", \"range\": \"<170,245>\"}\n</parameter>", "````READ (django/forms/widgets.py) <170,245>\n````"],
        ["<tool_call>\n{\"OP\":\"READ\",\"path\":\"sympy/printing/pretty/pretty.py\",\"scope\":\"<1456,1520>\"}\n", "````READ (sympy/printing/pretty/pretty.py) <1456,1520>\n````"],
        ["<tool_call>\n{\"cmd\":\"read\",\"path\":\"sphinx/ext/autodoc/__init__.py\",\"range\":\"<640,700>\"}\n</>", "````READ (sphinx/ext/autodoc/__init__.py) <640,700>\n````"],
        ["<tool_call>\n{\"op\": \"READ\", \"path\": \"tests/runtests.py\", \"scope\": \"<49,128>\", \"aside\": \"get_test_modules and setup logic\"}\n</parameter>\n</op>", "````READ (tests/runtests.py) <49,128> <!-- get_test_modules and setup logic -->\n````"],
        ["<tool_call>\n{\"op\": \"read\", \"path\": \"django/forms/widgets.py\", \"scope\": {\"start\": 55, \"end\": 85}}", "````READ (django/forms/widgets.py) <55,85>\n````"],
        ["<tool_call>\n{\"op\": \"NOTE\", \"content\": \"Turn 80: re-apply the fix.\"}\n</parameter>\n</invoke>", "````NOTE\nTurn 80: re-apply the fix.\n````"],
    ] as const) {
        assert.deepEqual(read(input).items.filter((item) => item.kind === "error"), [], input);
        assert.deepEqual(withoutPosition(ops(input)), canonical(fence), input);
    }
    const kills = "<tool_call>\n{\"action\": \"KILL\", \"path\": \"log:///1/[1-16]/*/{NOTE,READ,FIND}\", \"scope\": \"<3,-1>\"}\n<tool_call>\n{\"action\": \"KILL\", \"path\": \"log:///1/[17-38]/*/{NOTE,READ,FIND}\", \"scope\": \"<5,-1>\"}";
    assert.deepEqual(withoutPosition(ops(kills)), canonical("````KILL (log:///1/[1-16]/*/{NOTE,READ,FIND}) <3,-1>\n````\n\n````KILL (log:///1/[17-38]/*/{NOTE,READ,FIND}) <5,-1>\n````"));
});

test("{§fence-pairing} `<function=READ>` with a JSON body, `<function=OP>` around a call or a heading, and a JSON-array scope", () => {
    for (const [input, fence] of [
        ["<tool_call>\n<function=READ>\n{\"path\":\"django/urls/exceptions.py\"}\n</parameter>\n</function>\n</tool_call>", "````READ (django/urls/exceptions.py)\n````"],
        ["<tool_call>\n<function=OP>\nREAD (sympy/printing/ccode.py) <50,100>\n</parameter>\n</function>\n</tool_call>", "````READ (sympy/printing/ccode.py) <50,100>\n````"],
        ["<tool_call>\n<function=OP>\n{\"op\":\"READ\",\"path\":\"sklearn/model_selection/_split.py\",\"range\":[1217,1222]}\n</parameter>\n</function>\n</tool_call>", "````READ (sklearn/model_selection/_split.py) <1217,1222>\n````"],
        ["<tool_call>\n<function=OP name=\"READ\" path=\"sphinx/ext/autodoc/__init__.py\" range=\"[700,760]\">\n</function>\n</tool_call>", "````READ (sphinx/ext/autodoc/__init__.py) <700,760>\n````"],
        ["<tool_call>\n<function=READ>\n(sphinx/ext/autodoc/directive.py) <1,30>\n</parameter>\n</function>\n</tool_call>", "````READ (sphinx/ext/autodoc/directive.py) <1,30>\n````"],
    ] as const) {
        assert.deepEqual(withoutPosition(ops(input)), canonical(fence), input);
    }
});

test("{§fence-pairing} `<NOTE>`, `<FIND (…)>`, `<op op=…>`, `<ops><op verb=…/></ops>`, `<op=READ …>` and a bare heading in the call", () => {
    for (const [input, fence] of [
        ["<tool_call>\n<NOTE>\nRoot cause confirmed in _scan_iterable_shape.\n</NOTE>", "````NOTE\nRoot cause confirmed in _scan_iterable_shape.\n````"],
        ["<tool_call>\n<FIND (sphinx/ext/autodoc/__init__.py) <1,3>\n</FIND>", "````FIND (sphinx/ext/autodoc/__init__.py) <1,3>\n````"],
        ["<tool_call>\n<ops>\n<op verb=\"READ\" path=\"sphinx/ext/autodoc/__init__.py\" scope=\"<686,695>\"/>\n</ops>", "````READ (sphinx/ext/autodoc/__init__.py) <686,695>\n````"],
        ["<tool_call>\n<op=READ (sympy/simplify/tests/test_powsimp.py) /^def test/ <!-- list all test function names -->\n</op>", "````READ (sympy/simplify/tests/test_powsimp.py) /^def test/ <!-- list all test function names -->\n````"],
        ["<tool_call>\nREAD (sympy/printing/codeprinter.py) <60,120>\n</READ>", "````READ (sympy/printing/codeprinter.py) <60,120>\n````"],
        ["<tool_call>\n=READ (sympy/printing/codeprinter.py) <1,50> <!-- examine CodePrinter -->\n```", "````READ (sympy/printing/codeprinter.py) <1,50> <!-- examine CodePrinter -->\n````"],
    ] as const) {
        assert.deepEqual(withoutPosition(ops(input)), canonical(fence), input);
    }
    const pair = "<tool_call>\n<op op=\"READ\" path=\"django/urls/resolvers.py\" scope=\"1,30\">\n</op>\n<tool_call>\n<op op=\"READ\" path=\"django/views/debug.py\" scope=\"483,498\">\n</op>";
    assert.deepEqual(withoutPosition(ops(pair)), canonical("````READ (django/urls/resolvers.py) <1,30>\n````\n\n````READ (django/views/debug.py) <483,498>\n````"));
});

test("{§fence-pairing} a targeted operation that names no target is not read, and an EDIT's content never supplies one", () => {
    assert.deepEqual(ops("<tool_call>\n<function=READ>\n<scope>@L4XSj</scope>\n</function>\n</tool_call>"), []);
    assert.deepEqual(ops("<tool_call>\n<EDIT>\n(django/forms/widgets.py) <9,9>\n{\"lines\":1,\"resource\":\"edit://20af9b7e/1/45/1\"}\n</EDIT>"), [], "an echoed receipt is never written into a file");
});

test("{§fence-pairing} markup that was not read is named with the fenced form that runs", () => {
    const receipt = (input: string) => read(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
    assert.deepEqual(receipt("<tool_call>\n<EDIT>\n(django/forms/widgets.py) <9,9>\n{\"lines\":1}\n</EDIT>"), [
        "`<tool_call>` is tool-call markup and was not executed. Use three backticks and `EDIT (django/forms/widgets.py)` on the opening line.",
    ]);
    // `bash` names `sh` when `sh` is the registered shell, so the recorded Bash call runs; a shell by an unknown name draws the sh form.
    assert.deepEqual(withoutPosition(ops("<tool_call>\n{\"name\":\"Bash\",\"input\":{\"command\":\"cd /workspace && git status\"}}\n</tool_call>")), canonical("````sh\ncd /workspace && git status\n````"));
    assert.equal(receipt("<tool_call>\n{\"name\":\"zsh\",\"input\":{\"command\":\"cd /workspace && git status\"}}\n</tool_call>")[0],
        "`<tool_call>` is tool-call markup and was not executed. Use three backticks and `sh` on the opening line, the command on the lines below it, and three backticks to close.");
    assert.equal(receipt("<tool_call>\n{\"text\": \"Let me fix the `_css` property.\", \"type\": \"note\"}\n</tool_call>")[0],
        "`<tool_call>` is tool-call markup and was not executed. Use three backticks and `NOTE` on the opening line, the note on the lines below it, and three backticks to close.");
    assert.equal(receipt("<tool_call>\n<tool_call>\n<tool_call>")[0],
        "`<tool_call>` is tool-call markup and was not executed. Use three backticks and the operation with its target, such as `READ (path)`, on the opening line.");
    const beside = read("````READ (a.md)\n````\n\n<tool_call>\n<tool_call>");
    const errors = beside.items.flatMap((item) => item.kind === "error" ? [item.error] : []);
    assert.deepEqual(errors.map(({ line, severity }) => ({ line, severity })), [{ line: 4, severity: "warning" }]);
    assert.equal(beside.items.filter((item) => item.kind === "statement").length, 1);
    assert.deepEqual(read("<tool_call><function=unknown></function></tool_call>").items.flatMap((item) =>
        item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []), [PlurnkParser.NO_VALID_OPERATION]);
});

test("{§fence-pairing}: quoted markup and operation bodies are not attempted calls", () => {
    const markup = "<tool_call><function=unknown></function></tool_call>";
    for (const input of [
        `\`\`\`\`EDIT (example.xml)\n${markup}\n\`\`\`\``,
        `\`\`\`\`SEND\n${markup}\n\`\`\`\``,
        `\`\`\`xml\n${markup}\n\`\`\`\n\n\`\`\`READ (a.md)\n\`\`\``,
    ]) {
        assert.deepEqual(read(input).items.filter((item) => item.kind === "error"), []);
    }
});

test("{§fence-pairing}: bare invokes and JSON argument bodies use the existing operation slots", () => {
    const input = [
        '<｜｜DSML｜｜ invoke name="NOTE">', '{"content":"Remember the observed fact."}', '</｜｜DSML｜｜ invoke>',
        '<｜｜DSML｜｜ invoke name="sh">', '{"command":"printf ready"}', '</｜｜DSML｜｜ invoke>',
        '<｜｜DSML｜｜ invoke name="READ">', '<｜｜DSML｜｜ parameter name="path">fact.md</｜｜DSML｜｜ parameter>', '</｜｜DSML｜｜ invoke>',
        '</｜｜DSML｜｜ calls>',
    ].join("\n");
    assert.deepEqual(withoutPosition(ops(input)), canonical("````NOTE\nRemember the observed fact.\n````\n\n````sh\nprintf ready\n````\n\n````READ (fact.md)\n````"));
    assert.equal(read(input).items.filter((item) => item.kind === "error").length, 0);
    const unknown = '<invoke name="READ">\n{"path":"fact.md","height":4}\n</invoke>';
    assert.deepEqual(ops(unknown), [], "an unknown argument is never guessed");
});

test("{§fence-pairing}: recorded bare invokes recover the shell, READ and JSON-bodied NOTE (#904)", () => {
    const first = readFileSync(new URL("../fixtures/recorded/deepdumb-run170-443d9fe6-1-27.md", import.meta.url), "utf8");
    const second = readFileSync(new URL("../fixtures/recorded/deepdumb-run170-443d9fe6-1-29.md", import.meta.url), "utf8");
    const before = ops(first);
    const after = ops(second);
    assert.deepEqual(before.map((op) => "runtime" in op ? op.runtime : op.op), ["sh", "READ"]);
    assert.deepEqual(after.map((op) => "runtime" in op ? op.runtime : op.op), ["NOTE", "sh"]);
    const [shell, readStatement] = before;
    const [note, nextShell] = after;
    assert.ok(shell && "runtime" in shell);
    assert.ok(readStatement && "op" in readStatement && readStatement.op === "READ");
    assert.ok(note && "op" in note && note.op === "NOTE");
    assert.ok(nextShell && "runtime" in nextShell);
    assert.match(shell.body ?? "", /^grep -rIl "stable_topological_sort"/u);
    assert.equal(readStatement.target?.raw, "tests/forms_tests/tests/test_media.py");
    assert.deepEqual(readStatement.lineMarker, { marks: [94, 153] });
    assert.match(note.body ?? "", /^STATE: Fix applied to django\/forms\/widgets.py\./u);
    assert.match(nextShell.body ?? "", /^grep -rl "Detected duplicate Media files"/u);
    assert.deepEqual(PlurnkParser.parse(first, { executors: EXECUTORS }).items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(PlurnkParser.parse(second, { executors: EXECUTORS }).items.filter((item) => item.kind === "error"), []);
});

// {§fence-pairing} — DeepSeek's dialect with the heading in the invoke's name, verbatim from run429 (#853).
test("{§fence-pairing} DeepSeek run429: invoke names holding whole headings, an unclosed `name=\"sh`, and parameter debris read as NOTE, two FINDs and the sh (recorded)", () => {
    const text = readFileSync(new URL("../fixtures/recorded/deepdumb-run429-10730551-1-13.md", import.meta.url), "utf8");
    const result = read(text);
    const executed = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(executed.map((statement) => "runtime" in statement ? statement.runtime : statement.op), ["NOTE", "FIND", "FIND", "sh"]);
    const [note, first, second, sh] = executed;
    assert.match(note?.op === "NOTE" ? note.body ?? "" : "", /^Working the Http404-in-converter issue\./u);
    assert.equal(first?.op === "FIND" ? first.target?.raw : null, "docs/**");
    assert.equal(first?.op === "FIND" ? first.matcher?.raw : null, "/Http404/");
    assert.equal(first?.aside, "docs mentions");
    assert.equal(second?.op === "FIND" ? second.target?.raw : null, "django/urls/**");
    assert.equal(second?.op === "FIND" ? second.matcher?.raw : null, "/converter/");
    assert.equal(second?.aside, "converter references");
    const script = sh !== undefined && "runtime" in sh ? sh.body ?? "" : "";
    assert.match(script, /^git log -1 --format='%H %ci %s'; echo '---'; git status --short;/u, "the script under `name=\"sh` is the body");
    assert.doesNotMatch(script, /DSML|parameter/u, "the tag debris never enters the script");
    assert.deepEqual(result.items.filter((item) => item.kind === "text"), [], "no outside text");
    assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], "no receipt: every call was read");
});

test("{§fence-pairing} DeepSeek debris: a copied facts line, a `comment` attribute, an executor's option, `bash` as `sh`, and slots after the tag", () => {
    const facts = "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"sh\" comment=\"run the suite\">\n{\"lines\":6}\nnpm test\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
    assert.deepEqual(withoutPosition(ops(facts)), canonical("````sh <!-- run the suite -->\nnpm test\n````"));
    const option = "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"python3\">\nprint(1)\n</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name=\"maxTokens\" string=\"true\">2500</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n<｜｜DSML｜｜ invoke name=\"READ\">(sympy/tensor/array/__init__.py) <225,248>\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
    assert.deepEqual(withoutPosition(PlurnkParser.parse(option, { executors: ["sh", "python3"] }).items.flatMap((item) => item.kind === "statement" ? [item.statement] : [])),
        PlurnkParser.parse("````python3 [{\"maxTokens\":\"2500\"}]\nprint(1)\n````\n\n````READ (sympy/tensor/array/__init__.py) <225,248>\n````", { executors: ["sh", "python3"] }).items.flatMap((item) => item.kind === "statement" ? [{ ...item.statement, position: undefined }] : []));
    const bash = "<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"Bash\">\n<｜｜DSML｜｜parameter name=\"command\" string=\"true\">ls -la</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜/invoke>\n<｜｜DSML｜｜/tool_calls>";
    assert.deepEqual(withoutPosition(ops(bash)), canonical("````sh\nls -la\n````"));
    assert.deepEqual(ops("<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\">\n<｜｜DSML｜｜ parameter name=\"height\">3</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>"), [], "an unknown parameter on a native operation still leaves the emission unread");
});
});

describe("parse-recovery", () => {
const refusals = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items
    .flatMap((item) => item.kind === "error" && item.error.severity === "error" && item.error.message !== PlurnkParser.NO_VALID_OPERATION ? [item.error] : []);
// {§matcher-prefix-claims} — a refused matcher is admitted with its statement and carries the same pair.
const refusedMatcher = (input: string): { message: string; recovery: string } => {
    const parsed = PlurnkParser.parse(input, { executors: ["sh"] });
    assert.deepEqual(refusals(input), [], `${input} is admitted`);
    const statement = parsed.items.find((item) => item.kind === "statement");
    const matcher = statement?.kind === "statement" && "matcher" in statement.statement ? statement.statement.matcher : null;
    if (matcher === null || matcher === undefined || matcher.dialect !== "unreadable") assert.fail(`${input} carries no refused matcher`);
    return { message: matcher.message, recovery: matcher.recovery };
};
const advisories = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items
    .flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const matcherOf = (input: string) => {
    const statement = PlurnkParser.parse(input, { executors: ["sh"] }).items.find((item) => item.kind === "statement");
    return statement?.kind === "statement" && "matcher" in statement.statement ? statement.statement.matcher : null;
};

test("{§diagnostic-observation} trailing-regex recovery states the matcher form without guessing the author's intent", () => {
    for (const matcher of ["/def copy/ -1", "/def copy/ i", "/def copy/i inspect the method"]) {
        const input = [
            "```READ (requests/models.py) <300,330>\n```",
            `\`\`\`READ (requests/models.py) ${matcher}\n\`\`\``,
            "```FIND (requests/models.py) /def copy/\n```",
            "```READ (test_requests.py) <1,60>\n```",
        ].join("\n\n");
        const { items } = PlurnkParser.parse(input);
        assert.deepEqual(items.flatMap((item) => item.kind === "error" ? [item.error] : []), [], matcher);
        const statements = items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.deepEqual(statements.map(({ op }) => op), ["READ", "READ", "FIND", "READ"], "every operation is admitted ({§matcher-prefix-claims})");
        const refused = "matcher" in statements[1] ? statements[1].matcher : null;
        if (refused === null || refused === undefined || refused.dialect !== "unreadable") assert.fail(matcher);
        assert.equal(refused.message, "Regex matcher has trailing text after `/pattern/flags`.", matcher);
        assert.equal(refused.recovery, "Write only `/pattern/flags` in the matcher; flags are optional.", matcher);
    }
});

test("{§parse-recovery} valid flags, scopes and asides do not become trailing-regex errors", () => {
    for (const [heading, flags, marks, aside, warnings] of [
        ["READ (a.py) /def copy/", "", null, null, 0],
        ["READ (a.py) /def copy/i", "i", null, null, 0],
        ["READ (a.py) <1,16> /def copy/i <!-- inspect method -->", "i", [1, 16], "inspect method", 0],
        ["READ (a.py) /def copy/i <1,16> <!-- inspect method -->", "i", [1, 16], "inspect method", 1],
    ] as const) {
        const { items } = PlurnkParser.parse(`\`\`\`${heading}\n\`\`\``);
        const errors = items.flatMap((item) => item.kind === "error" ? [item.error] : []);
        assert.deepEqual(errors.map((error) => error.severity), Array(warnings).fill("warning"), heading);
        const statements = items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements.length, 1, heading);
        const statement = statements[0];
        if (statement.op !== "READ" || statement.matcher?.dialect !== "regex") assert.fail(heading);
        assert.equal(statement.matcher.pattern, "def copy", heading);
        assert.equal(statement.matcher.flags, flags, heading);
        assert.deepEqual(statement.lineMarker?.marks ?? null, marks, heading);
        assert.equal(statement.aside, aside, heading);
    }
});

test("{§matcher-prefix-claims} {§parse-recovery} a glob-shaped regex is read as its glob over each line with one advisory; a broken regex carries the regex's working form", () => {
    for (const [input, pattern] of [
        ["```FIND (tests/*) /*url*/ <!-- test modules mentioning url -->\n```", ".*url.*"],
        ["```READ (django) /*.py/\n```", ".*\\.py"],
        ["```FIND (src/a.py) /?x/\n```", ".x"],
        ["```FIND (a.py) /*/\n```", ".*"],
        ["```FIND (a.py) /**/\n```", ".*"],
    ] as const) {
        const matcher = matcherOf(input);
        assert.deepEqual(refusals(input), [], input);
        assert.equal(matcher?.dialect, "regex", input);
        assert.equal(matcher?.dialect === "regex" ? matcher.pattern : null, pattern, input);
        assert.match(advisories(input).join(" "), /was read as the glob/u, input);
    }
    assert.deepEqual(advisories("```FIND (tests/*) /*url*/ <!-- test modules mentioning url -->\n```"),
        ["`/*url*/` was read as the glob `*url*` over each line, the regex `/.*url.*/`; a pattern is a regex, and `*` repeats what precedes it."]); // {§parser-build}
    assert.equal(refusedMatcher("```READ (a.py) /(unclosed/\n```").recovery,
        "A pattern is a regex written `/pattern/flags`, such as `/timeout/i`.", "{§diagnostic-observation}: the dialect's form, never a reading of the input"); // {§parser-build}
});

test("{§parse-recovery} every grammar-level refusal names its working form", () => {
    for (const [input, recovery] of [
        ["```READ (a.py) <+1>\n```", "Write `<start,+offset>`, `<@abcde,+offset>`, or `<start,end>`."],
        ["```READ (http://exa mple.com/x)\n```", "Write a local path, `(src/a.py)`, or a complete URL, `scheme://host/path`."],
        ["```sh (a) (b)\n```", "`sh (target)?` on the opening fence line, the input on the lines below, then the closing fence."],
        ["```EDIT (a.py) <1> <2>\nx\n```", "One scope per selection, such as `<12,40>` or `<@abcde,+5>`."],
        ["```READ (a.py) <line number>\n```", "`READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line."],
        ["```COPY (a.py)\n```", "`COPY (from) <scope>? (to) <scope>?` on the opening fence line; COPY takes no body."],
        ["```WAIT (session://unfinished\n```", "`WAIT (path)? [seconds]?` on the opening fence line, any body on the lines below, then the closing fence."],
        ["```EDIT (a.py) <@ab>\nx\n```", "`EDIT (path) <scope>` on the opening fence line, the replacement text on the lines below, then the closing fence."],
        ["```sh <1,2,3,4,5,6> [x\n```", "`sh (target)?` on the opening fence line, the input on the lines below, then the closing fence."],
    ] as const) {
        const errors = refusals(input);
        assert.ok(errors.length > 0, `${input} is refused`);
        assert.equal(errors[0].recovery, recovery, input);
    }
    assert.equal(refusedMatcher("```FIND (a) /x/ ,/y/\n```").recovery,
        "A pattern is a regex written `/pattern/flags`, such as `/timeout/i`.", "{§parse-recovery} gives the dialect's working form without synthesizing a query");
});

test("{§matcher-prefix-claims} {§parse-recovery} every refused matcher carries its working form on the admitted statement", () => {
    for (const [input, recovery] of [
        ["```READ (a.md) /\n```", "Write `/pattern/flags`, flags optional, such as `/timeout/i`."],
        ["```READ (a.md) //[bad\n```", "Write an XPath 1.0 selector after `//`, such as `//dependencies/*`."],
        ["```READ (a.json) $.[\n```", "Write an RFC 9535 JSONPath after `$`, such as `$.items[?(@.price>500)]`."],
        ["```READ (a.py) &\n```", "Write `&symbol` for a symbol, `&<symbol` for what calls it, or `&>symbol` for what it calls."],
        ["```READ (a.py) /a/i extra\n```", "Write only `/pattern/flags` in the matcher; flags are optional."],
    ] as const) {
        assert.equal(refusedMatcher(input).recovery, recovery, input);
    }
});
});

describe("range-recovery", () => {
const statementsOf = (parsed: ParseResult) => parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warningsOf = (parsed: ParseResult) => parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const assertAdmitted = (parsed: ParseResult) => assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
const marksOf = (statement: PlurnkStatement | undefined) => statement !== undefined && "lineMarker" in statement ? statement.lineMarker?.marks : undefined;

for (const [scope, marks] of [
    ["<395,12>", [395, 406]],
    ["<395, 12>", [395, 406]],
    ["<395-12>", [395, 406]],
    ["<395,+12>", [395, 407]],
    ["<395, +12>", [395, 407]],
    ["<395,+0>", [395, 395]],
    ["<395,1>", [395, 395]],
] as const) {
    for (const op of ["FIND", "READ", "EDIT", "KILL"] as const) {
        test(`{§matcher-prefix-claims} ${op} ${scope} normalizes once without an error`, () => {
            const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (file.md) ${scope}`, op === "EDIT" ? "changed" : null));
            assertAdmitted(parsed);
            const [statement] = statementsOf(parsed);
            assert.equal(statement?.op, op);
            assert.deepEqual(statement?.lineMarker?.marks, marks);
            assert.deepEqual(warningsOf(parsed), [`Scope ${scope} was read as <${marks.join(",")}>.`]);
        });
    }
    for (const op of ["COPY", "MOVE"] as const) {
        test(`{§matcher-prefix-claims} ${op} normalizes each operand ${scope}`, () => {
            const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (a.md) ${scope} (b.md) ${scope}`, null));
            assertAdmitted(parsed);
            const [statement] = statementsOf(parsed);
            assert.ok(statement?.op === op);
            assert.deepEqual(statement.source.lineMarker?.marks, marks);
            assert.deepEqual(statement.destination.lineMarker?.marks, marks);
            assert.deepEqual(warningsOf(parsed), Array(2).fill(`Scope ${scope} was read as <${marks.join(",")}>.`));
        });
    }
}

test("{§matcher-prefix-claims} reasoning and statement scopes use the same normalization", () => {
    const reasoning = PlurnkParser.parseReasoningOperations(PlurnkParser.frame("READ (file.md) <395,+12>", null));
    assert.deepEqual(reasoning[0]?.lineMarker?.marks, [395, 407]);
    const statements = PlurnkParser.parseStatements(PlurnkParser.frame("READ (file.md) <395,12>", null));
    assert.deepEqual(statements.items.flatMap((item) => item.kind === "statement" ? [marksOf(item.statement)] : []), [[395, 406]]);
    assert.deepEqual(statements.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), ["Scope <395,12> was read as <395,406>."]);
});

test("{§matcher-prefix-claims} range syntax tolerances compose inside target parentheses", () => {
    for (const op of ["READ", "FIND"]) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (file.md <395,+12>)`, null));
        assertAdmitted(parsed);
        assert.deepEqual(marksOf(statementsOf(parsed)[0]), [395, 407]);
        assert.ok(warningsOf(parsed).includes("Scope <395,+12> was read as <395,407>."));
    }
});

test("{§matcher-prefix-claims} a scope after the pattern uses the same normalization", () => {
    for (const op of ["READ", "FIND"]) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (file.md) /needle/ <395,+12>`, null));
        assertAdmitted(parsed);
        assert.deepEqual(marksOf(statementsOf(parsed)[0]), [395, 407]);
        assert.ok(warningsOf(parsed).includes("Scope <395,+12> was read as <395,407>."));
    }
});

test("{§matcher-prefix-claims} canonical ranges, sentinels, decimals, regions and anchors retain their meaning", () => {
    for (const [scope, marks] of [
        ["<2,5>", [2, 5]], ["<2,2>", [2, 2]], ["<1,-1>", [1, -1]],
        ["<0,120>", [0, 120]], ["<5,0>", [5, 0]], ["<-3,-1>", [-3, -1]],
        ["<5.5,2>", [5.5, 2]], ["<5,2.5>", [5, 2.5]],
        ["<5,2,1>", [5, 2, 1]], ["<5,2,1,1>", [5, 2, 1, 1]],
        ["<@abcde,@fghij>", ["@abcde", "@fghij"]], ["<5,@abcde>", [5, "@abcde"]],
        ["<@abcde,+2>", ["@abcde", "@abcde+2"]],
    ] as const) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`READ (file.md) ${scope}`, null));
        assertAdmitted(parsed);
        assert.deepEqual(marksOf(statementsOf(parsed)[0]), marks, scope);
        assert.deepEqual(warningsOf(parsed), [], scope);
    }
});

test("{§matcher-prefix-claims} relative arithmetic requires a positive base and a safe endpoint", () => {
    for (const scope of ["<+2>", "<0,+2>", "<-1,+2>", "<1.5,+2>", "<5,1,+2,3>", "<9007199254740991,+1>", "<9007199254740991,2>"]) {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`READ (file.md) ${scope}`, null));
        assert.equal(statementsOf(parsed).length, 0, scope);
        assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "error" && /scope/i.test(item.error.message)), scope);
    }
});

test("{§matcher-prefix-claims} SEND and WAIT keep their owner-defined scopes", () => {
    const sent = PlurnkParser.parse(PlurnkParser.frame("SEND (sh:///test) <395,12>", "input"));
    assertAdmitted(sent);
    assert.deepEqual(marksOf(statementsOf(sent)[0]), [395, 12]);
    assert.deepEqual(warningsOf(sent), []);
    const waiting = PlurnkParser.parse(PlurnkParser.frame("WAIT <395,12>", null));
    assertAdmitted(waiting);
    assert.deepEqual(warningsOf(waiting), ["Ignored WAIT duration <395,12>."]);
});
});

describe("reasoning-operations", () => {
const frame = PlurnkParser.frame;
const parse = (source: string) => PlurnkParser.parseReasoningOperations(source);

test("{§op-shapes}: complete NOTE, FIND and READ retain source order and repeated occurrences", () => {
    const source = [
        "I need the actual contents before editing.",
        frame("NOTE", "Check the exported interface."),
        frame("FIND (workspace:///*) /interface/", null),
        frame("READ (workspace:///api.ts) <1,16>", null),
        frame("READ (workspace:///api.ts) <1,16>", null),
    ].join("\n\n");
    assert.deepEqual(parse(source).map(({ op }) => op), ["NOTE", "FIND", "READ", "READ"]);
});


test("{§op-shapes}: quotations and other operations do not execute fact-finding examples", () => {
    const example = frame("READ (workspace:///quoted.txt)", null);
    for (const fence of ["```", "`````", "`````text", "~~~markdown", "````EDIT (file.txt)", "````sh", "````WAIT"]) {
        const closer = fence.match(/^[`~]+/u)![0];
        assert.deepEqual(parse(`${fence}\n${example}\n${closer}`), [], fence);
    }
    for (const source of [
        `Example: ${example}`,
        example.split("\n").map((line) => `> ${line}`).join("\n"),
        example.split("\n").map((line) => `    ${line}`).join("\n"),
        "READ (workspace:///naked.txt)",
        "<tool_call><function=READ><parameter=path>file.txt</parameter></function></tool_call>",
    ]) assert.deepEqual(parse(source), [], source);
});

test("{§op-shapes}: fact-finding quoted inside a NOTE remains note content", () => {
    const example = frame("READ (workspace:///quoted.txt)", null);
    const source = frame("NOTE", example);
    const operations = parse(source);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].op, "NOTE");
    assert.equal(operations[0].body, example);
});

test("{§op-shapes}: only authored, closed operations survive an unfinished suffix", () => {
    for (const suffix of ["````READ (unfinished", "````READ (file.txt)\n", "````NOTE\nUnfinished", "````FIND (*)\n"]) {
        assert.deepEqual(parse(suffix), [], suffix);
        const source = `${frame("READ (workspace:///complete.txt)", null)}\n\n${suffix}`;
        assert.deepEqual(parse(source).map(({ op }) => op), ["READ"], suffix);
    }
    assert.deepEqual(parse("````READ (missing close\n````"), []);
});

test("{§op-shapes}: normalization warnings belong only to admitted operations", () => {
    const warning = "Scope <5,2> was read as <5,6>.";
    for (const source of [
        frame("READ (file.txt) <5,2>", null),
        frame("FIND (*) <5,2>", null),
    ]) {
        const warnings: string[] = [];
        const ops = PlurnkParser.parseReasoningOperations(source, (advisory) => warnings.push(advisory.message));
        assert.equal(ops.length, 1);
        assert.deepEqual(warnings, [warning]);
    }
    for (const ignored of [
        "```READ (unfinished.txt) <5,2>\n",
        frame("EDIT (file.txt) <5,2>", "replacement"),
        frame("NOTE", frame("READ (quoted.txt) <5,2>", null)),
        frame("text", frame("READ (quoted.txt) <5,2>", null)),
        frame("READ (file.txt) <9007199254740991,2>", null),
    ]) {
        const warnings: string[] = [];
        PlurnkParser.parseReasoningOperations(ignored, (advisory) => warnings.push(advisory.message));
        assert.deepEqual(warnings, [], ignored);
    }
});
});

describe("reasoning-tags", () => {
const task = PlurnkParser.frame("WAIT", "Reported the result.");
const statements = (result: ParseResult) => result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const errors = (result: ParseResult) => result.items.flatMap((item) => item.kind === "error" ? [item.error] : []);

// The shape of #784: an essay about reasoning streams whose
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

test("{§fence-pairing}: a reasoning tag written in prose does not unquote the fences after it", () => {
    // The only difference between these two essays is one phrase of prose, 20 lines above the
    // example. Prose is data: it may not change how the program after it is read.
    for (const [mention, source] of [
        ["a tag in inline code", essay("open `<think>` blocks")],
        ["the same sentence without one", essay("open reasoning blocks")],
    ] as const) {
        const result = PlurnkParser.parse(source);
        assert.deepEqual(errors(result), [], mention);
        assert.deepEqual(statements(result).map(writtenOp), ["WAIT"], mention);

        const text = result.items.flatMap((item) => item.kind === "text" ? [item.content] : []).join("");
        for (const quoted of ["```mermaid", "```plurnk", "````EDIT (src/config.ts) <@c8e11>"]) {
            assert.ok(text.includes(quoted), `${mention}: ${quoted} must remain literal text`);
        }
    }
});

test("{§provider-interface}: the grammar peels no reasoning envelope, so a tag hides nothing after it", () => {
    // A route that delivers reasoning inline declares it and the provider peels one leading
    // envelope. The grammar reads tags as text, so what follows one is read exactly as written.
    const source = `<think>\n${PlurnkParser.frame("NOTE", "Considering the timeout.")}\n</think>\n${task}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(errors(result), []);
    assert.deepEqual(statements(result).map(writtenOp), ["NOTE", "WAIT"]);
    assert.deepEqual(result.items.flatMap((item) => item.kind === "text" ? [item.content] : []), ["<think>\n", "\n</think>\n"]);
});
});

describe("recorded-emissions", () => {
const records: CorpusRecord[] = readFileSync(CORPUS, "utf8")
    .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as CorpusRecord);

test("{§whitespace-contract}: every recorded emission still parses, and to the same shape", () => {
    assert.ok(records.length >= 100, `the corpus holds ${records.length} shapes; it should not shrink silently`);
    const moved: string[] = [];
    for (const record of records) {
        const now = classify(record.emission);
        if (JSON.stringify(now.ops) !== JSON.stringify(record.ops)
            || now.outsideText !== record.outsideText
            || JSON.stringify(now.errors) !== JSON.stringify(record.errors)) {
            const was = { ops: record.ops, outsideText: record.outsideText, errors: record.errors };
            moved.push(`${record.specimen}/${record.packet} (${record.turns} recorded turns)`
                + `: was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
        }
    }
    assert.deepEqual(moved, [], "a shape moved: re-run the extractor and review what the contract now does differently");
});

test("{§whitespace-contract}: no recorded emission throws", () => {
    // A real model produced each of these. The parser owes every one of them an answer
    // under {§whitespace-contract} — a diagnostic, not a crash.
    for (const { specimen, packet, emission } of records) {
        assert.doesNotThrow(() => classify(emission), `${specimen}/${packet}`);
    }
});

test("{§whitespace-contract}: the corpus spans the contract, not one corner of it", () => {
    const ops = new Set(records.flatMap(({ ops: o }) => o));
    for (const op of ["READ", "FIND", "EDIT", "SEND", "KILL", "NOTE", "WAIT", "WORK"]) {
        assert.ok(ops.has(op), `no recorded emission authored ${op}; the corpus has a blind spot`);
    }
    assert.ok(records.some(({ outsideText }) => outsideText), "no outside text");
    assert.ok(records.some(({ errors }) => errors.length > 0), "no parser refusals: the corpus holds only valid programs");
    assert.ok(records.some(({ recordedStatus, errors }) => recordedStatus === 200 && errors.length > 0),
        "no historic success that is refused by the current grammar");
});

test("{§whitespace-contract}: the corpus carries no identifier of the machine that recorded or runs it", () => {
    const leaked = records.flatMap((record) => localIdentifiers()
        .filter(([pattern]) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(`${record.specimen}\n${record.emission}`))
        .map(([pattern]) => `${record.specimen}/${record.packet}: ${pattern.source}`));
    assert.deepEqual(leaked, []);
});
});

describe("regex-sed-range", () => {
const errorOf = (source: string): string => {
    const statements = PlurnkParser.parse(source).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    const matcher = statements[0] !== undefined && "matcher" in statements[0] ? statements[0].matcher : null;
    assert.ok(matcher !== null && matcher !== undefined && matcher.dialect === "unreadable", source);
    return matcher.dialect === "unreadable" ? matcher.message : "";
};

for (const matcher of ["/^def start/,/^def end/", "/start/, /end/", "/start/,+45", "/start/,"]) {
    test(`{§parse-recovery} {§diagnostic-observation} ${matcher} reports its range suffix without rewriting it`, () => {
        assert.equal(errorOf(`\`\`\`\`READ (example.py) ${matcher}\`\`\`\``),
            "Regex matcher contains a range suffix after its closing `/`.");
    });
}

test("{§parse-recovery} genuinely invalid flags keep the native failure", () => {
    assert.match(errorOf("````FIND (src/**) /x/z````"), /Invalid flags supplied to RegExp constructor 'z'/u);
});
});

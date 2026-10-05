import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import PlurnkParser from "./PlurnkParser.ts";

const parse = (source: string) => {
    const parsed = PlurnkParser.parse(source);
    const errors = parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []);
    const warnings = parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    return { errors, warnings, statements, items: parsed.items };
};
const matcherOf = (statement: FindStatement | ReadStatement) => statement.matcher;

test("{§matcher-refusal}: a matcher the parser cannot read is admitted with its statement, carrying the diagnostic and the working form; siblings stand", () => {
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

test("{§matcher-refusal} {§statement-rendering}: an unreadable matcher renders back as written and reparses equal", () => {
    for (const source of ["```FIND (a.py) /Enum/{5,40}\n```", "```READ (a.py) /set_ticks|set_ticklabels/_/\n```", "```READ (a.md) //[bad\n```"]) {
        const parsed = PlurnkParser.parse(source);
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements.length, 1, source);
        assert.equal(PlurnkParser.stringify(statements), source);
        assert.deepEqual(PlurnkParser.parse(PlurnkParser.stringify(statements)).items, parsed.items);
    }
});

test("{§regex-dialect-readings}: grep's `\\|` is alternation, `-i` after the slash is the flag, a glob-shaped pattern is its glob over the line; one advisory each, and a compiling regex is never rewritten", () => {
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
        assert.match(glob.warnings[0]!, /was read as the glob .* over each line/u, source);
    }

    const plain = parse("```FIND (a.py) /a*b|c/i\n```");
    const kept = matcherOf(plain.statements[0] as FindStatement);
    assert.deepEqual(kept?.dialect === "regex" ? [kept.pattern, kept.flags] : null, ["a*b|c", "i"]);
    assert.deepEqual(plain.warnings, [], "a regex that compiles is never rewritten");
    const literalPipe = parse("```FIND (a.py) /a[|]b/\n```");
    assert.equal(matcherOf(literalPipe.statements[0] as FindStatement)?.dialect, "regex");
    assert.deepEqual(literalPipe.warnings, []);
});

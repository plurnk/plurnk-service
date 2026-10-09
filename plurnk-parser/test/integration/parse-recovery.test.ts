// {§parse-recovery} — every hard diagnostic carries the working form; the refused regex of DeepSeek run429
// (`FIND (tests/*) /*url*/`) is the recorded witness (#853).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const refusals = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items
    .flatMap((item) => item.kind === "error" && item.error.severity === "error" && item.error.message !== PlurnkParser.NO_VALID_OPERATION ? [item.error] : []);
// {§matcher-refusal} — a refused matcher is admitted with its statement and carries the same pair.
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

test("{§problem-details} trailing-regex recovery states the matcher form without guessing the author's intent", () => {
    for (const pattern of ["/def copy/ -1", "/def copy/ i", "/def copy/i inspect the method"]) {
        for (const matcher of [pattern, `[${JSON.stringify({ pattern })}]`]) {
            const input = [
                "```READ (requests/models.py) <300,330>\n```",
                `\`\`\`READ (requests/models.py) ${matcher}\n\`\`\``,
                "```FIND (requests/models.py) /def copy/\n```",
                "```READ (test_requests.py) <1,60>\n```",
            ].join("\n\n");
            const { items } = PlurnkParser.parse(input);
            assert.deepEqual(items.flatMap((item) => item.kind === "error" ? [item.error] : []), [], matcher);
            const statements = items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(statements.map(({ op }) => op), ["READ", "READ", "FIND", "READ"], "every operation is admitted ({§matcher-refusal})");
            const refused = "matcher" in statements[1]! ? statements[1].matcher : null;
            if (refused === null || refused === undefined || refused.dialect !== "unreadable") assert.fail(matcher);
            assert.equal(refused.message, "Regex matcher has trailing text after `/pattern/flags`.", matcher);
            assert.equal(refused.recovery, "Write only `/pattern/flags` in the matcher; flags are optional.", matcher);
        }
    }
});

test("{§trailing-slots} valid flags, scopes and asides do not become trailing-regex errors", () => {
    for (const [heading, flags, marks, aside, warnings] of [
        ["READ (a.py) /def copy/", "", null, null, 0],
        ["READ (a.py) /def copy/i", "i", null, null, 0],
        ["READ (a.py) <1,16> /def copy/i <!-- inspect method -->", "i", [1, 16], "inspect method", 0],
        ["READ (a.py) /def copy/i <1,16> <!-- inspect method -->", "i", [1, 16], "inspect method", 1],
        ['READ (a.py) <1,16> [{"pattern":"/def copy/i"}] <!-- inspect method -->', "i", [1, 16], "inspect method", 0],
    ] as const) {
        const { items } = PlurnkParser.parse(`\`\`\`${heading}\n\`\`\``);
        const errors = items.flatMap((item) => item.kind === "error" ? [item.error] : []);
        assert.deepEqual(errors.map((error) => error.severity), Array(warnings).fill("warning"), heading);
        const statements = items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements.length, 1, heading);
        const statement = statements[0]!;
        if (statement.op !== "READ" || statement.matcher?.dialect !== "regex") assert.fail(heading);
        assert.equal(statement.matcher.pattern, "def copy", heading);
        assert.equal(statement.matcher.flags, flags, heading);
        assert.deepEqual(statement.lineMarker?.marks ?? null, marks, heading);
        assert.equal(statement.aside, aside, heading);
    }
});

test("{§regex-dialect-readings} {§parse-recovery} a glob-shaped regex is read as its glob over each line with one advisory; a broken regex carries the regex's working form", () => {
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
        ["`/*url*/` was read as the glob `*url*` over each line, the regex `/.*url.*/`; a pattern is a regex, and `*` repeats what precedes it."]); // {§pinned-wording-parser}
    assert.equal(refusedMatcher("```READ (a.py) /(unclosed/\n```").recovery,
        "A pattern is a regex written `/pattern/flags`, such as `/timeout/i`.", "{§diagnostic-observation}: the dialect's form, never a reading of the input"); // {§pinned-wording-parser}
});

test("{§parse-recovery} every grammar-level refusal names its working form", () => {
    for (const [input, recovery] of [
        ["```READ (a.py) <+1>\n```", "Write `<start,+offset>`, `<@abcde,+offset>`, or `<start,end>`."],
        ["```READ (http://exa mple.com/x)\n```", "Write a local path, `(src/a.py)`, or a complete URL, `scheme://host/path`."],
        ["```READ (a.py) [{\"pattern\": 3}]\n```", "Write the matcher as a string, `[{\"pattern\": \"/needle/i\"}]`, or bare on the opening fence line after the path."],
        ["```sh (a) (b)\n```", "`sh (program)? [{\"cwd\": \"…\"}]?` on the opening fence line, the input on the lines below, then the closing fence."],
        ["```EDIT (a.py) <1> <2>\nx\n```", "One scope per selection, such as `<12,40>` or `<@abcde,+5>`."],
        ["```READ (a.py) <line number>\n```", "`READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line; READ takes no body."],
        ["```COPY (a.py)\n```", "`COPY (from) <scope>? (to) <scope>?` on the opening fence line; COPY takes no body."],
        ["```WAIT (worker://unfinished\n```", "`WAIT (path)? <seconds>?` on the opening fence line, any body on the lines below, then the closing fence."],
        ["```EDIT (a.py) <@ab>\nx\n```", "`EDIT (path) <scope>` on the opening fence line, the replacement text on the lines below, then the closing fence."],
        ["```sh <1,2,3,4,5,6> [x\n```", "`sh (program)? [{\"cwd\": \"…\"}]?` on the opening fence line, the input on the lines below, then the closing fence."],
    ] as const) {
        const errors = refusals(input);
        assert.ok(errors.length > 0, `${input} is refused`);
        assert.equal(errors[0]!.recovery, recovery, input);
    }
    assert.equal(refusedMatcher("```FIND (a) /x/ ,/y/\n```").recovery,
        "A pattern is a regex written `/pattern/flags`, such as `/timeout/i`.", "{§regex-sed-range} gives the dialect's working form without synthesizing a query");
});

test("{§matcher-refusal} {§parse-recovery} every refused matcher carries its working form on the admitted statement", () => {
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

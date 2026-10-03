// {§parse-recovery} — every hard diagnostic carries the working form; the refused regex of DeepSeek run429
// (`FIND (tests/*) /*url*/`) is the recorded witness (#853).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const refusals = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items
    .flatMap((item) => item.kind === "error" && item.error.severity === "error" && item.error.message !== PlurnkParser.NO_VALID_OPERATION ? [item.error] : []);

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
            const errors = items.flatMap((item) => item.kind === "error" ? [item.error] : []);
            assert.equal(errors.length, 1, matcher);
            const error = errors[0]!;
            assert.deepEqual({ line: error.line, column: error.column, source: error.source, severity: error.severity },
                { line: 4, column: 0, source: "visitor", severity: "error" }, matcher);
            assert.equal(error.message, "Regex matcher has trailing text after `/pattern/flags`.", matcher);
            assert.equal(error.recovery, "Write only `/pattern/flags` in the matcher; flags are optional.", matcher);
            assert.deepEqual(items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []),
                ["READ", "FIND", "READ"], "only the malformed operation is refused");
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

test("{§parse-recovery} a glob-shaped regex is refused with the regex that matches its words and the target glob that selects files (run429)", () => {
    const [error] = refusals("```FIND (tests/*) /*url*/ <!-- test modules mentioning url -->\n```");
    assert.equal(error?.message, "pattern leads with `/` but is not a valid `/pattern/flags` regex - Invalid regular expression: /*url*/: Nothing to repeat: `/*url*/`");
    assert.equal(error?.recovery, "A pattern is a regex: write `/url/` to match lines containing url; `*` repeats what precedes it. To select files by name, put the glob in the target: `FIND (tests/*url*)`."); // {§pinned-wording-parser}
    assert.equal(refusals("```READ (django) /*.py/\n```")[0]?.recovery,
        "A pattern is a regex: write `/\\.py/` to match lines containing .py; `*` repeats what precedes it. To select files by name, put the glob in the target: `FIND (django/*.py)`.");
    assert.equal(refusals("```FIND (src/a.py) /?x/\n```")[0]?.recovery,
        "A pattern is a regex: write `/x/` to match lines containing x; `*` and `?` repeat what precedes them. To select files by name, put the glob in the target: `FIND (src/?x)`.");
    assert.equal(refusals("```READ (a.py) /(unclosed/\n```")[0]?.recovery,
        "A pattern is a regex written `/pattern/flags`; escape a literal `*`, `+`, `?`, `(`, `[` or `.` with `\\`.", "not glob-shaped: the regex sentence alone");
});

test("{§parse-recovery} every grammar-level refusal names its working form", () => {
    for (const [input, recovery] of [
        ["```READ (a.md) /\n```", "Write `/pattern/flags`, flags optional, such as `/timeout/i`."],
        ["```READ (a.md) //[bad\n```", "Write an XPath 1.0 selector after `//`, such as `//dependencies/*`; a text search is a regex, `/needle/`."],
        ["```READ (a.json) $.[\n```", "Write an RFC 9535 JSONPath after `$`, such as `$.items[?(@.price>500)]`; a text search is a regex, `/needle/`."],
        ["```READ (a.py) &\n```", "Write `&symbol` for a symbol, `&<symbol` for what calls it, or `&>symbol` for what it calls."],
        ["```READ (a.py) /a/i extra\n```", "Write only `/pattern/flags` in the matcher; flags are optional."],
        ["```READ (a.py) <+1>\n```", "Write `<start,+offset>`, `<@abcde,+offset>`, or `<start,end>`."],
        ["```READ (http://exa mple.com/x)\n```", "Write a local path, `(src/a.py)`, or a complete URL, `scheme://host/path`."],
        ["```READ (a.py) [{\"pattern\": 3}]\n```", "Write the matcher as a string, `[{\"pattern\": \"/needle/i\"}]`, or bare on the opening fence line after the path."],
        ["```sh (a) (b)\n```", "Write one `(program)` path on the `sh` heading, and the rest below it as the input."],
        ["```EDIT (a.py) <1> <2>\nx\n```", "Write one scope, such as `<2>`."],
        ["```READ (a.py) <line number>\n```", "`READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line; READ takes no body."],
        ["```READ (a.py) (b.py)\n```", "`READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line; READ takes no body."],
        ["```COPY (a.py)\n```", "`COPY (from) <scope>? (to) <scope>?` on the opening fence line; COPY takes no body."],
        ["```WAIT (worker://unfinished\n```", "`WAIT (path)? <seconds>?` on the opening fence line, any body on the lines below, then the closing fence."],
        ["```EDIT (a.py) <@ab>\nx\n```", "`EDIT (path) <scope>` on the opening fence line, the replacement text on the lines below, then the closing fence."],
        ["```sh <1,2,3,4,5,6> [x\n```", "`sh (program)? [{\"cwd\": \"…\"}]?` on the opening fence line, the input on the lines below, then the closing fence."],
    ] as const) {
        const errors = refusals(input);
        assert.ok(errors.length > 0, `${input} is refused`);
        assert.equal(errors[0]!.recovery, recovery, input);
    }
    for (const error of refusals("```FIND (a) /x/ ,/y/\n```")) assert.match(error.recovery ?? "", /^Match both ends with `\/x\|y\/`/u, "{§regex-sed-range} keeps its forms as the recovery");
});

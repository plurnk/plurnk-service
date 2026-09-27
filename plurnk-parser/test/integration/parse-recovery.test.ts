// {§parse-recovery} — every hard diagnostic carries the working form; the refused regex of DeepSeek run429
// (`FIND (tests/*) /*url*/`) is the recorded witness (#853).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const refusals = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] }).items
    .flatMap((item) => item.kind === "error" && item.error.severity === "error" && item.error.message !== PlurnkParser.NO_VALID_OPERATION ? [item.error] : []);

test("{§parse-recovery} a glob-shaped regex is refused with the regex that matches its words and the target glob that selects files (run429)", () => {
    const [error] = refusals("```FIND (tests/*) /*url*/ <!-- test modules mentioning url -->\n```");
    assert.equal(error?.message, "pattern leads with `/` but is not a valid `/pattern/flags` regex - Invalid regular expression: /*url*/: Nothing to repeat: `/*url*/`");
    assert.equal(error?.recovery, "A pattern is a regex: write `/url/` to match lines containing url; `*` repeats what precedes it. To select files by name, put the glob in the target: `FIND (tests/*url*)`.");
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
        ["```READ (a.py) /a/i extra\n```", "Write the flags directly after the closing `/`, as `/pattern/i`, and a note as `<!-- … -->`."],
        ["```READ (a.py) <+1>\n```", "Count from an anchor, `<@abcde,+1>`, or write line numbers, `<L,M>`."],
        ["```READ (http://exa mple.com/x)\n```", "Write a local path, `(src/a.py)`, or a complete URL, `scheme://host/path`."],
        ["```READ (a.py) [{\"pattern\": 3}]\n```", "Write the matcher as a string, `[{\"pattern\": \"/needle/i\"}]`, or bare on the opening fence line after the path."],
        ["```sh (a) (b)\n```", "Write one `(program)` path on the `sh` heading, and the rest below it as the input."],
        ["```EDIT (a.py) <1> <2>\nx\n```", "Write one scope, such as `<2>`."],
        ["```READ (a.py) <line number>\n```", "`READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line; READ takes no body."],
        ["```READ (a.py) (b.py)\n```", "`READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line; READ takes no body."],
        ["```COPY (a.py)\n```", "`COPY (from) <scope>? (to) <scope>?` on the opening fence line; COPY takes no body."],
        ["```EDIT (a.py) <@ab>\nx\n```", "`EDIT (path) <scope>` on the opening fence line, the replacement text on the lines below, then the closing fence."],
        ["```sh <1,2,3,4,5,6> [x\n```", "`sh (program)? [{\"cwd\": \"…\"}]?` on the opening fence line, the input on the lines below, then the closing fence."],
    ] as const) {
        const errors = refusals(input);
        assert.ok(errors.length > 0, `${input} is refused`);
        assert.equal(errors[0]!.recovery, recovery, input);
    }
    for (const error of refusals("```FIND (a) /x/ ,/y/\n```")) assert.match(error.recovery ?? "", /^Match both ends with `\/x\|y\/`/u, "{§regex-sed-range} keeps its forms as the recovery");
});

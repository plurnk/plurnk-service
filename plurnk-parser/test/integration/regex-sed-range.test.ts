import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const errorOf = (source: string): string => {
    const errors = PlurnkParser.parse(source).items.flatMap((item) => item.kind === "error" ? [item.error.message] : []);
    assert.ok(errors.length >= 1, source);
    return errors[0]!;
};

// The recorded shapes (#853, orox): a sed address range was answered as invalid regex flags.
test("{§regex-sed-range} a `/a/,/b/` range says it is a sed range and gives the two-step form", () => {
    assert.equal(
        errorOf("````READ (tests/test_ext_autodoc.py) /^def do_autodoc/,/^@pytest/````"),
        "`/^def do_autodoc/,/^@pytest/` is a sed line range; a matcher is one regex and selects only the lines it matches, never the lines between matches. Match both ends with `/^def do_autodoc|^@pytest/` to learn their line numbers, then address the span by scope: `<first,last>`.",
    );
    assert.match(errorOf("````FIND (django/forms/widgets.py) /def visit_Call_35/, /def visit_Call_legacy/````"), /Match both ends with `\/def visit_Call_35\|def visit_Call_legacy\/`/u);
});

test("{§regex-sed-range} a `/a/,+N` range gives the start and the count as a scope", () => {
    assert.equal(
        errorOf("````READ (django/views/debug.py) /def technical_404_response/,+45````"),
        "`/def technical_404_response/,+45` is a sed line range; a matcher is one regex and selects only the lines it matches, never the lines between matches. Match the start with `/def technical_404_response/` to learn its line number, then address the span by scope: `<N,M>`, M being N + 45.",
    );
});

test("{§regex-sed-range} genuinely invalid flags keep the native failure", () => {
    assert.match(errorOf("````FIND (src/**) /x/z````"), /Invalid flags supplied to RegExp constructor 'z'/u);
});

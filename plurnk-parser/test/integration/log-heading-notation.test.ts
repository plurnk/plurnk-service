// {§log-heading-notation} {§bare-target} {§bare-anchor-scope} — the packet's log heading notation and a bare
// target or anchor, replayed from recorded benchmark headings (glm, orox, rtx5070, zai, qflash; #853).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const parse = (input: string) => PlurnkParser.parse(input, { executors: ["sh", "python3"] });
const statements = (input: string) => parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const warnings = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
const errors = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []);
const heading = (input: string) => PlurnkParser.heading(statements(input)[0]!);
// {§parse-recovery} — a refusal with the working form it carries.
const refusal = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "error" && item.error.message !== PlurnkParser.NO_VALID_OPERATION ? [`${item.error.message} ${item.error.recovery}`] : []);

test("{§log-heading-notation} `READ → path <scope>` reads the arrow's path as the target and writes the parenthesized line", () => {
    const input = "```READ → sh:///verify-pytest#stdout <1,50>\n```";
    assert.equal(heading(input), "READ (sh:///verify-pytest#stdout) <1,50>");
    assert.deepEqual(errors(input), []);
    assert.deepEqual(warnings(input), ["`→ sh:///verify-pytest#stdout` is how the log shows an address; it was read as the target. Write the target in parentheses: `READ (sh:///verify-pytest#stdout) <1,50>`."]);
});

test("{§log-heading-notation} the arrow keeps the pattern and aside after it (recorded FIND), and serves every targeted operation", () => {
    const find = "```FIND → tests/test_ext_autodoc.py /def do_autodoc/ <!-- copy the canonical harness -->\n```";
    assert.equal(heading(find), "FIND (tests/test_ext_autodoc.py) /def do_autodoc/ <!-- copy the canonical harness -->");
    assert.equal(heading("```WAIT → sh:///1d114c27\n```"), "WAIT (sh:///1d114c27)");
    assert.equal(heading("```python3 → repro_redirect.py <!-- run the reproduction script -->\n```"), "python3 (repro_redirect.py) <!-- run the reproduction script -->");
    const kill = statements("```KILL → log:///1/2/3/READ\n```")[0]!;
    assert.equal(kill.op === "KILL" ? kill.target?.raw : null, "log:///1/2/3/READ", "a targeted KILL, never a deliverable reading `→ …`");
    const copy = "```COPY → a.md → b.md\n```";
    assert.equal(heading(copy), "COPY (a.md) (b.md)");
    assert.equal(warnings(copy).length, 1, "one corrected line for both operands");
});

test("{§log-heading-notation} an EDIT's `→ path <anchors> · N` keeps its body whole and drops the charge (recorded glm heading)", () => {
    const input = "``````EDIT → docs/topics/forms/formsets.txt <@hASJm,@PKoTc> · 289\nThe replacement line.\n``````";
    const [edit] = statements(input);
    assert.equal(edit?.op === "EDIT" ? edit.body : null, "The replacement line.");
    assert.equal(heading(input), "EDIT (docs/topics/forms/formsets.txt) <@hASJm,@PKoTc>");
    assert.ok(warnings(input).includes("`· 289` is the token charge the log shows on a heading; it is not part of an operation and was ignored."));
});

test("{§log-heading-notation} the token charge is dropped wherever it stands, never read as a glob (recorded orox and qflash headings)", () => {
    for (const [input, canonical, charge] of [
        ["```FIND (tests/urls/**) /Http404/ · 120\n```", "FIND (tests/urls/**) /Http404/", "· 120"],
        ["```READ (sympy/printing/ccode.py) <1,24> <!-- imports --> · 320 tokens\n```", "READ (sympy/printing/ccode.py) <1,24> <!-- imports -->", "· 320 tokens"],
        ["```FIND → tests/delete/settings.py · 60\n```", "FIND (tests/delete/settings.py)", "· 60"],
        ["```READ (a.py) · 50\n```", "READ (a.py)", "· 50"],
    ] as const) {
        assert.equal(heading(input), canonical, input);
        assert.ok(warnings(input).includes(`\`${charge}\` is the token charge the log shows on a heading; it is not part of an operation and was ignored.`), input);
        assert.deepEqual(errors(input), [], input);
    }
    const [note] = statements("``````NOTE · 89\nKept.\n``````");
    assert.equal(note?.op === "NOTE" ? note.body : null, "Kept.", "a charge on a NOTE heading never joins its body");
    const scoped = "```READ → testing/test_assertion.py · <333,350>\n```";
    assert.equal(heading(scoped), "READ (testing/test_assertion.py) <333,350>");
    assert.ok(warnings(scoped).includes("`·` is how the log separates a heading from its token charge; it is not part of an operation and was ignored."));
});

test("{§log-heading-notation} ` · words` after the slots or a closed regex is the aside (recorded qflash FIND)", () => {
    const input = "```FIND (sympy/simplify/powsimp.py) /Neg|-\\*\\*|coeff is_Symbol and b\\.is_positive|splitting|extract/i · sign-handling in powsimp\n```";
    const [find] = statements(input);
    assert.equal(find?.aside, "sign-handling in powsimp");
    assert.equal(find?.op === "FIND" ? find.matcher?.raw : null, "/Neg|-\\*\\*|coeff is_Symbol and b\\.is_positive|splitting|extract/i");
    assert.deepEqual(warnings(input), ["`· sign-handling in powsimp` was read as the aside; a note on an operation is written `<!-- sign-handling in powsimp -->`."]);
    assert.equal(statements("```READ (a.py) · first lines\n```")[0]?.aside, "first lines");
});

test("{§log-heading-notation} a middle-dot note before a comment is stray text: the comment is the aside (recorded deepseek FIND, #1005)", () => {
    const input = "```FIND (src/_pytest/assertion/util.py) <84,180> \u00B7 no <!-- read the seq/diff helpers -->\n```";
    const [find] = statements(input);
    assert.equal(find?.aside, "read the seq/diff helpers", "the comment wins; nothing nests");
    assert.deepEqual(find?.op === "FIND" ? find.lineMarker : null, { marks: [84, 180] });
    assert.equal(heading(input), "FIND (src/_pytest/assertion/util.py) <84,180> <!-- read the seq/diff helpers -->");
    assert.deepEqual(warnings(input), ["`\u00B7 no` was ignored; the aside is `<!-- read the seq/diff helpers -->`."]);
    assert.equal(statements("```READ (a.py) \u00B7 first lines\n```")[0]?.aside, "first lines", "a dot note with no comment is still the aside");
});

test("{§bare-target} a target written without parentheses is refused with the line that runs (recorded headings)", () => {
    assert.deepEqual(errors("```READ sphinx/ext/autodoc/__init__.py <682,695>\n```"), [
        "`READ` has no target: `sphinx/ext/autodoc/__init__.py` stands where the target goes.",
        PlurnkParser.NO_VALID_OPERATION,
    ]);
    // {§parse-recovery} — the corrected line is the recovery.
    assert.deepEqual(refusal("```READ sphinx/ext/autodoc/__init__.py <682,695>\n```"),
        ["`READ` has no target: `sphinx/ext/autodoc/__init__.py` stands where the target goes. Write the target in parentheses: `READ (sphinx/ext/autodoc/__init__.py) <682,695>`."]);
    assert.deepEqual(refusal("```FIND tests/migrations/test_writer.py /gettext_lazy|^import|^from/\n```"),
        ["`FIND` has no target: `tests/migrations/test_writer.py` stands where the target goes. Write the target in parentheses: `FIND (tests/migrations/test_writer.py) /gettext_lazy|^import|^from/`."]);
    assert.deepEqual(refusal("```EDIT a.py <1,4>\nnew\n```"),
        ["`EDIT` has no target: `a.py` stands where the target goes. Write the target in parentheses: `EDIT (a.py) <1,4>`."]);
    const [kill] = statements("```KILL The answer is 42.\n```");
    assert.equal(kill?.op === "KILL" ? kill.body : null, "The answer is 42.", "a targetless KILL's heading text stays its deliverable");
});

test("{§bare-anchor-scope} an EDIT's bare `@hash` or `@start,@end` is its scope, never body (recorded rtx5070 headings)", () => {
    const one = "```EDIT (sympy/utilities/iterables.py) @ZLWyt\n    yield ms\n```";
    const [edit] = statements(one);
    assert.deepEqual(edit?.op === "EDIT" ? edit.lineMarker : null, { marks: ["@ZLWyt"] });
    assert.equal(edit?.op === "EDIT" ? edit.body : null, "    yield ms");
    assert.deepEqual(warnings(one), ["`@ZLWyt` was read as the scope `<@ZLWyt>`; a scope is written in angle brackets."]);
    const range = statements("```EDIT (src/_pytest/assertion/util.py) @xaVKr,@YZ8So <!-- widen -->\nbody\n```")[0];
    assert.deepEqual(range?.op === "EDIT" ? range.lineMarker : null, { marks: ["@xaVKr", "@YZ8So"] });
    assert.equal(range?.aside, "widen");
    const read = statements("```READ (tests/test_mock.py) @patch\n```")[0];
    assert.equal(read?.op === "READ" ? read.matcher?.raw : null, "@patch", "on READ it stays the literal search");
    assert.deepEqual(refusal("```EDIT (requests/sessions.py) <91> @HecMB\nx\n```"),
        ["A resource selection takes one scope, and `<91>` and `<@HecMB>` both stand here. Write one scope, such as `<@HecMB>`: the anchor names its line."]);
});

test("{§bare-anchor-scope} two scopes on one resource: two ends are one range, two ranges are two operations (#1005)", () => {
    assert.deepEqual(refusal("```READ (doc/usage.rst) <@wC8Pt> <-1>\n```"),
        ["A resource selection takes one scope, and `<@wC8Pt>` and `<-1>` both stand here. Write one scope with both ends, such as `<@wC8Pt,-1>`."]);
    assert.deepEqual(refusal("```READ (sklearn/model_selection/_split.py) <105,106> <1066,1300>\n```"),
        ["A resource selection takes one scope, and `<105,106>` and `<1066,1300>` both stand here. Write one scope; select each of `<105,106>` and `<1066,1300>` with its own operation."]);
});

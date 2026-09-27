// {§native-tool-calls} — recorded DSML emissions read as the operations they name (#760).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const EXECUTORS = ["sh", "node"];
const read = (input: string) => PlurnkParser.parse(input, { executors: EXECUTORS });
const ops = (input: string) => read(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const canonical = (fence: string) => PlurnkParser.parse(fence, { executors: EXECUTORS }).items.flatMap((item) => item.kind === "statement" ? [{ ...item.statement, position: undefined }] : []);
const withoutPosition = <T extends object>(statements: T[]) => statements.map((statement) => ({ ...statement, position: undefined }));

test("{§native-tool-calls} a DSML READ with path and scope parameters is that READ (engine-edit-probe-kSoo0p)", () => {
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

test("{§native-tool-calls} a DSML WAIT naming a worker and a DSML sh with a verbatim heading and plain body lines", () => {
    const wait = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"WAIT\">", "<parameter name=\"path\">worker://codename-lookup</｜｜DSML｜｜ parameter>", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(withoutPosition(ops(wait)), canonical("````WAIT (worker://codename-lookup)\n````"));

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

test("{§native-tool-calls} an unknown invoke or parameter, or markup beside a real operation, is left as it was", () => {
    const unknownName = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"36\">", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(ops(unknownName), []);
    const unknownParameter = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"READ\">", "<｜｜DSML｜｜ parameter name=\"height\">3</｜｜DSML｜｜ parameter>", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(ops(unknownParameter), []);
    const beside = "````READ (a.md)\n````\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\" path=\"b.md\" />\n</｜｜DSML｜｜ calls>";
    assert.deepEqual(ops(beside).map((statement) => "target" in statement ? statement.target?.raw : null), ["a.md"]);
});

// {§native-tool-calls} — the other popular families read the same way, from recorded emissions where
// they exist and from each vendor's documented shape.
test("{§native-tool-calls} MiMo's inline <tool_call><function=READ><parameter=file_path> pair is two READs", () => {
    const input = "<tool_call><function=READ><parameter=file_path>/Users/dev/workspace-71d1a807/django/urls/resolvers.py</parameter></function></tool_call><tool_call><function=READ><parameter=file_path>/Users/dev/workspace-71d1a807/django/core/handlers/exception.py</parameter></function></tool_call>";
    assert.deepEqual(read(input).items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(withoutPosition(ops(input)), canonical("````READ (/Users/dev/workspace-71d1a807/django/urls/resolvers.py)\n````\n\n````READ (/Users/dev/workspace-71d1a807/django/core/handlers/exception.py)\n````"));
});

test("{§native-tool-calls} MiMo's hybrid <function=NOTE> with a bare body and <function=READ (path) <scope>> with plurnk slots", () => {
    const input = "<tool_call><function=NOTE><resolve Http404 in path converter to_python → technical 404 response under DEBUG></function></tool_call><tool_call><function=READ (django/urls/resolvers.py) <1,-1></function></tool_call>";
    assert.deepEqual(withoutPosition(ops(input)), canonical("````NOTE\n<resolve Http404 in path converter to_python → technical 404 response under DEBUG>\n````\n\n````READ (django/urls/resolvers.py) <1,-1>\n````"));
});

test("{§native-tool-calls} a Hermes JSON tool_call and a GLM key/value tool_call are the operations they name", () => {
    const hermes = "<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"worker:///notes.md\", \"scope\": \"1,20\"}}\n</tool_call>";
    assert.deepEqual(withoutPosition(ops(hermes)), canonical("````READ (worker:///notes.md) <1,20>\n````"));
    const glm = "<tool_call>FIND\n<arg_key>path</arg_key>\n<arg_value>django/urls/*.py</arg_value>\n<arg_key>pattern</arg_key>\n<arg_value>def resolve</arg_value>\n</tool_call>";
    assert.deepEqual(withoutPosition(ops(glm)), canonical("````FIND (django/urls/*.py) [{\"pattern\":\"def resolve\"}]\n````"));
});

test("{§native-tool-calls} Anthropic-style function_calls, Mistral [TOOL_CALLS], Llama <|python_tag|> and Kimi call sections", () => {
    const anthropic = "<function_calls>\n<invoke name=\"NOTE\">\n<parameter name=\"body\">Root cause found.</parameter>\n</invoke>\n<invoke name=\"sh\">\n<parameter name=\"command\">git status --short</parameter>\n</invoke>\n</function_calls>";
    assert.deepEqual(withoutPosition(ops(anthropic)), canonical("````NOTE\nRoot cause found.\n````\n\n````sh\ngit status --short\n````"));
    const mistral = "[TOOL_CALLS][{\"name\": \"READ\", \"arguments\": {\"path\": \"django/views/debug.py\"}}, {\"name\": \"WAIT\", \"arguments\": {}}]";
    assert.deepEqual(withoutPosition(ops(mistral)), canonical("````READ (django/views/debug.py)\n````\n\n````WAIT\n````"));
    const llama = "<|python_tag|>{\"name\": \"READ\", \"parameters\": {\"path\": \"django/views/debug.py\", \"range\": \"455,523\"}}<|eom_id|>";
    assert.deepEqual(withoutPosition(ops(llama)), canonical("````READ (django/views/debug.py) <455,523>\n````"));
    const kimi = "<|tool_calls_section_begin|><|tool_call_begin|>functions.READ:0<|tool_call_argument_begin|>{\"path\": \"django/views/debug.py\"}<|tool_call_end|><|tool_call_begin|>functions.sh:1<|tool_call_argument_begin|>{\"command\": \"python3 /tmp/repro.py\"}<|tool_call_end|><|tool_calls_section_end|>";
    assert.deepEqual(withoutPosition(ops(kimi)), canonical("````READ (django/views/debug.py)\n````\n\n````sh\npython3 /tmp/repro.py\n````"));
});

test("{§native-tool-calls} a call naming a tool plurnk does not have, or a parameter it cannot place, leaves the emission as it was", () => {
    for (const input of [
        "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"x\"}}\n</tool_call>",
        "<tool_call><function=EDIT><parameter=old_string>a</parameter><parameter=new_string>b</parameter></function></tool_call>",
        "[TOOL_CALLS][{\"name\": \"READ\", \"arguments\": {\"encoding\": \"utf8\"}}]",
        "<|tool_call_begin|>functions.bash:0<|tool_call_argument_begin|>{\"command\": \"ls\"}<|tool_call_end|>",
    ]) {
        assert.deepEqual(ops(input), [], `no operation is invented from ${input.slice(0, 40)}`);
    }
});

test("{§native-tool-calls} prose around a block survives on its own lines, and a quoted block is an example", () => {
    const input = "Let me look.\n<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"a.md\"}}\n</tool_call>\nThen decide.";
    const result = read(input);
    assert.deepEqual(withoutPosition(ops(input)), canonical("````READ (a.md)\n````"));
    assert.deepEqual(result.items.filter((item) => item.kind === "text").map((item) => item.kind === "text" ? item.content.trim() : ""), ["Let me look.", "Then decide."]);
    const quoted = "````\n<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"a.md\"}}\n</tool_call>\n````";
    assert.deepEqual(ops(quoted), [], "a fenced example of the markup never runs");
});

test("{§native-tool-calls} start/end and offset/limit parameters are one scope; a DSML block on one line reads like one on many (deepdumb, django-11620)", () => {
    const deepdumb = "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\">\n<｜｜DSML｜｜ parameter name=\"path\" string=\"true\">ops://daeb2d14/1/25</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name=\"start\" string=\"false\">1</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name=\"end\" string=\"false\">-1</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>";
    assert.deepEqual(withoutPosition(ops(deepdumb)), canonical("````READ (ops://daeb2d14/1/25) <1,-1>\n````"));
    const offset = "<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"file_path\": \"django/views/debug.py\", \"offset\": 455, \"limit\": 20}}\n</tool_call>";
    assert.deepEqual(withoutPosition(ops(offset)), canonical("````READ (django/views/debug.py) <455,474>\n````"));
    const inline = "<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name=\"READ\"><｜｜DSML｜｜ parameter name=\"path\" string=\"true\">sh:///9c471159#stdout</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name=\"range\" string=\"true\"><100,-1></｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>";
    assert.deepEqual(withoutPosition(ops(inline)), canonical("````READ (sh:///9c471159#stdout) <100,-1>\n````"));
    assert.deepEqual(ops("<tool_call>\n{\"name\": \"READ\", \"arguments\": {\"path\": \"a.md\", \"limit\": 5}}\n</tool_call>"), [], "a count without a first line names no scope");
});

// {§native-tool-calls} — Qwen's own shapes, verbatim from recorded qflash no-operation turns (#853).
test("{§native-tool-calls} a flat JSON call names its operation with an `op`, `OP`, `action` or `cmd` key, trailing closers being noise", () => {
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

test("{§native-tool-calls} `<function=READ>` with a JSON body, `<function=OP>` around a call or a heading, and a JSON-array scope", () => {
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

test("{§native-tool-calls} `<NOTE>`, `<FIND (…)>`, `<op op=…>`, `<ops><op verb=…/></ops>`, `<op=READ …>` and a bare heading in the call", () => {
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

test("{§native-tool-calls} a targeted operation that names no target is not read, and an EDIT's content never supplies one", () => {
    assert.deepEqual(ops("<tool_call>\n<function=READ>\n<scope>@L4XSj</scope>\n</function>\n</tool_call>"), []);
    assert.deepEqual(ops("<tool_call>\n<EDIT>\n(django/forms/widgets.py) <9,9>\n{\"lines\":1,\"resource\":\"edit://20af9b7e/1/45/1\"}\n</EDIT>"), [], "an echoed receipt is never written into a file");
});

test("{§native-tool-call-receipt} markup that was not read is named with the fenced form that runs", () => {
    const receipt = (input: string) => read(input).items.flatMap((item) => item.kind === "error" && item.error.severity === "error" ? [item.error.message] : []);
    assert.deepEqual(receipt("<tool_call>\n<EDIT>\n(django/forms/widgets.py) <9,9>\n{\"lines\":1}\n</EDIT>"), [
        "`<tool_call>` is tool-call markup, which plurnk does not run, so nothing ran. An operation is a fenced block: three backticks and `EDIT (django/forms/widgets.py)` on the opening line.",
        PlurnkParser.NO_VALID_OPERATION,
    ]);
    assert.equal(receipt("<tool_call>\n{\"name\":\"Bash\",\"input\":{\"command\":\"cd /workspace && git status\"}}\n</tool_call>")[0],
        "`<tool_call>` is tool-call markup, which plurnk does not run, so nothing ran. An operation is a fenced block: three backticks and `sh` on the opening line, the command on the lines below it, and three backticks to close.");
    assert.equal(receipt("<tool_call>\n{\"text\": \"Let me fix the `_css` property.\", \"type\": \"note\"}\n</tool_call>")[0],
        "`<tool_call>` is tool-call markup, which plurnk does not run, so nothing ran. An operation is a fenced block: three backticks and `NOTE` on the opening line, the note on the lines below it, and three backticks to close.");
    assert.equal(receipt("<tool_call>\n<tool_call>\n<tool_call>")[0],
        "`<tool_call>` is tool-call markup, which plurnk does not run, so nothing ran. An operation is a fenced block: three backticks and the operation with its target, such as `READ (path)`, on the opening line.");
    const beside = read("````READ (a.md)\n````\n\n<tool_call>\n<tool_call>");
    assert.ok(beside.items.every((item) => item.kind !== "error" || !item.error.message.includes("tool-call markup")), "an emission that ran an operation draws no receipt");
});

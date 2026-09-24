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
// they exist (MiMo v2.6 flash, django-11620, 2026-09-24) and from each vendor's documented shape.
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
        "[TOOL_CALLS][{\"name\": \"READ\", \"arguments\": {\"offset\": 3}}]",
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

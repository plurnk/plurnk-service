import test from "node:test";
import assert from "node:assert/strict";
import ExecutableTools from "./ExecutableTools.ts";

test("{§tools-capability-sheet} renders every registered selector from its invocation contract", () => {
    const rendered = ExecutableTools.render([
        {
            runtime: "bash",
            invocation: {
                body: { role: "Bash program; stdin with a targeted script file", required: false },
                target: { role: "script file", required: false, kind: "resource", directory: "cwd" },
            },
        },
        {
            runtime: "search",
            invocation: { body: { role: "search query", required: true } },
        },
        {
            runtime: "mcpserver",
            invocation: {
                body: { role: "JSON arguments", required: false },
                target: { role: "MCP tool", required: true, kind: "literal" },
            },
        },
        {
            runtime: "wat",
            invocation: {
                body: { role: "inline WAT module", required: false },
                target: { role: "WAT module", required: false, kind: "resource" },
                exclusive: true,
            },
        },
    ]);

    assert.equal(rendered, [
        "EXEC bodies are literal tool input; Markdown fences are passed through. For body-only EXEC, omit `(target)` and put the body immediately below `## EXEC0 [executor]`; optional `<timeout,poll>` belongs on any EXEC heading. Every EXEC needs at least one input. Unmarked inputs are required; `?` is optional; paired `↔` inputs require exactly one; `—` is not accepted.",
        "",
        "| `[executor]` | `(target)` | body |",
        "| --- | --- | --- |",
        "| `[bash]` | script file or local directory with body ? | Bash program; stdin with a targeted script file ? |",
        "| `[mcpserver]` | MCP tool | JSON arguments ? |",
        "| `[search]` | — | search query |",
        "| `[wat]` | WAT module ↔ | inline WAT module ↔ |",
    ].join("\n"));
});

test("{§tools-capability-sheet} escapes plugin-authored table delimiters", () => {
    assert.match(
        ExecutableTools.render([{
            runtime: "fixture",
            invocation: { body: { role: "query | program", required: true } },
        }]),
        /query \\\| program/,
    );
});

import test from "node:test";
import assert from "node:assert/strict";
import ExecutableTools from "./ExecutableTools.ts";

test("{§tools-capability-sheet} renders every registered selector from its invocation contract", () => {
    const rendered = ExecutableTools.render([
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
        "Every EXEC requires a body or `(target)`. `required` marks stricter rules; `either/or` forbids supplying both. `<timeout,poll>` applies to every tool. `—` means the bucket is not accepted.",
        "",
        "| `[executor]` | `(target)` | body |",
        "| --- | --- | --- |",
        "| `[mcpserver]` | MCP tool (required) | JSON arguments |",
        "| `[search]` | — | search query (required) |",
        "| `[wat]` | WAT module (either/or) | inline WAT module (either/or) |",
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

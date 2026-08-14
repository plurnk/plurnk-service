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
                example: { body: "npm test" },
            },
        },
        {
            runtime: "search",
            invocation: {
                body: { role: "search query", required: true },
                example: { body: "Plurnk agent protocol" },
            },
        },
        {
            runtime: "mcpserver",
            invocation: {
                body: { role: "JSON arguments", required: false },
                target: { role: "MCP tool", required: true, kind: "literal" },
                example: { target: "get_issue", body: "{}" },
            },
        },
        {
            runtime: "wat",
            invocation: {
                body: { role: "inline WAT module", required: false },
                target: { role: "WAT module", required: false, kind: "resource" },
                exclusive: true,
                example: { target: "module.wat" },
            },
        },
    ]);

    assert.match(rendered, /^YOU SHOULD use purpose-built Plurnk OPs/m);
    assert.match(rendered, /^`\?` optional · `↔` choose one · `—` unavailable · `<timeout,poll>` optional$/m);
    assert.match(rendered, /^\| `\[executor\]` \| `\(target\)` \| body \| example \|$/m);
    assert.match(rendered, /\| `\[bash\]` \| script file or local directory with body \? \| Bash program; stdin with a targeted script file \? \| `## EXEC0 \[bash\]`<br>`npm test` \|/);
    assert.match(rendered, /\| `\[mcpserver\]` \| MCP tool \| JSON arguments \? \| `## EXEC0 \[mcpserver\] \(get_issue\)`<br>`\{\}` \|/);
    assert.match(rendered, /\| `\[search\]` \| — \| search query \| `## EXEC0 \[search\]`<br>`Plurnk agent protocol` \|/);
    assert.match(rendered, /\| `\[wat\]` \| WAT module ↔ \| inline WAT module ↔ \| `## EXEC0 \[wat\] \(module\.wat\)` \|/);
});

test("{§tools-capability-sheet} escapes plugin-authored table delimiters", () => {
    assert.match(
        ExecutableTools.render([{
            runtime: "fixture",
            invocation: {
                body: { role: "query | program", required: true },
                example: { body: "alpha | beta" },
            },
        }]),
        /query \\| program.*alpha \\| beta/,
    );
});

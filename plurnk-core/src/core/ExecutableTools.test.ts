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
                example: { body: "capital of indiana in 1816" },
            },
        },
        {
            runtime: "mcpserver",
            exactTarget: "issue_read",
            invocation: {
                body: { role: "JSON arguments", required: false },
                target: { role: "Read an issue", required: true, kind: "literal" },
                signature: '{"owner": string, "repo": string, "issue_number": integer, "method"?: "get" | "get_comments"}',
            },
        },
        {
            runtime: "mcpserver",
            exactTarget: "issue)write",
            invocation: {
                body: { role: "JSON arguments", required: true },
                target: { role: "Write an issue", required: true, kind: "literal" },
                signature: '{"owner": string, "repo": string, "issue_number": integer, "body": string}',
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
    assert.match(rendered, /^\| `\[executor\]` \| `\(target\)` \| body \| Invocation \|$/m);
    assert.match(rendered, /\| `\[bash\]` \| script file or local directory with body \? \| Bash program; stdin with a targeted script file \? \| `npm test` \|/);
    assert.doesNotMatch(rendered, /\(get_issue\)/, "the exact registry contains no generic row");
    assert.match(rendered, /\| `\[mcpserver\]` \| `\(issue_read\)`<br>Read an issue \| JSON arguments \? \| `\{"owner": string, "repo": string, "issue_number": integer, "method"\?: "get" \\| "get_comments"\}` \|/);
    assert.ok(rendered.includes('| `[mcpserver]` | `(issue\\)write)`<br>Write an issue | JSON arguments | `{"owner": string, "repo": string, "issue_number": integer, "body": string}` |'));
    assert.match(rendered, /\| `\[search\]` \| — \| search query \| `capital of indiana in 1816` \|/);
    assert.match(rendered, /\| `\[wat\]` \| `\(module\.wat\)`<br>WAT module ↔ \| inline WAT module ↔ \| `bodyless` \|/);
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

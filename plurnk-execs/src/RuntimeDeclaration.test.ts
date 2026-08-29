import test from "node:test";
import assert from "node:assert/strict";
import RuntimeDeclaration from "./RuntimeDeclaration.ts";

test("{§executor-runtime-declaration} validates the complete runtime declaration", () => {
    assert.deepEqual(RuntimeDeclaration.assert({
        name: "mcpserver",
        glyph: "🔌",
        summary: "Use tools from an MCP server.",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "get_issue", body: "{}" },
        },
        details: "## Limits\n\nServer-defined.",
    }, "@acme/acme-execs-mcp"), {
        name: "mcpserver",
        glyph: "🔌",
        summary: "Use tools from an MCP server.",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "get_issue", body: "{}" },
        },
        details: "## Limits\n\nServer-defined.",
    });
});

test("{§executor-runtime-declaration} admits an exact tool-derived summary", () => {
    assert.deepEqual(RuntimeDeclaration.assert({
        name: "mcpserver",
        summary: { from: "tools" },
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "get_issue" },
        },
    }, "@acme/acme-execs-mcp"), {
        name: "mcpserver",
        summary: { from: "tools" },
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "get_issue" },
        },
    });
});

test("{§executor-runtime-declaration} refuses legacy, misspelled, and mistyped metadata", () => {
    const invocation = { body: { role: "query", required: true }, example: { body: "find it" } };
    const cases: Array<[unknown, RegExp]> = [
        [null, /declaration must be an object/],
        [{ name: "search", summary: "Search.", invocation, example: "## EXEC0" }, /unknown field 'example'/],
        [{ name: "search", summary: "Search.", invocation, glyph: 1 }, /glyph must be a string/],
        [{ name: "search", invocation }, /summary must be one non-empty line/],
        [{ name: "search", summary: "two\nlines", invocation }, /summary must be one non-empty line/],
        [{ name: "search", summary: { from: "catalog" }, invocation }, /summary must be one non-empty line or \{ from: "tools" \}/],
        [{ name: "search", summary: { from: "tools", extra: true }, invocation }, /summary must be one non-empty line or \{ from: "tools" \}/],
        [{ name: "search", summary: "Search.", invocation, details: [] }, /details must be a string/],
    ];

    for (const [value, expected] of cases) {
        assert.throws(
            () => RuntimeDeclaration.assert(value, "@acme/acme-execs-search"),
            expected,
        );
    }
});

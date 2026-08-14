import test from "node:test";
import assert from "node:assert/strict";
import RuntimeDeclaration from "./RuntimeDeclaration.ts";

test("{§executor-runtime-declaration} validates the complete runtime declaration", () => {
    assert.deepEqual(RuntimeDeclaration.assert({
        name: "mcpserver",
        glyph: "🔌",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "get_issue", body: "{}" },
        },
        documentation: "# MCP server",
    }, "@acme/acme-execs-mcp"), {
        name: "mcpserver",
        glyph: "🔌",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "MCP tool", required: true, kind: "literal" },
            example: { target: "get_issue", body: "{}" },
        },
        documentation: "# MCP server",
    });
});

test("{§executor-runtime-declaration} refuses legacy, misspelled, and mistyped metadata", () => {
    const invocation = { body: { role: "query", required: true }, example: { body: "find it" } };
    const cases: Array<[unknown, RegExp]> = [
        [null, /declaration must be an object/],
        [{ name: "search", invocation, example: "## EXEC0" }, /unknown field 'example'/],
        [{ name: "search", invocation, glyph: 1 }, /glyph must be a string/],
        [{ name: "search", invocation, documentation: [] }, /documentation must be a string/],
    ];

    for (const [value, expected] of cases) {
        assert.throws(
            () => RuntimeDeclaration.assert(value, "@acme/acme-execs-search"),
            expected,
        );
    }
});

import test from "node:test";
import assert from "node:assert/strict";
import RuntimeDeclaration from "./RuntimeDeclaration.ts";
import RuntimeInvocation from "./RuntimeInvocation.ts";

test("{§executor-discovery} validates the complete runtime declaration", () => {
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

test("{§executor-discovery} admits an exact tool-derived summary", () => {
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

test("{§executor-discovery} refuses misspelled and mistyped metadata", () => {
    const invocation = { body: { role: "query", required: true }, example: { body: "find it" } };
    const cases: Array<[unknown, RegExp]> = [
        [null, /declaration must be an object/],
        [{ name: "search", summary: "Search.", invocation, undeclared: true }, /unknown field 'undeclared'/],
        [{ name: "search", summary: "Search.", invocation, glyph: 1 }, /glyph must be a string/],
        [{ name: "search", invocation }, /summary must be one non-empty line/],
        [{ name: "search", summary: "two\nlines", invocation }, /summary must be one non-empty line/],
        [{ name: "search", summary: { from: "catalog" }, invocation }, /summary must be one non-empty line or \{ from: "tools" \}/],
        [{ name: "search", summary: { from: "tools", extra: true }, invocation }, /summary must be one non-empty line or \{ from: "tools" \}/],
        [{ name: "search", summary: { from: "tools", description: "two\nlines" }, invocation }, /summary.description must be one non-empty line/],
        [{ name: "search", summary: "Search.", invocation, details: [] }, /details must be a string/],
    ];

    for (const [value, expected] of cases) {
        assert.throws(
            () => RuntimeDeclaration.assert(value, "@acme/acme-execs-search"),
            expected,
        );
    }
});

test("{§executor-discovery} preserves a tool-derived summary's optional purpose", () => {
    const declaration = RuntimeDeclaration.assert({
        name: "mcp",
        summary: { from: "tools", description: "Manage MCP servers" },
        invocation: { body: { role: "arguments", required: false }, example: { body: "{}" } },
    }, "fixture");
    assert.deepEqual(declaration.summary, { from: "tools", description: "Manage MCP servers" });
});

const assertInvocation = (value: unknown) =>
    RuntimeInvocation.assert(value, "@acme/acme-execs-fixture", "fixture");

test("{§executor-discovery} validates and preserves the one runtime invocation contract", () => {
    assert.deepEqual(assertInvocation({
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "get_issue", body: "{}" },
    }), {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "get_issue", body: "{}" },
    });

    assert.deepEqual(assertInvocation({
        body: { role: "program or script input", required: false },
        target: { role: "script or working directory", required: false, kind: "script" },
        example: { body: "npm test" },
    }), {
        body: { role: "program or script input", required: false },
        target: { role: "script or working directory", required: false, kind: "script" },
        example: { body: "npm test" },
    });

    assert.deepEqual(assertInvocation({
        body: { role: "inline query", required: false },
        target: { role: "query file", required: false, kind: "script" },
        exclusive: true,
        example: { target: "query(v1).sql" },
    }), {
        body: { role: "inline query", required: false },
        target: { role: "query file", required: false, kind: "script" },
        exclusive: true,
        example: { target: "query(v1).sql" },
    });

    assert.deepEqual(assertInvocation({
        body: { role: "JSON arguments", required: false },
        target: { role: "Read an issue", required: true, kind: "literal" },
        signature: '{"owner": string, "repo": string, "issue_number": integer}',
    }), {
        body: { role: "JSON arguments", required: false },
        target: { role: "Read an issue", required: true, kind: "literal" },
        signature: '{"owner": string, "repo": string, "issue_number": integer}',
    });
});

test("{§executor-discovery} preserves a declared body media type and refuses a malformed one", () => {
    assert.deepEqual(assertInvocation({
        body: { role: "JSON arguments", required: false, mimetype: "application/json" },
        target: { role: "MCP tool", required: true, kind: "literal" },
        example: { target: "tool_name" },
    }).body, { role: "JSON arguments", required: false, mimetype: "application/json" });
    assert.throws(() => assertInvocation({
        body: { role: "JSON arguments", required: false, mimetype: "JSON" },
        example: { body: "{}" },
    }), /invocation\.body\.mimetype must be one lowercase type\/subtype media type/);
});

test("{§executor-discovery} rejects incomplete, ambiguous, and typo-bearing declarations", () => {
    const cases: Array<[unknown, RegExp]> = [
        [undefined, /invocation must be an object/],
        [{}, /invocation\.body must be an object/],
        [{ body: { role: "query", required: true }, example: { body: "find it" }, typo: true }, /invocation has unknown field 'typo'/],
        [{ body: { role: "query\ncontinued", required: true }, example: { body: "find it" } }, /body\.role must be one non-empty line/],
        [{ body: { role: "query", required: "yes" }, example: { body: "find it" } }, /body\.required must be boolean/],
        [{ body: { role: "query", required: true }, target: { role: "input", required: false, kind: "stream" }, example: { body: "find it" } }, /target\.kind must be literal, path, resource, or script/],
        [{ body: { role: "query", required: true }, target: { role: "tool", required: true, kind: "literal", directory: "cwd" }, example: { target: "tool", body: "find it" } }, /target has unknown field 'directory'/],
        [{ body: { role: "query", required: true }, target: { role: "input", required: false, kind: "path", mode: "cwd" }, example: { body: "find it" } }, /target has unknown field 'mode'/],
        [{ body: { role: "query", required: true }, example: { body: "find it" }, exclusive: "yes" }, /invocation\.exclusive must be boolean/],
        [{ body: { role: "query", required: true }, example: { body: "find it" }, exclusive: true }, /exclusive invocation must declare a target/],
        [{ body: { role: "query", required: true } }, /exactly one example or signature/],
        [{ body: { role: "query", required: true }, example: { body: "find it" }, signature: "string" }, /exactly one example or signature/],
        [{ body: { role: "query", required: true }, signature: "multi\nline" }, /signature must be one non-empty canonical line/],
        [{ body: { role: "query", required: true }, example: {} }, /must provide a body or target/],
        [{ body: { role: "query", required: true }, example: { target: "input" } }, /required body/],
        [{ body: { role: "query", required: true }, example: { body: " find it" } }, /example\.body must be one non-empty canonical line/],
        [{ body: { role: "query", required: true }, example: { body: "find\nit" } }, /example\.body must be one non-empty canonical line/],
        [{ body: { role: "query", required: true }, example: { body: "find it", target: "input" } }, /cannot provide a refused target/],
        [{ body: { role: "query", required: false }, target: { role: "input", required: true, kind: "path" }, example: { body: "find it" } }, /required target/],
        [{ body: { role: "query", required: false }, target: { role: "input", required: false, kind: "path" }, exclusive: true, example: { body: "find it", target: "input" } }, /exactly one exclusive input/],
    ];

    for (const [value, expected] of cases) {
        assert.throws(() => assertInvocation(value), expected);
    }
});

test("{§executor-discovery} literal nested programs remain body text in generated invocations", () => {
    const value = { body: { role: "query", required: true }, example: { body: "````READ (elsewhere)````" } };
    assert.equal(assertInvocation(value).example?.body, value.example.body);
});

test("{§executor-discovery} preserves a raw input schema as the sole source of schema-backed teaching", () => {
    const inputSchema = { type: "object", properties: { value: { $ref: "#/$defs/value" } }, $defs: { value: { type: "string" } } };
    const declaration = { body: { role: "JSON arguments", required: false }, inputSchema };
    assert.deepEqual(assertInvocation(declaration), declaration);
    for (const conflict of [{ example: { body: "{}" } }, { signature: "object" }]) {
        assert.throws(() => assertInvocation({ ...declaration, ...conflict }), /exactly one example or signature or inputSchema/);
    }
    for (const invalid of [null, [], "object", false]) {
        assert.throws(() => assertInvocation({ ...declaration, inputSchema: invalid }), /inputSchema must be an object/);
    }
});

test("{§executor-discovery} validates one closed set of exact literal targets", () => {
    const registry = RuntimeInvocation.assertToolRegistry({
        tools: [
            {
                target: "issue_read",
                summary: "Read an issue.",
                invocation: {
                    body: { role: "JSON arguments", required: false },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    signature: '{"owner": string, "repo": string}',
                },
            },
            {
                target: "issue_write",
                summary: "Write an issue.",
                invocation: {
                    body: { role: "JSON arguments", required: true },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    example: { target: "issue_write", body: "{}" },
                },
                details: "## Authority\n\nRequires proposal review.",
            },
        ],
    }, "@plurnk/plurnk-mcp", "gitea");

    assert.deepEqual(registry.tools.map((tool) => tool.target), ["issue_read", "issue_write"]);
    assert.equal(registry.tools[1]?.details, "## Authority\n\nRequires proposal review.");
    assert.throws(
        () => RuntimeInvocation.assertToolRegistry({
            ...registry,
            tools: [registry.tools[0], registry.tools[0]],
        }, "@plurnk/plurnk-mcp", "gitea"),
        /duplicate exact target 'issue_read'/,
    );
    assert.throws(
        () => RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "search",
                summary: "Search.",
                invocation: {
                    body: { role: "query", required: true },
                    example: { body: "find it" },
                },
            }],
        }, "fixture", "search"),
        /must declare a required literal target/,
    );
    assert.throws(
        () => RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "issue_read",
                summary: "Read an issue.",
                invocation: {
                    body: { role: "JSON arguments", required: true },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    example: { target: "different", body: "{}" },
                },
            }],
        }, "@plurnk/plurnk-mcp", "gitea"),
        /conflicts with invocation\.example\.target 'different'/,
    );
    assert.deepEqual(
        RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "issue)read",
                summary: "Read an issue.",
                invocation: {
                    body: { role: "JSON arguments", required: false },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    signature: "{}",
                },
            },
            ],
        }, "@plurnk/plurnk-mcp", "gitea").tools.map((tool) => tool.target),
        ["issue)read"],
    );
    assert.throws(
        () => RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "issue<read",
                summary: "Read an issue.",
                invocation: {
                    body: { role: "JSON arguments", required: false },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    signature: "{}",
                },
            }],
        }, "@plurnk/plurnk-mcp", "gitea"),
        /target 'issue<read' must render one valid executor fence/,
    );
    assert.throws(
        () => RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "issue_read",
                summary: "two\nlines",
                invocation: registry.tools[0].invocation,
            }],
        }, "@plurnk/plurnk-mcp", "gitea"),
        /summary must be one non-empty line/,
    );
});

test("{§executor-discovery} preserves original definitions and rejects partial catalogs", () => {
    const tool = {
        target: "search", summary: "Search documents.",
        invocation: {
            body: { role: "JSON arguments", required: false },
            target: { role: "tool", required: true, kind: "literal" },
            inputSchema: { type: "object" },
        },
    };
    const definition = {
        name: "search", inputSchema: tool.invocation.inputSchema,
        outputSchema: { type: "object", properties: { matches: { type: "array" } } },
        _meta: { vendor: { revision: 2 } },
    };
    const registry = { tools: [{ ...tool, definition }] };
    assert.deepEqual(RuntimeInvocation.assertToolRegistry(registry, "fixture", "search"), registry);
    for (const invalid of [null, [], "tool", false]) {
        assert.throws(() => RuntimeInvocation.assertToolRegistry({
            tools: [{ ...tool, definition: invalid }],
        }, "fixture", "search"), /definition must be an object/);
    }
    for (const tools of [
        [{ ...tool, definition }, { ...tool, target: "other" }],
        [{ ...tool, target: "other" }, { ...tool, definition }],
    ]) {
        assert.throws(() => RuntimeInvocation.assertToolRegistry({ tools }, "fixture", "search"),
            /definitions must be supplied for every tool or none/);
    }
});

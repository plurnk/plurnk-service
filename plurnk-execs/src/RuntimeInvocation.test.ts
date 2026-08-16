import test from "node:test";
import assert from "node:assert/strict";
import RuntimeInvocation from "./RuntimeInvocation.ts";

const assertInvocation = (value: unknown) =>
    RuntimeInvocation.assert(value, "@acme/acme-execs-fixture", "fixture");

test("{§executor-invocation} validates and preserves the one runtime invocation contract", () => {
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
        target: { role: "script or working directory", required: false, kind: "resource", directory: "cwd" },
        example: { body: "npm test" },
    }), {
        body: { role: "program or script input", required: false },
        target: { role: "script or working directory", required: false, kind: "resource", directory: "cwd" },
        example: { body: "npm test" },
    });

    assert.deepEqual(assertInvocation({
        body: { role: "inline WAT module", required: false },
        target: { role: "WAT module", required: false, kind: "resource" },
        exclusive: true,
        example: { target: "module(v1).wat" },
    }), {
        body: { role: "inline WAT module", required: false },
        target: { role: "WAT module", required: false, kind: "resource" },
        exclusive: true,
        example: { target: "module(v1).wat" },
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

test("{§executor-invocation} rejects incomplete, ambiguous, and typo-bearing declarations", () => {
    const cases: Array<[unknown, RegExp]> = [
        [undefined, /invocation must be an object/],
        [{}, /invocation\.body must be an object/],
        [{ body: { role: "query", required: true }, example: { body: "find it" }, typo: true }, /invocation has unknown field 'typo'/],
        [{ body: { role: "query\ncontinued", required: true }, example: { body: "find it" } }, /body\.role must be one non-empty line/],
        [{ body: { role: "query", required: "yes" }, example: { body: "find it" } }, /body\.required must be boolean/],
        [{ body: { role: "query", required: true }, target: { role: "input", required: false, kind: "stream" }, example: { body: "find it" } }, /target\.kind must be literal, path, or resource/],
        [{ body: { role: "query", required: true }, target: { role: "tool", required: true, kind: "literal", directory: "cwd" }, example: { target: "tool", body: "find it" } }, /literal target cannot route a directory to cwd/],
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
        [{ body: { role: "query", required: true }, example: { body: "## READ0 (elsewhere)" } }, /must render one valid EXEC section/],
    ];

    for (const [value, expected] of cases) {
        assert.throws(() => assertInvocation(value), expected);
    }
});

test("{§executor-tool-registry} validates one closed set of exact literal targets", () => {
    const registry = RuntimeInvocation.assertToolRegistry({
        tools: [
            {
                target: "issue_read",
                invocation: {
                    body: { role: "JSON arguments", required: false },
                    target: { role: "Read an issue", required: true, kind: "literal" },
                    signature: '{"owner": string, "repo": string}',
                },
            },
            {
                target: "issue_write",
                invocation: {
                    body: { role: "JSON arguments", required: true },
                    target: { role: "Write an issue", required: true, kind: "literal" },
                    example: { target: "issue_write", body: "{}" },
                },
            },
        ],
        documentation: "# gitea\n\nExact schemas.",
    }, "@plurnk/plurnk-mcp", "gitea");

    assert.deepEqual(registry.tools.map((tool) => tool.target), ["issue_read", "issue_write"]);
    assert.equal(registry.documentation, "# gitea\n\nExact schemas.");
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
                invocation: {
                    body: { role: "query", required: true },
                    example: { body: "find it" },
                },
            }],
            documentation: "",
        }, "fixture", "search"),
        /must declare a required literal target/,
    );
    assert.throws(
        () => RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "issue_read",
                invocation: {
                    body: { role: "JSON arguments", required: true },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    example: { target: "different", body: "{}" },
                },
            }],
            documentation: "",
        }, "@plurnk/plurnk-mcp", "gitea"),
        /conflicts with invocation\.example\.target 'different'/,
    );
    assert.deepEqual(
        RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "issue)read",
                invocation: {
                    body: { role: "JSON arguments", required: false },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    signature: "{}",
                },
            }],
            documentation: "",
        }, "@plurnk/plurnk-mcp", "gitea").tools.map((tool) => tool.target),
        ["issue)read"],
    );
    assert.throws(
        () => RuntimeInvocation.assertToolRegistry({
            tools: [{
                target: "issue<read",
                invocation: {
                    body: { role: "JSON arguments", required: false },
                    target: { role: "MCP tool", required: true, kind: "literal" },
                    signature: "{}",
                },
            }],
            documentation: "",
        }, "@plurnk/plurnk-mcp", "gitea"),
        /target 'issue<read' must render one valid EXEC section/,
    );
});

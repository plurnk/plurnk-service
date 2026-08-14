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
        example: { target: "module.wat" },
    }), {
        body: { role: "inline WAT module", required: false },
        target: { role: "WAT module", required: false, kind: "resource" },
        exclusive: true,
        example: { target: "module.wat" },
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
        [{ body: { role: "query", required: true } }, /invocation\.example must be an object/],
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

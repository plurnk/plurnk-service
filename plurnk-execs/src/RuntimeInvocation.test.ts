import test from "node:test";
import assert from "node:assert/strict";
import RuntimeInvocation from "./RuntimeInvocation.ts";

const assertInvocation = (value: unknown) =>
    RuntimeInvocation.assert(value, "@acme/acme-execs-fixture", "fixture");

test("{§executor-invocation} validates and preserves the one runtime invocation contract", () => {
    assert.deepEqual(assertInvocation({
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
    }), {
        body: { role: "JSON arguments", required: false },
        target: { role: "MCP tool", required: true, kind: "literal" },
    });

    assert.deepEqual(assertInvocation({
        body: { role: "program or script input", required: false },
        target: { role: "script or working directory", required: false, kind: "resource", directory: "cwd" },
    }), {
        body: { role: "program or script input", required: false },
        target: { role: "script or working directory", required: false, kind: "resource", directory: "cwd" },
    });

    assert.deepEqual(assertInvocation({
        body: { role: "inline WAT module", required: false },
        target: { role: "WAT module", required: false, kind: "resource" },
        exclusive: true,
    }), {
        body: { role: "inline WAT module", required: false },
        target: { role: "WAT module", required: false, kind: "resource" },
        exclusive: true,
    });
});

test("{§executor-invocation} rejects incomplete, ambiguous, and typo-bearing declarations", () => {
    const cases: Array<[unknown, RegExp]> = [
        [undefined, /invocation must be an object/],
        [{}, /invocation\.body must be an object/],
        [{ body: { role: "query", required: true }, typo: true }, /invocation has unknown field 'typo'/],
        [{ body: { role: "query\ncontinued", required: true } }, /body\.role must be one non-empty line/],
        [{ body: { role: "query", required: "yes" } }, /body\.required must be boolean/],
        [{ body: { role: "query", required: true }, target: { role: "input", required: false, kind: "stream" } }, /target\.kind must be literal, path, or resource/],
        [{ body: { role: "query", required: true }, target: { role: "tool", required: true, kind: "literal", directory: "cwd" } }, /literal target cannot route a directory to cwd/],
        [{ body: { role: "query", required: true }, target: { role: "input", required: false, kind: "path", mode: "cwd" } }, /target has unknown field 'mode'/],
        [{ body: { role: "query", required: true }, exclusive: "yes" }, /invocation\.exclusive must be boolean/],
        [{ body: { role: "query", required: true }, exclusive: true }, /exclusive invocation must declare a target/],
    ];

    for (const [value, expected] of cases) {
        assert.throws(() => assertInvocation(value), expected);
    }
});

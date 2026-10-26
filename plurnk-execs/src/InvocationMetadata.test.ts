import test from "node:test";
import assert from "node:assert/strict";
import BaseExecutor from "./BaseExecutor.ts";
import SubprocessExecutor from "./SubprocessExecutor.ts";
import InvocationMetadata from "./InvocationMetadata.ts";
import type { ExecInput } from "./types.ts";

const input = (metadata: readonly string[] | null, overrides: Partial<ExecInput> = {}): ExecInput => ({
    runtime: "js", body: "unchanged stdin", target: "script.mjs", cwd: process.cwd(), metadata, ...overrides,
});
const executor = new SubprocessExecutor({ runtime: "js", glyph: "j" });

test("{§executor-metadata} script arguments preserve exact strings without interpreting shell syntax", async () => {
    const args = ["--help", "two words", "", "$(touch forbidden)", "'quoted'", "}", "line\nbreak", "snowman ☃"];
    const request = input([JSON.stringify({ args })]);
    const preparation = await executor.prepare(request);
    assert.equal(preparation.status, 200);
    assert.equal(preparation.cwd, request.cwd);
    assert.deepEqual(InvocationMetadata.parse(request, { args: true }), { options: { args } });
    assert.equal(request.body, "unchanged stdin");
});

// Blocks are the inner text of one `[…]` slot: JSON option objects ({§scheme-metadata-modifier}).
for (const [blocks, code] of [
    [['{"args": "--help"}'], "invalid-args"],
    [['{"args": {}}'], "invalid-args"],
    [['{"args": null}'], "invalid-args"],
    [['{"args": [1]}'], "invalid-args"],
    [['{"args": ["\\u0000"]}'], "invalid-args"],
    [['{"args": []}', '{"args": []}'], "metadata-repeated"],
    [['{"flag": "yes"}'], "metadata-unsupported"],
    [["--help"], "metadata-invalid"],
    [["42"], "metadata-invalid"],
    [['"a string"'], "metadata-invalid"],
] as const) {
    test(`{§executor-metadata} rejects ${JSON.stringify(blocks)} as ${code}`, async () => {
        const result = await executor.prepare(input(blocks));
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, `https://problems.plurnk.xyz/executor/metadata/${code}`);
        assert.doesNotMatch(result.problem?.detail ?? "", /everything else|you meant|instead of|probably/);
    });
}

test("{§executor-metadata} argument support is subprocess-owned, for scripts and inline programs", async () => {
    const withoutTarget = await executor.prepare(input(['{"args": []}'], { target: null }));
    assert.equal(withoutTarget.status, 200);
    class Pure extends BaseExecutor {
        get channels() { return { results: { mimetype: "text/plain" } }; }
        async run() { return { status: 200 }; }
    }
    const pure = new Pure({ runtime: "pure", glyph: "p" });
    const unsupported = await pure.prepare(input(['{"args": []}'], { runtime: "pure" }));
    assert.equal(unsupported.status, 400);
    assert.match(unsupported.problem?.type ?? "", /metadata-unsupported$/);
    assert.equal(unsupported.problem?.recovery, "Its field is `lifetime`.");
    assert.equal((await pure.prepare(input(null))).status, 200);
});

test("{§executor-metadata} an unsupported field's refusal names the run's fields and nothing more ({§diagnostic-observation})", async () => {
    for (const field of ["timeout", "cmd"]) {
        const refused = await executor.prepare(input([JSON.stringify({ [field]: 60 })]));
        assert.equal(refused.status, 400);
        assert.equal(refused.problem?.detail, `Executable tool '${input(null).runtime}' does not accept metadata field '${field}'.`);
        assert.equal(refused.problem?.recovery, "Its fields are `args` and `lifetime`.");
    }
});

import test from "node:test";
import assert from "node:assert/strict";
import SubprocessExecutor from "./SubprocessExecutor.ts";
import InvocationMetadata from "./InvocationMetadata.ts";
import type { ExecInput } from "./types.ts";

const input = (metadata: readonly string[] | null, overrides: Partial<ExecInput> = {}): ExecInput => ({
    runtime: "js", body: "--help 'two words'", target: "script.mjs", cwd: process.cwd(), metadata, ...overrides,
});
const executor = new SubprocessExecutor({ runtime: "js", glyph: "j" });

test("{§executor-metadata} empty or service-only metadata preserves cwd", async () => {
    const request = input(null);
    const preparation = await executor.prepare(request);
    assert.equal(preparation.status, 200);
    assert.equal(preparation.cwd, request.cwd);
    assert.deepEqual(InvocationMetadata.parse(request), { options: {} });
});

// Blocks are the inner text of one `[…]` slot: JSON option objects ({§scheme-metadata-modifier}).
for (const [blocks, code] of [
    [['{"flag": "yes"}'], "metadata-unsupported"],
    [['{"lifetime": "5s"}', '{"lifetime": "5s"}'], "metadata-repeated"],
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

test("{§executor-metadata} an unsupported field's refusal names the run's fields and nothing more ({§diagnostic-observation})", async () => {
    for (const field of ["timeout", "cmd"]) {
        const refused = await executor.prepare(input([JSON.stringify({ [field]: 60 })]));
        assert.equal(refused.status, 400);
        assert.equal(refused.problem?.detail, `Executable tool '${input(null).runtime}' does not accept metadata field '${field}'.`);
        assert.equal(refused.problem?.recovery, "Its field is `lifetime`.");
    }
});

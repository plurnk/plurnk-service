import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BaseExecutor from "./BaseExecutor.ts";
import SubprocessExecutor from "./SubprocessExecutor.ts";
import InvocationMetadata from "./InvocationMetadata.ts";
import type { ExecInput } from "./types.ts";

const input = (metadata: readonly string[] | null, overrides: Partial<ExecInput> = {}): ExecInput => ({
    runtime: "node", body: "unchanged stdin", target: "script.mjs", cwd: process.cwd(), metadata, ...overrides,
});
const executor = new SubprocessExecutor({ runtime: "node", glyph: "n" });

test("{§executor-metadata} script arguments preserve exact strings without interpreting shell syntax", async () => {
    const args = ["--help", "two words", "", "$(touch forbidden)", "'quoted'", "}", "line\nbreak", "snowman ☃"];
    const request = input([`args=${JSON.stringify(args)}`]);
    const preparation = await executor.prepare(request);
    assert.equal(preparation.status, 200);
    assert.equal(preparation.cwd, request.cwd);
    assert.deepEqual(InvocationMetadata.parse(request, true), { options: { args } });
    assert.equal(request.body, "unchanged stdin");
});

for (const [blocks, code] of [
    [["args=--help"], "invalid-args"],
    [['args="--help"'], "invalid-args"],
    [["args={}"], "invalid-args"],
    [["args=null"], "invalid-args"],
    [["args=[1]"], "invalid-args"],
    [['args=["\\u0000"]'], "invalid-args"],
    [["args=[]", "args=[]"], "duplicate-metadata"],
    [["cwd=.", "cwd=.."], "duplicate-metadata"],
    [["cwd="], "invalid-cwd"],
    [["cwd=bad\0path"], "invalid-cwd"],
    [["flag=yes"], "metadata-unsupported"],
    [["--help"], "invalid-metadata"],
] as const) {
    test(`{§executor-metadata} rejects ${JSON.stringify(blocks)} as ${code}`, async () => {
        const result = await executor.prepare(input(blocks));
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, `https://problems.plurnk.xyz/executor/metadata/${code}`);
        assert.doesNotMatch(result.problem?.detail ?? "", /everything else|you meant|instead of|probably/);
    });
}

test("{§executor-metadata} argument support is subprocess-owned, for scripts and inline programs", async () => {
    const withoutTarget = await executor.prepare(input(["args=[]"], { target: null }));
    assert.equal(withoutTarget.status, 200);
    class Pure extends BaseExecutor {
        get channels() { return { results: { mimetype: "text/plain" } }; }
        async run() { return { status: 200 }; }
    }
    const pure = new Pure({ runtime: "pure", glyph: "p" });
    const unsupported = await pure.prepare(input(["args=[]"], { runtime: "pure" }));
    assert.equal(unsupported.status, 400);
    assert.match(unsupported.problem?.type ?? "", /metadata-unsupported$/);
    assert.equal((await pure.prepare(input(null))).status, 200);
});

test("{§executor-metadata} cwd is prepared once from the supplied environment", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "executor-options-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "directory with spaces");
    await mkdir(directory);
    await writeFile(join(root, "plain-file"), "not a directory");
    for (const cwd of ["directory with spaces", directory]) {
        const prepared = await executor.prepare(input([`cwd=${cwd}`], { cwd: root }));
        assert.equal(prepared.status, 200);
        assert.equal(prepared.cwd, directory);
    }
    for (const cwd of ["missing", "plain-file", "plain-file/nested"]) {
        const failed = await executor.prepare(input([`cwd=${cwd}`], { cwd: root }));
        assert.equal(failed.status, 400);
        assert.match(failed.problem?.type ?? "", /cwd-not-found$/);
    }
    const untouched = await executor.prepare(input(null, { cwd: null }));
    assert.deepEqual(untouched, { status: 200, cwd: null });
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const grammarRoot = fileURLToPath(new URL("../..", import.meta.url));

test("type generation reproduces committed types in isolation and exits without HTTP timers", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-contract-generation-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(grammarRoot, "schema"), join(root, "schema"), { recursive: true });
    await mkdir(join(root, "src"));
    const result = spawnSync(
        process.execPath,
        ["--conditions=plurnk-dev", join(grammarRoot, "scriptify/generate-types.ts")],
        { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Generated src\/types\.generated\.ts/);
    assert.equal(
        await readFile(join(root, "src/types.generated.ts"), "utf8"),
        await readFile(join(grammarRoot, "src/types.generated.ts"), "utf8"),
        "the real generator reproduces the committed contract without rewriting running tests' inputs",
    );
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const grammarRoot = fileURLToPath(new URL("../..", import.meta.url));

test("type generation resolves committed schemas locally and exits without HTTP timers", () => {
    const result = spawnSync(
        process.execPath,
        ["--conditions=plurnk-dev", "scriptify/generate-types.ts"],
        { cwd: grammarRoot, encoding: "utf8", timeout: 10_000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Generated src\/types\.generated\.ts/);
});

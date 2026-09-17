import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("{§agui-first-party-client-conformance}: a missing explicit client fails instead of using the sibling", async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "plurnk-client-location-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const missing = join(fixture, "missing client");
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "test-client-conformance.mjs")], {
        cwd: fixture,
        env: { ...process.env, PLURNK_CLIENT_CHECKOUT: "./missing client" },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`client conformance needs an installed terminal client checkout: ${missing}.`), result.stderr);
    assert.match(result.stderr, /set PLURNK_CLIENT_CHECKOUT to another installed checkout/);
    assert.equal(result.stdout, "", "the prerequisite fails before packing or starting products");
});

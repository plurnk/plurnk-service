import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetTestArtifacts, testArtifactDirectory } from "../plurnk-core/scripts/test-artifacts.mjs";

const root = new URL("..", import.meta.url);

test("core test runners retain only the current run's database artifacts", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "plurnk-test-artifacts-"));
    try {
        const artifacts = testArtifactDirectory(fixtureRoot);
        await mkdir(join(artifacts, "nested"), { recursive: true });
        await writeFile(join(artifacts, "prior.db"), "prior");
        await writeFile(join(artifacts, "nested", "prior.db-wal"), "prior");

        assert.equal(await resetTestArtifacts(fixtureRoot), artifacts);
        assert.deepEqual(await readdir(artifacts), [], "the prior run is removed before the suite");

        await writeFile(join(artifacts, "current.db"), "current");
        assert.deepEqual(await readdir(artifacts), ["current.db"], "the current run remains available for forensics");

        await resetTestArtifacts(fixtureRoot);
        assert.deepEqual(await readdir(artifacts), [], "the next run removes the previously retained run");
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

test("the core integration tier begins through the one retention procedure", async () => {
    const packageJson = JSON.parse(await readFile(new URL("plurnk-core/package.json", root), "utf8"));
    const scripts = packageJson.scripts;
    assert.equal(scripts["pretest:intg"], "npm run test:artifacts:begin");
    assert.equal(scripts["test:clean-tmp"], "node scripts/test-artifacts.mjs clean");
});

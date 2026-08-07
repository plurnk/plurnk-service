import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetTestArtifacts, testArtifactDirectory } from "./test-artifacts.mjs";

const root = new URL("..", import.meta.url);

test("integration test runners retain only the current run's database artifacts", async () => {
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

test("one integration lane cannot clear a sibling lane's artifacts", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "plurnk-test-lanes-"));
    const laneA = join(fixtureRoot, "a");
    const laneB = join(fixtureRoot, "b");
    try {
        const [artifactsA, artifactsB] = await Promise.all([
            resetTestArtifacts(laneA),
            resetTestArtifacts(laneB),
        ]);
        await Promise.all([
            writeFile(join(artifactsA, "a.db"), "a"),
            writeFile(join(artifactsB, "b.db"), "b"),
        ]);

        await resetTestArtifacts(laneA);

        assert.deepEqual(await readdir(artifactsA), []);
        assert.equal(await readFile(join(artifactsB, "b.db"), "utf8"), "b");
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

test("each file-backed integration lane begins through the shared retention procedure", async () => {
    for (const workspace of ["plurnk-core", "plurnk-agui"]) {
        const packageJson = JSON.parse(await readFile(new URL(`${workspace}/package.json`, root), "utf8"));
        const scripts = packageJson.scripts;
        assert.equal(scripts["artifacts:begin"], "node ../scripts/test-artifacts.mjs begin", workspace);
        assert.equal(scripts["pretest:intg"], "npm run artifacts:begin", workspace);
        assert.equal(scripts["artifacts:clean"], "node ../scripts/test-artifacts.mjs clean", workspace);
    }
});

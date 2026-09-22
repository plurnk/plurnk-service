import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { benchmarksRoot, testArtifactDirectory, testArtifactPath } from "./test-artifacts.ts";

const root = new URL("../", import.meta.url);
const LANES = ["plurnk-core", "plurnk-agui", "plurnk-schedule"];

test("{§test-artifact-retention} a run's databases live under the one artifact home, never in the checkout", (t) => {
    const prior = process.env.PLURNK_BENCHMARKS;
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_BENCHMARKS;
        else process.env.PLURNK_BENCHMARKS = prior;
    });

    delete process.env.PLURNK_BENCHMARKS;
    assert.equal(benchmarksRoot(), join(homedir(), "benchmarks"), "the default home is ~/benchmarks");

    process.env.PLURNK_BENCHMARKS = "/tmp/plurnk-artifacts-fixture";
    assert.equal(benchmarksRoot(), "/tmp/plurnk-artifacts-fixture", "the operator's home wins");
    assert.ok(
        testArtifactPath("core").startsWith("/tmp/plurnk-artifacts-fixture/"),
        "a lane's directory is inside the artifact home and nowhere else",
    );
});

test("{§test-artifact-retention} each lane's run is one directory, stamped once and shared by every test process", (t) => {
    const prior = process.env.PLURNK_TEST_RUN;
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_TEST_RUN;
        else process.env.PLURNK_TEST_RUN = prior;
    });

    process.env.PLURNK_TEST_RUN = "20260920T000000Z";
    const first = testArtifactPath("core");
    assert.equal(testArtifactPath("core"), first, "the same stamp resolves to the same directory");
    assert.notEqual(testArtifactPath("agui"), first, "lanes do not share a directory");
    assert.ok(first.endsWith("intg-core-20260920T000000Z"), first);

    // A bare `node --test <file>` is not a special case with its own rules — it is simply
    // an unstamped run, and it lands in its own directory like any other.
    delete process.env.PLURNK_TEST_RUN;
    assert.ok(testArtifactPath("core").endsWith("intg-core-adhoc"), testArtifactPath("core"));
});

test("{§test-artifact-retention} the directory is created on demand, with no pretest step to remember", async (t) => {
    const prior = process.env.PLURNK_BENCHMARKS;
    process.env.PLURNK_BENCHMARKS = join("/tmp", `plurnk-artifacts-${crypto.randomUUID()}`);
    t.after(async () => {
        const { rm } = await import("node:fs/promises");
        await rm(process.env.PLURNK_BENCHMARKS, { recursive: true, force: true });
        if (prior === undefined) delete process.env.PLURNK_BENCHMARKS;
        else process.env.PLURNK_BENCHMARKS = prior;
    });

    const directory = await testArtifactDirectory("core");
    const { stat } = await import("node:fs/promises");
    assert.ok((await stat(directory)).isDirectory(), "opening a database needs no prior ceremony");
});

test("{§test-artifact-retention} no lane keeps a clear-before-suite step or a sweep of its own", async () => {
    for (const lane of LANES) {
        const { scripts } = JSON.parse(await readFile(new URL(`${lane}/package.json`, root), "utf8"));
        assert.equal(scripts["artifacts:begin"], undefined, `${lane} clears nothing before its suite`);
        assert.equal(scripts["artifacts:clean"], undefined, `${lane} has no manual sweep to remember`);
        assert.equal(scripts["pretest:intg"], undefined, `${lane} needs no pretest step`);
        assert.match(scripts["test:intg"], /^export PLURNK_TEST_RUN=/u, `${lane} stamps its run once for every test process`);
        // The one reclaim is shared and chained after the suite with `&&`, so only a passing run
        // reaches it; a failed run's evidence is never touched.
        assert.match(scripts["test:intg"], / && node \.\.\/scripts\/reclaim-green-run\.mjs [a-z]+$/u, `${lane} reclaims only a green run`);
        assert.doesNotMatch(scripts["test:intg"], /\brm\b/u, `${lane} keeps no sweep of its own`);
    }
});

test("{§test-artifact-retention} no lane writes run output back into the checkout", async () => {
    for (const lane of LANES) {
        const ignore = await readFile(new URL(`${lane}/.gitignore`, root), "utf8").catch(() => "");
        assert.doesNotMatch(ignore, /test\/intg\/\.tmp/u, `${lane} no longer hides scratch inside the tree`);
    }
});

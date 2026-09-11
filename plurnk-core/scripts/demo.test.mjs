import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { demoFiles, demoInvocation, matchingStories } from "./demo.mjs";
import { collectLiveTestNames } from "../test/live-test.ts";

test("the demo catalog lists every demo test file", async () => {
    const files = await demoFiles();
    assert.ok(files.length > 0, "the demo tier has test files");
    assert.ok(files.every((file) => file.endsWith(".test.ts")));
});

test("the full tier and the specimen share one invocation, with the pattern before the files", async () => {
    const full = await demoInvocation();
    const specimen = await demoInvocation("retrieve");
    const patternIndex = specimen.args.indexOf("--test-name-pattern");
    assert.ok(patternIndex !== -1, "the specimen carries --test-name-pattern");
    assert.equal(specimen.args[patternIndex + 1], "retrieve");
    assert.ok(
        patternIndex < specimen.args.findIndex((arg) => arg.endsWith(".test.ts")),
        "--test-name-pattern precedes the file list",
    );
    assert.deepEqual(
        specimen.args.filter((arg, index) => index !== patternIndex && index !== patternIndex + 1),
        full.args,
    );
    assert.deepEqual(specimen.env, full.env);
});

test("a specimen selector must match at least one registered story, before any provider call (#597)", async () => {
    const names = ["story: remember a fact, then recall it later", "demo: 'what is the hostname of this machine?' — model uses EXEC to run hostname", "demo: recover from attachments exceeding the budget and retrieve the recovery site"];
    assert.deepEqual(matchingStories("remember a fact", names), [names[0]]);
    assert.deepEqual(matchingStories("demo:", names), [names[1], names[2]], "several matches run several stories");
    assert.throws(() => matchingStories("memory", names), {
        message: /demo specimen "memory" matches no registered story; registered:\n {2}story: remember a fact/,
    });
    assert.throws(() => matchingStories("recall(", names), { message: /demo specimen "recall\(" is not a valid pattern/ });
});

test("the specimen invocation is built from the registered stories, not a second list", async () => {
    const files = await demoFiles();
    const names = await collectLiveTestNames(files);
    assert.ok(names.length >= files.length, "every demo file registers at least one story");
    const chosen = names[0];
    const specimen = await demoInvocation(chosen);
    assert.equal(specimen.args[specimen.args.indexOf("--test-name-pattern") + 1], chosen);
    await assert.rejects(demoInvocation("no such story anywhere"), /matches no registered story/);
});

test("a zero-match selector on the real CLI exits non-zero and runs nothing", () => {
    const run = spawnSync(process.execPath, ["--conditions=plurnk-dev", "scripts/demo.mjs", "--specimen", "no such story anywhere"], {
        cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, PLURNK_SERVICE_POLICY: "../plurnk-meta/POLICY.md" },
    });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, /matches no registered story/);
    assert.doesNotMatch(run.stdout, /ℹ tests \d+/, "node:test never started");
});

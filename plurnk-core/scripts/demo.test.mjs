import test from "node:test";
import assert from "node:assert/strict";
import { demoFiles, demoInvocation } from "./demo.mjs";

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

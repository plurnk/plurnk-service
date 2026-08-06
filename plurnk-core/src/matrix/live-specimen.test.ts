// The matrix selector's deterministic builder ({§provider-conformance-matrix}):
// one pattern, one specimen, in the exact standard live gate invocation.

import test from "node:test";
import assert from "node:assert/strict";
import { liveSpecimenInvocation } from "./live-specimen.ts";

test("the pattern sits BEFORE the expanded file list", () => {
    const { args } = liveSpecimenInvocation("^live: READ");
    const patternIndex = args.indexOf("--test-name-pattern");
    assert.ok(patternIndex !== -1, "the pattern flag is present");
    assert.equal(args[patternIndex + 1], "^live: READ");
    const files = args.slice(patternIndex + 2);
    assert.ok(files.length >= 1, "the expanded live file list follows the pattern");
    assert.ok(files.every((f) => f.startsWith("test/live/") && f.endsWith(".test.ts")));
});

test("all other flags and the policy env match the standard test:live command", () => {
    const { args, env } = liveSpecimenInvocation("probe");
    assert.deepEqual(env, { PLURNK_SERVICE_POLICY: "../plurnk-meta/PLURNK_PERSONALITY.md" });
    assert.ok(args.includes("--conditions=plurnk-dev"));
    assert.ok(args.includes("--import=./test/floor.ts"));
    assert.ok(args.includes("--env-file-if-exists=.env.defaults"));
    assert.ok(args.includes("--env-file-if-exists=.env.test"));
    assert.ok(args.includes("--test-concurrency=1"));
    assert.ok(
        args.some((a) => a.startsWith("--env-file-if-exists=") && a.includes("/.plurnk/.env")),
        "the operator env file path is materialized from $HOME",
    );
});

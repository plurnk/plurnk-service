import assert from "node:assert/strict";
import test from "node:test";
import {
    CONVENTIONAL_TYPES,
    validateBranchName,
    validateCommitMessage,
} from "./conventional.mjs";

test("every conventional type is valid for branches and commit subjects", () => {
    for (const type of CONVENTIONAL_TYPES) {
        assert.deepEqual(validateBranchName(`${type}/project-lifecycle`), [], type);
        assert.deepEqual(validateCommitMessage(`${type}(project): normalize lifecycle\n`), [], type);
    }
});

test("branch validation admits main and rejects malformed or unknown names", () => {
    assert.deepEqual(validateBranchName("main"), []);
    assert.match(validateBranchName("feature/project-lifecycle")[0], /main or type\/kebab-slug/);
    assert.match(validateBranchName("feat/Project Lifecycle")[0], /main or type\/kebab-slug/);
    assert.match(validateBranchName("feat/not_kebab")[0], /main or type\/kebab-slug/);
});

test("commit validation retains generated merge and revert subjects", () => {
    assert.deepEqual(validateCommitMessage("Merge branch 'feat/example'\n"), []);
    assert.deepEqual(validateCommitMessage("Revert \"feat: example\"\n"), []);
});

test("commit validation enforces conventional, bounded, subject-only messages", () => {
    assert.match(validateCommitMessage("Update lifecycle\n")[0], /type\(scope\): summary/);
    assert.match(validateCommitMessage(`fix: ${"x".repeat(80)}\n`)[0], /exceeds 80 characters/);
    assert.match(validateCommitMessage("fix: lifecycle\n\nExplanation.\n")[0], /one-liner doctrine/);
    assert.match(validateCommitMessage("fix: lifecycle\n\nCo-Authored-By: someone\n")[0], /one-liner doctrine/);
});

test("commit templates may retain blank and comment lines after the subject", () => {
    assert.deepEqual(validateCommitMessage("fix: lifecycle\n\n# template guidance\n"), []);
});

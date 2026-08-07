import assert from "node:assert/strict";
import test from "node:test";
import {
    canonicalForgeOrigin,
    repositoryAuthorityViolations,
} from "./release-authority.mjs";

test("canonical release repositories are signed main checkouts synchronized with PossumTech", () => {
    const origin = canonicalForgeOrigin("plurnk-service");
    assert.equal(origin, "ssh://git@ssh.possumtech.com/plurnk/plurnk-service.git");
    assert.deepEqual(repositoryAuthorityViolations({
        repo: "plurnk-service",
        origin,
        branch: "main",
        head: "abc",
        remoteHead: "abc",
    }), []);
});

test("release authority rejects the wrong forge, branch, or remote revision", () => {
    assert.deepEqual(repositoryAuthorityViolations({
        repo: "plurnk-service",
        origin: "git@github.com:plurnk/plurnk-service.git",
        branch: "feat/release",
        head: "abc",
        remoteHead: "def",
    }), [
        "origin is git@github.com:plurnk/plurnk-service.git, expected ssh://git@ssh.possumtech.com/plurnk/plurnk-service.git",
        "branch is feat/release, expected main",
        "HEAD abc does not equal origin/main def",
    ]);
});

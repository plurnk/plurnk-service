import assert from "node:assert/strict";
import test from "node:test";
import {
    canonicalForgeOrigin,
    repositoryName,
    repositoryAuthorityViolations,
} from "./release-authority.mjs";

test("{§release-finalization} source identity comes from the canonical repository, not checkout spelling or version", () => {
    for (const repository of ["plurnk-tavily-plugin", "plurnk-service", "plurnk"]) {
        const repo = repositoryName(canonicalForgeOrigin(repository));
        assert.equal(repo, repository);
        assert.deepEqual(repositoryAuthorityViolations({
            repo,
            origin: canonicalForgeOrigin(repository),
            branch: "main",
            head: "abc",
            remoteHead: "abc",
        }), []);
    }
    for (const origin of [undefined, "plurnk-tavily-plugin", "git@github.com:plurnk/plurnk.git", "ssh://git@ssh.possumtech.com/other/plurnk.git"]) {
        assert.throws(() => repositoryName(origin), /noncanonical release origin/);
    }
});

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

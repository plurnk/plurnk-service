import assert from "node:assert/strict";
import test from "node:test";
import {
    canonicalForgeOrigin,
    externalRepositoryName,
    repositoryAuthorityViolations,
} from "./release-authority.mjs";

test("{§release-finalization} managed package identity is independent of its checkout directory", () => {
    for (const [name, repository] of [
        ["@plurnk/plurnk-tavily-plugin", "plurnk-tavily-plugin"],
        ["@plurnk/plurnk-mimetypes-image", "plurnk-mimetypes-image"],
    ]) {
        const repo = externalRepositoryName(name);
        assert.equal(repo, repository);
        assert.deepEqual(repositoryAuthorityViolations({
            repo,
            origin: canonicalForgeOrigin(repository),
            branch: "main",
            head: "abc",
            remoteHead: "abc",
        }), []);
    }
    for (const name of [undefined, "plurnk-tavily-plugin", "@other/plurnk-tavily-plugin", "@plurnk/", "@plurnk/../other"]) {
        assert.throws(() => externalRepositoryName(name), /invalid managed package identity/);
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

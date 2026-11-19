import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
    identity,
    isCanonicalRemoteUrl,
    isSignatureProtectedRef,
    requiresSignature,
    validateCommit,
} from "./commit-provenance.mjs";

const exec = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(new URL("./commit-provenance.mjs", import.meta.url));
const ZERO = "0".repeat(40);

describe("commit-provenance remote, ref, and signature policy", () => {
    test("{§lint-gate} recognizes canonical possumtech.com remotes and rejects forks, local paths, and lookalikes", () => {
        for (const canonical of [
            "ssh://git@ssh.possumtech.com/plurnk/plurnk-service.git",
            "git@ssh.possumtech.com:plurnk/plurnk-service.git",
            "https://repo.possumtech.com/plurnk/plurnk-service.git",
            "https://possumtech.com/plurnk/plurnk-service.git",
        ]) {
            assert.equal(isCanonicalRemoteUrl(canonical), true, canonical);
        }
        for (const nonCanonical of [
            "git@github.com:plurnk/plurnk-service.git",
            "https://github.com/contributor/plurnk-service.git",
            "https://github.com/contributor/possumtech.com.git",
            "https://evilpossumtech.com/plurnk/plurnk-service.git",
            "/tmp/local-remote.git",
            "",
        ]) {
            assert.equal(isCanonicalRemoteUrl(nonCanonical), false, nonCanonical);
        }
    });

    test("{§lint-gate} scopes GPG signature enforcement to canonical main and tag refs while preserving backward-compatible defaults", () => {
        const canonical = "ssh://git@ssh.possumtech.com/plurnk/plurnk-service.git";
        const fork = "git@github.com:contributor/plurnk-service.git";

        assert.equal(isSignatureProtectedRef(undefined), true);
        assert.equal(isSignatureProtectedRef("refs/heads/main"), true);
        assert.equal(isSignatureProtectedRef("refs/tags/v1.2.3"), true);
        assert.equal(isSignatureProtectedRef("refs/tags/@plurnk/plurnk-meta@3.0.0"), true);
        assert.equal(isSignatureProtectedRef("refs/heads/feat/contributor-dx"), false);
        assert.equal(isSignatureProtectedRef("refs/heads/fix/typo"), false);

        assert.equal(requiresSignature(), true);
        assert.equal(requiresSignature({ remoteUrl: canonical }), true);
        assert.equal(requiresSignature({ remoteUrl: canonical, remoteRef: "refs/heads/main" }), true);
        assert.equal(requiresSignature({ remoteUrl: canonical, remoteRef: "refs/tags/v1.0.0" }), true);
        assert.equal(requiresSignature({ remoteUrl: canonical, remoteRef: "refs/heads/feat/wip" }), false);
        assert.equal(requiresSignature({ remoteUrl: canonical, remoteRef: "refs/heads/fix/bug" }), false);
        assert.equal(requiresSignature({ remoteUrl: fork, remoteRef: "refs/heads/main" }), false);
        assert.equal(requiresSignature({ remoteUrl: fork, remoteRef: "refs/tags/v1.0.0" }), false);
        assert.equal(requiresSignature({ remoteUrl: fork }), false);
    });

    test("{§lint-gate} preserves clone author/committer identity checks even when GPG signatures are not required", () => {
        const unsignedCommit = {
            sha: "b".repeat(40),
            authorName: "Contributor",
            authorEmail: "contributor@example.invalid",
            committerName: "Contributor",
            committerEmail: "contributor@example.invalid",
            signature: "N",
        };
        const policy = {
            authors: new Set([identity("Allowed", "allowed@example.invalid")]),
            committer: identity("Allowed", "allowed@example.invalid"),
        };

        assert.deepEqual(validateCommit(unsignedCommit, undefined, { requireSignature: false }), []);
        assert.match(validateCommit(unsignedCommit, undefined, { requireSignature: true })[0] ?? "", /signature status is N, expected G/u);
        const identityErrors = validateCommit(unsignedCommit, policy, { requireSignature: false });
        assert.equal(identityErrors.length, 2);
        assert.match(identityErrors[0], /unexpected author/u);
        assert.match(identityErrors[1], /unexpected committer/u);
    });

    test("{§lint-gate} CLI allows unsigned feature-branch and fork pushes while rejecting unsigned canonical main and tag pushes", async (t) => {
        const repo = await mkdtemp(path.join(tmpdir(), "plurnk-commit-provenance-"));
        t.after(() => rm(repo, { recursive: true, force: true }));
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
        const git = (...args) => exec("git", args, { cwd: repo, env });

        await git("init", "--quiet", "--initial-branch=feat/unsigned-dx");
        await git("config", "user.name", "External Contributor");
        await git("config", "user.email", "contributor@example.test");
        await git("config", "commit.gpgsign", "false");
        await git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "feat: unsigned change (#1534)");
        const sha = (await git("rev-parse", "HEAD")).stdout.trim();

        await git("remote", "add", "origin", "ssh://git@ssh.possumtech.com/plurnk/plurnk-service.git");
        await git("remote", "add", "fork", "git@github.com:contributor/plurnk-service.git");

        await assert.doesNotReject(
            exec(process.execPath, [SCRIPT_PATH, "origin", sha, ZERO, "refs/heads/feat/unsigned-dx"], { cwd: repo, env }),
        );
        await assert.doesNotReject(
            exec(process.execPath, [SCRIPT_PATH, "fork", sha, ZERO, "refs/heads/main"], { cwd: repo, env }),
        );
        await assert.rejects(
            exec(process.execPath, [SCRIPT_PATH, "origin", sha, ZERO, "refs/heads/main"], { cwd: repo, env }),
            /signature status is N, expected G/u,
        );
        await assert.rejects(
            exec(process.execPath, [SCRIPT_PATH, "origin", sha, ZERO, "refs/tags/v1.0.0"], { cwd: repo, env }),
            /signature status is N, expected G/u,
        );
        await assert.rejects(
            exec(process.execPath, [SCRIPT_PATH, "origin", sha, ZERO], { cwd: repo, env }),
            /signature status is N, expected G/u,
        );
    });
});

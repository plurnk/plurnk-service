import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { describe, it } from "node:test";
import { releaseNotes } from "./changelog.mjs";
import { classify } from "./deps-preflight.mjs";
import { REGISTRY_VISIBILITY_ATTEMPTS, awaitRegistryVersion } from "./lib/registry-visibility.mjs";
import { canonicalForgeOrigin, repositoryAuthorityViolations, repositoryName } from "./lib/release-authority.mjs";
import { packCandidate, readCandidate, writeJson } from "./lib/release-candidate.mjs";
import { auditProduction, verifyConsumer } from "./lib/release-consumer.mjs";
import { probeInstalledDaemon } from "./lib/release-daemon-probe.mjs";
import { candidateGraph, publicationOrder } from "./lib/release-package-graph.mjs";
import { assertPublishedArtifact, publishCandidates, registryPackage } from "./lib/release-registry.mjs";
import { assertReleaseHosting, finalizeRelease, packageReleaseNotes } from "./release-finalize.mjs";

const exec = promisify(execFile);
const cli = fileURLToPath(import.meta.resolve("@changesets/cli/bin.js"));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const gatesScript = path.join(import.meta.dirname, "release-gates.mjs");
const daemonFixture = fileURLToPath(new URL("./fixtures/release-daemon.mjs", import.meta.url));
const silent = () => {};

// {§release-finalization}: command-boundary witnesses; no registry or remote writes.
const COMMIT = "a".repeat(40);

test("{§release-finalization} every candidate uses its own versioned changelog at its verified commit", async () => {
    for (const packageFile of ["package.json", "plurnk-core/package.json", "plurnk-meta/package.json"]) {
        const notes = await packageReleaseNotes({ root: "/fixture", packageFile, version: "2.0.0", commit: COMMIT }, async (command, args, cwd) => {
            assert.equal(command, "git");
            assert.deepEqual(args, ["show", `${COMMIT}:${path.join(path.dirname(packageFile), "CHANGELOG.md")}`]);
            assert.equal(cwd, "/fixture");
            return "# Changes\n\n## 2.1.0\n\n- Later.\n\n## 2.0.0\n\n- Independent releases.\n\n## 1.0.0\n\n- Earlier.\n";
        });
        assert.equal(notes, "## 2.0.0\n\n- Independent releases.\n");
    }
});

test("{§release-finalization} missing or ambiguous package release notes fail qualification", async () => {
    const record = { root: "/fixture", packageFile: "package.json", version: "2.0.0", commit: COMMIT };
    for (const changelog of ["## 2.0.01\n", "## 1.0.0\n", "## 2.0.0\nA\n## 2.0.0\nB"]) {
        await assert.rejects(packageReleaseNotes(record, async () => changelog), /exactly one.*2\.0\.0/);
    }
    const failure = new Error("changelog is absent from the verified commit");
    await assert.rejects(packageReleaseNotes(record, async () => { throw failure; }), (cause) => cause === failure);
});

const finalizationFixture = ({ tag = false, release = false, registry = "1.2.3", remoteTag, remoteTags = { origin: remoteTag, github: remoteTag }, permission = true, releaseTag = "v1.2.3", mirrorMain = COMMIT } = {}) => {
    const calls = [];
    const manifest = { name: "@plurnk/plurnk-service", version: "1.2.3" };
    const run = async (command, args) => {
        calls.push([command, ...args]);
        const line = args.join(" ");
        if (command === "npm") return JSON.stringify({ ...manifest, version: registry });
        if (command === "gh") {
            if (args[0] === "api" && !line.includes("/releases")) return JSON.stringify({ permissions: { push: permission } });
            if (args[0] === "api") return JSON.stringify(release ? [{ tag_name: releaseTag, draft: false, prerelease: false }] : []);
            if (args[1] === "create") { release = true; return `https://github.com/plurnk/plurnk-service/releases/tag/${releaseTag}`; }
        }
        if (command === "git") {
            if (line === "remote get-url origin") return "ssh://git@ssh.possumtech.com/plurnk/plurnk-service.git";
            if (line === "remote get-url github") return "git@github.com:plurnk/plurnk-service.git";
            if (args[0] === "show") return JSON.stringify(manifest);
            if (args[0] === "rev-parse") return args[1].endsWith("^{commit}") ? COMMIT : "b".repeat(40);
            if (line === `tag --list ${releaseTag}`) return tag ? releaseTag : "";
            if (args[0] === "ls-remote") {
                if (args.includes("refs/heads/main")) {
                    if (args[1] === "github") return mirrorMain ? `${mirrorMain}\trefs/heads/main` : "";
                    return `${COMMIT}\trefs/heads/main`;
                }
                return remoteTags[args[1]] ? `${remoteTags[args[1]]}\trefs/tags/${releaseTag}` : "";
            }
            if (args[0] === "tag" && args[1] === "-s") { tag = true; return ""; }
            if (args[0] === "fetch") return "";
            if (args[0] === "push") {
                if (args.some((arg) => arg.endsWith(":refs/heads/main"))) { mirrorMain = COMMIT; return ""; }
                remoteTags[args.includes("origin") ? "origin" : "github"] = "b".repeat(40);
                return "";
            }
            if (args[0] === "verify-commit" || args[0] === "verify-tag" || args[0] === "merge-base") return "";
        }
        assert.fail(`unexpected command: ${command} ${line}`);
    };
    return { calls, run, options: { root: "/release-fixture", repo: "plurnk-service", packageFile: "plurnk-core/package.json", version: "1.2.3", commit: COMMIT, notes: "Fixes:\n\n- A verified fix.\n" } };
};

test("{§release-finalization} release hosting refuses missing GitHub write authority before publication", async () => {
    const { run } = finalizationFixture({ permission: false });
    await assert.rejects(assertReleaseHosting("/release-fixture", "plurnk-service", run), /GitHub.*write/);
});

test("{§release-finalization} finalization signs the exact published commit, pushes tags, then creates a verified-tag release", async () => {
    const { calls, run, options } = finalizationFixture();
    await finalizeRelease(options, run);
    const sign = calls.findIndex((c) => c[0] === "git" && c[1] === "tag" && c[2] === "-s");
    assert.ok(sign >= 0);
    assert.ok(calls[sign].includes(COMMIT));
    const origin = calls.findIndex((c) => c.includes("push") && c.includes("origin"));
    const mirror = calls.findIndex((c) => c.includes("push") && c.includes("github"));
    const create = calls.findIndex((c) => c[0] === "gh" && c[2] === "create");
    assert.ok(sign < origin && origin < mirror && mirror < create);
    assert.ok(calls[create].includes("--verify-tag"));
    assert.ok(calls[create].includes(options.notes));
    assert.ok(!calls.some((c) => c[0] === "npm" && c.includes("publish")));
    assert.ok(!calls.some((c) => c.includes("--force")));
});

test("{§release-finalization} finalization brings a stale mirror's main to the canonical main before any record, and leaves a current one alone", async () => {
    for (const mirrorMain of ["e".repeat(40), ""]) {
        const { calls, run, options } = finalizationFixture({ mirrorMain });
        await finalizeRelease(options, run);
        const carry = calls.findIndex((c) => c[0] === "git" && c[1] === "push" && c.includes(`${COMMIT}:refs/heads/main`));
        const create = calls.findIndex((c) => c[0] === "gh" && c[2] === "create");
        assert.ok(carry >= 0 && carry < create, `the mirror is carried before the record (${mirrorMain || "missing"})`);
        assert.deepEqual(calls[carry], ["git", "push", "--no-verify", "github", `${COMMIT}:refs/heads/main`]);
        assert.ok(!calls.some((c) => c.includes("--force")));
    }
    const current = finalizationFixture();
    await finalizeRelease(current.options, current.run);
    assert.ok(!current.calls.some((c) => c[1] === "push" && c.some((arg) => arg.endsWith(":refs/heads/main"))), "a current mirror is not pushed");
});

test("{§release-finalization} a mirror that cannot fast-forward stops publication with no record written", async () => {
    const { calls, run, options } = finalizationFixture({ mirrorMain: "e".repeat(40) });
    await assert.rejects(finalizeRelease(options, async (cmd, args, root) => {
        if (cmd === "git" && args[0] === "push" && args.some((arg) => arg.endsWith(":refs/heads/main"))) throw new Error("rejected: non-fast-forward");
        return run(cmd, args, root);
    }), /non-fast-forward/);
    assert.ok(!calls.some((c) => c[0] === "gh" && c[2] === "create"));
    const silentMirror = finalizationFixture({ mirrorMain: "e".repeat(40) });
    await assert.rejects(finalizeRelease(silentMirror.options, async (cmd, args, root) => {
        if (cmd === "git" && args[0] === "push" && args.some((arg) => arg.endsWith(":refs/heads/main"))) return "";
        return silentMirror.run(cmd, args, root);
    }), /mirror main is/);
    assert.ok(!silentMirror.calls.some((c) => c[0] === "gh" && c[2] === "create"));
});

test("{§release-finalization} repair requires an existing signed tag, not today's HEAD", async () => {
    const missing = finalizationFixture();
    await assert.rejects(finalizeRelease({ ...missing.options, commit: undefined }, missing.run), /existing.*tag/);
    assert.ok(!missing.calls.some((c) => c.includes("push") || c.includes("create")));
    const repair = finalizationFixture({ tag: true });
    await finalizeRelease({ ...repair.options, commit: undefined }, repair.run);
    assert.ok(repair.calls.some((c) => c[1] === "verify-tag"));
    assert.ok(!repair.calls.some((c) => c[1] === "tag" && c[2] === "-s"));
});

test("{§release-finalization} module tags are independent of the product version and can share its release record", async () => {
    for (const record of [false, true]) {
        const releaseTag = "@plurnk/plurnk-hooks@1.2.3";
        const { calls, run, options } = finalizationFixture({ releaseTag });
        await finalizeRelease({ ...options, tagName: releaseTag, record, composition: "Tested service: 2.4.0" }, run);
        assert.ok(calls.some((call) => call[0] === "git" && call[1] === "tag" && call[2] === "-s" && call.includes(releaseTag)));
        assert.ok(calls.some((call) => call[1] === "verify-tag" && call[2] === releaseTag));
        const releases = calls.filter((call) => call[0] === "gh" && call[1] === "release" && call[2] === "create");
        assert.equal(releases.length, record ? 1 : 0);
        if (record) {
            assert.ok(releases[0].includes(releaseTag));
            assert.match(releases[0].at(-1), /Tested service: 2.4.0/);
        }
    }
});

test("{§release-finalization} repeating finalization keeps tags and existing release records unchanged", async () => {
    const { run, options, calls } = finalizationFixture();
    await finalizeRelease(options, run);
    calls.length = 0;
    await finalizeRelease(options, run);
    assert.ok(!calls.some((c) => c.includes("push") || c.includes("create") || c.includes("edit") || c.includes("-s")));
});

test("{§release-finalization} repair pushes only missing tags, retaining verification on both remotes", async () => {
    for (const missing of ["origin", "github", undefined]) {
        const remoteTags = { origin: "b".repeat(40), github: "b".repeat(40) };
        if (missing !== undefined) delete remoteTags[missing];
        const { run, options, calls } = finalizationFixture({ tag: true, remoteTags });
        await finalizeRelease({ ...options, commit: undefined }, run);
        const pushes = calls.filter((c) => c.includes("push"));
        assert.deepEqual(pushes, missing === undefined ? [] : [
            missing === "origin"
                ? ["git", "push", "origin", "refs/tags/v1.2.3"]
                : ["git", "push", "--no-verify", "github", "refs/tags/v1.2.3"],
        ]);
        assert.ok(calls.some((c) => c[1] === "verify-tag"));
        assert.ok(calls.some((c) => c[0] === "gh" && c[2] === "create"));
    }
});

test("{§release-finalization} an unserved version cannot create a tag or a Release", async () => {
    const { run, options, calls } = finalizationFixture({ registry: "1.2.2" });
    await assert.rejects(finalizeRelease(options, run), /not served/);
    assert.ok(!calls.some((c) => c.includes("push") || c.includes("-s") || c.includes("create")));
});

test("{§release-finalization} npm 12's manifest array preserves publication verification", async () => {
    const { run, options, calls } = finalizationFixture({ tag: true });
    await finalizeRelease(options, async (command, args, root) => {
        const result = await run(command, args, root);
        return command === "npm" ? JSON.stringify([JSON.parse(result)]) : result;
    });
    assert.ok(calls.some((call) => call[1] === "verify-commit"));
    assert.ok(calls.some((call) => call[1] === "verify-tag"));
    assert.ok(calls.some((call) => call[0] === "gh" && call[1] === "release" && call[2] === "create"));
});

test("{§release-finalization} a conflicting remote tag is never overwritten or announced", async () => {
    const { run, options, calls } = finalizationFixture({ tag: true, remoteTag: "c".repeat(40) });
    await assert.rejects(finalizeRelease(options, run), /conflicting.*tag/);
    assert.ok(!calls.some((c) => c.includes("push") || c.includes("create")));
});

test("{§release-finalization} GitHub failure propagates; a retry repairs only the missing record", async () => {
    const { run, options } = finalizationFixture({ tag: true });
    await assert.rejects(finalizeRelease(options, async (cmd, args) => {
        if (cmd === "gh" && args[1] === "create") throw new Error("GitHub unavailable");
        return run(cmd, args);
    }), /GitHub unavailable/);
    await finalizeRelease(options, run);
});

test("{§release-finalization} wrong tag identity, unsigned sources, and unmerged commits cannot be released", async () => {
    for (const failure of ["tag", "signature", "ancestry", "gitHead"]) {
        const { run, options, calls } = finalizationFixture({ tag: true });
        await assert.rejects(finalizeRelease(options, async (cmd, args, root) => {
            if (failure === "tag" && args.join(" ") === "rev-parse v1.2.3^{commit}") return "d".repeat(40);
            if (failure === "signature" && args[0] === "verify-tag") throw new Error("invalid tag signature");
            if (failure === "ancestry" && args[0] === "merge-base") throw new Error("commit not on main");
            const result = await run(cmd, args, root);
            return failure === "gitHead" && cmd === "npm" ? JSON.stringify({ ...JSON.parse(result), gitHead: "d".repeat(40) }) : result;
        }), /conflicting local tag|invalid tag signature|commit not on main|published gitHead/);
        assert.ok(!calls.some((c) => c.includes("push") || c.includes("create")), failure);
    }
});

test("{§release-finalization} release notes are derived from the exact tagged range, not later commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "plurnk-release-notes-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const git = (...args) => exec("git", args, { cwd: root, env });
    try {
        await git("init", "--quiet");
        await git("config", "user.name", "Release test");
        await git("config", "user.email", "release@example.test");
        await git("config", "commit.gpgsign", "false");
        await git("config", "tag.gpgsign", "false");
        await git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "feat: earlier release");
        await git("tag", "v1.0.0");
        await git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "fix(parser): retained correction (#12)");
        await git("tag", "v1.1.0");
        await git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "feat: not released yet");
        const notes = await releaseNotes(root, "v1.1.0", "plurnk-service");
        assert.match(notes, /parser: retained correction/);
        assert.match(notes, /\[#12\]\(https:\/\/repo.possumtech.com\/plurnk\/plurnk-service\/issues\/12\)/);
        assert.doesNotMatch(notes, /earlier release|not released yet/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

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

test("{§release-finalization} canonical release repositories are signed main checkouts synchronized with PossumTech", () => {
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

test("{§release-finalization} release authority rejects the wrong forge, branch, or remote revision", () => {
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

const versionFixture = async (t, manifests, changesets) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "plurnk-release-version-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(path.join(cwd, ".changeset"));
    await symlink(path.join(repoRoot, "node_modules"), path.join(cwd, "node_modules"), "dir");
    const json = (file, value) => writeFile(path.join(cwd, file), `${JSON.stringify(value, null, 2)}\n`);
    await json("package.json", { name: "release-fixture", private: true, version: "1.0.0", workspaces: ["packages/*"] });
    await json("package-lock.json", { name: "release-fixture", version: "1.0.0", lockfileVersion: 3, packages: {} });
    await writeFile(path.join(cwd, ".changeset/config.json"), await readFile(path.join(repoRoot, ".changeset/config.json")));
    for (const [name, fields] of Object.entries(manifests)) {
        await mkdir(path.join(cwd, "packages", name), { recursive: true });
        await json(`packages/${name}/package.json`, { name, version: "2.0.0", ...fields });
    }
    for (const [index, releases] of changesets.entries()) {
        await writeFile(path.join(cwd, `.changeset/change-${index}.md`),
            `---\n${Object.entries(releases).map(([name, type]) => `${JSON.stringify(name)}: ${type}`).join("\n")}\n---\n\nA package change.\n`);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    await exec("git", ["init", "--quiet", "--initial-branch=main"], { cwd, env });
    await exec("git", ["-c", "core.hooksPath=/dev/null", "add", ".changeset", "package.json", "packages"], { cwd, env });
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Release test", "-c", "user.email=release@example.test", "commit", "-qm", "test: release fixture"], { cwd, env });
    return {
        version: async () => {
            await exec(process.execPath, [cli, "version"], { cwd, env });
            return Object.fromEntries(await Promise.all(Object.keys(manifests).map(async (name) => [
                name, JSON.parse(await readFile(path.join(cwd, `packages/${name}/package.json`), "utf8")),
            ])));
        },
    };
};

for (const type of ["patch", "minor"]) {
    test(`{§package-release-contract} a ${type} leaves compatible consumers and unrelated packages unchanged`, async (t) => {
        const f = await versionFixture(t, {
            framework: {},
            consumer: { dependencies: { framework: "^2.0.0" } },
            extension: { peerDependencies: { framework: "^2.0.0" } },
            unrelated: { version: "4.7.3" },
        }, [{ framework: type }]);
        const result = await f.version();
        assert.equal(result.framework.version, type === "patch" ? "2.0.1" : "2.1.0");
        assert.equal(result.consumer.version, "2.0.0");
        assert.equal(result.extension.version, "2.0.0");
        assert.equal(result.unrelated.version, "4.7.3");
        assert.equal(result.consumer.dependencies.framework, "^2.0.0");
        assert.equal(result.extension.peerDependencies.framework, "^2.0.0");
    });
}

test("{§package-release-contract} adopting an exact dependency fix creates a consumer patch, not a minor", async (t) => {
    const f = await versionFixture(t, {
        provider: {}, service: { dependencies: { provider: "2.0.0" } }, unrelated: {},
    }, [{ provider: "patch" }]);
    const result = await f.version();
    assert.equal(result.provider.version, "2.0.1");
    assert.equal(result.service.version, "2.0.1");
    assert.equal(result.service.dependencies.provider, "2.0.1");
    assert.equal(result.unrelated.version, "2.0.0");
});

test("{§package-release-contract} a dependency major updates its consumer requirement without copying its major", async (t) => {
    const f = await versionFixture(t, {
        framework: {}, consumer: { dependencies: { framework: "^2.0.0" } }, unrelated: {},
    }, [{ framework: "major" }]);
    const result = await f.version();
    assert.equal(result.framework.version, "3.0.0");
    assert.equal(result.consumer.version, "2.0.1");
    assert.equal(result.consumer.dependencies.framework, "^3.0.0");
    assert.equal(result.unrelated.version, "2.0.0");
});

test("{§package-release-contract} platform functionality has explicit minor intent and coalesces into one release", async (t) => {
    const f = await versionFixture(t, {
        mcp: {}, service: { dependencies: { mcp: "2.0.0" } }, unrelated: {},
    }, [{ mcp: "minor", service: "minor" }, { mcp: "patch", service: "minor" }]);
    const result = await f.version();
    assert.equal(result.mcp.version, "2.1.0");
    assert.equal(result.service.version, "2.1.0");
    assert.equal(result.service.dependencies.mcp, "2.1.0");
    assert.equal(result.unrelated.version, "2.0.0");
});

test("{§package-release-contract} compatible peer ranges survive an extension's independent fix", async (t) => {
    const f = await versionFixture(t, {
        framework: {}, extension: { peerDependencies: { framework: "^2.0.0" } },
    }, [{ framework: "minor", extension: "patch" }]);
    const result = await f.version();
    assert.equal(result.framework.version, "2.1.0");
    assert.equal(result.extension.version, "2.0.1");
    assert.equal(result.extension.peerDependencies.framework, "^2.0.0");
});

const candidateRecords = () => [
    { name: "consumer", version: "4.3.0", manifest: { name: "consumer", version: "4.3.0", dependencies: { contract: "^2.0.0" } } },
    { name: "contract", version: "2.1.0", manifest: { name: "contract", version: "2.1.0" } },
].map((record) => ({ ...record, commit: "a".repeat(40), integrity: `sha512-${record.name}` }));
const publishedRecord = ({ name, version, commit, integrity }) => ({ name, version, gitHead: commit, dist: { integrity } });

test("{§release-candidate-graph} publication follows dependency identities without changing sources or versions", async () => {
    const selected = candidateRecords();
    const original = structuredClone(selected);
    const registry = new Map();
    const calls = [];
    await publishCandidates(selected, {
        lookup: async (name, version) => {
            assert.ok(selected.some((record) => record.name === name && record.version === version));
            return registry.get(name);
        },
        publish: async (record) => { calls.push(record.name); registry.set(record.name, publishedRecord(record)); },
    });
    assert.deepEqual(calls, ["contract", "consumer"]);
    assert.deepEqual(selected, original);
});

test("{§release-candidate-graph} an interrupted publication resumes only its missing immutable artifacts", async () => {
    const selected = candidateRecords();
    const registry = new Map();
    const calls = [];
    const lookup = async (name) => registry.get(name);
    await assert.rejects(publishCandidates(selected, { lookup, publish: async (record) => {
        calls.push(record.name);
        if (record.name === "consumer") throw new Error("publication refused");
        registry.set(record.name, publishedRecord(record));
    } }), /publication refused/);
    assert.deepEqual(calls, ["contract", "consumer"]);
    calls.length = 0;
    await publishCandidates(selected, { lookup, publish: async (record) => {
        calls.push(record.name);
        registry.set(record.name, publishedRecord(record));
    } });
    assert.deepEqual(calls, ["consumer"]);
    assert.equal(registry.size, 2);
});

test("{§release-candidate-graph} independent packages upload before waiting, but consumers require verified dependencies", async () => {
    const selected = [...candidateRecords(), { name: "independent", version: "1.0.0", manifest: { name: "independent", version: "1.0.0" }, commit: "a".repeat(40), integrity: "sha512-independent" }];
    const calls = [];
    const uploaded = new Map();
    const visible = new Map();
    await publishCandidates(selected, {
        lookup: async (name) => visible.get(name),
        publish: async (record) => { calls.push(`publish ${record.name}`); uploaded.set(record.name, publishedRecord(record)); },
        wait: async ({ name }) => { calls.push(`verify ${name}`); visible.set(name, uploaded.get(name)); },
    });
    assert.deepEqual(calls, ["publish contract", "publish independent", "verify contract", "verify independent", "publish consumer", "verify consumer"]);
});

test("{§release-candidate-graph} registry uncertainty and immutable conflicts prevent every upload", async () => {
    for (const failure of ["network", "conflict"]) {
        const calls = [];
        const selected = candidateRecords();
        await assert.rejects(publishCandidates(selected, {
            lookup: async (name) => {
                if (name !== "contract") return undefined;
                if (failure === "network") throw new Error("network unavailable");
                return { ...publishedRecord(selected[1]), dist: { integrity: "different" } };
            },
            publish: async (record) => calls.push(record.name),
        }), /network unavailable|artifact differs/);
        assert.deepEqual(calls, []);
    }
});

test("{§release-candidate-graph} invisible or altered publication stops before its consumers", async () => {
    for (const failure of ["visibility", "changed"]) {
        const calls = [];
        const registry = new Map();
        await assert.rejects(publishCandidates(candidateRecords(), {
            lookup: async (name) => registry.get(name),
            publish: async (record) => {
                calls.push(record.name);
                registry.set(record.name, { ...publishedRecord(record), dist: { integrity: "different" } });
            },
            wait: async () => { if (failure === "visibility") throw new Error("visibility exhausted"); },
        }), /visibility exhausted|artifact differs/);
        assert.deepEqual(calls, ["contract"]);
    }
});

test("{§release-candidate-graph} incompatible candidate edges cannot publish partially", async () => {
    const selected = candidateRecords();
    selected[0].manifest.dependencies.contract = "^1.0.0";
    const calls = [];
    await assert.rejects(publishCandidates(selected, {
        lookup: async () => undefined,
        publish: async (record) => calls.push(record.name),
    }), /excludes candidate/);
    assert.deepEqual(calls, []);
});

test("{§release-candidate-graph} release qualification audits the installed composition and retains package-owned checks", async () => {
    const gates = await readFile(new URL("./release-gates.mjs", import.meta.url), "utf8");
    const consumer = await readFile(new URL("./lib/release-consumer.mjs", import.meta.url), "utf8");
    assert.match(consumer, /\["install", "--no-audit", "--no-fund", "--include=peer", \.\.\.specs\]/);
    assert.match(consumer, /await auditProduction\(cwd\)/);
    assert.match(consumer, /\["audit", "--audit-level=moderate", "--omit=dev"\]/);
    assert.match(consumer, /npm_config_fetch_retries: "0"/);
    assert.match(consumer, /npm_config_fetch_timeout: "60000"/);
    assert.match(consumer, /audit UNREACHABLE[\s\S]*continuing/);
    const [, classifier] = consumer.match(/const unreachable = \/(.+)\/iu/u);
    assert.ok(new RegExp(classifier, "iu").test("npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk"));
    assert.ok(!new RegExp(classifier, "iu").test("found 3 vulnerabilities (1 moderate, 2 high)"));
    assert.match(gates, /\["scripts\/package-provenance\.mjs", "--pack"\]/);
    assert.match(gates, /\["scripts\/package-publint\.mjs"\]/);
    assert.match(gates, /pkg\.scripts\?\.\["release:check"\]/);
});

test("{§release-candidate-graph} release:gate enforces dependency freshness and checks selected packages without invoking an excluded product", async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "plurnk-selected-gates-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const json = (file, value) => writeFile(path.join(cwd, file), JSON.stringify(value));
    await mkdir(path.join(cwd, "scripts"));
    await mkdir(path.join(cwd, "bin"));
    const record = 'import { appendFileSync } from "node:fs"; appendFileSync("calls.jsonl", JSON.stringify(process.argv.slice(1)) + "\\n");';
    for (const script of ["package-build-policy", "package-provenance", "package-publint", "package-types"]) {
        await writeFile(path.join(cwd, "scripts", `${script}.mjs`), record);
    }
    const rootManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    await json("package.json", {
        name: "fixture", private: true, workspaces: ["alpha", "beta", "excluded"],
        scripts: { "release:gate": rootManifest.scripts["release:gate"] },
    });
    await json("deps-waivers.json", { waivers: {}, ownerVeto: [] });
    await writeFile(path.join(cwd, "scripts", "release-gates.mjs"), await readFile(gatesScript));
    await mkdir(path.join(cwd, "scripts", "lib"));
    await writeFile(path.join(cwd, "scripts", "lib", "usage.mjs"), await readFile(path.join(import.meta.dirname, "lib", "usage.mjs")));
    await writeFile(path.join(cwd, "scripts", "deps-preflight.mjs"), await readFile(path.join(import.meta.dirname, "deps-preflight.mjs")));
    for (const name of ["alpha", "beta", "excluded"]) {
        await mkdir(path.join(cwd, name));
        await json(`${name}/package.json`, {
            name, version: "2.0.0",
            scripts: { "release:check": name === "excluded" ? "node -e 'process.exit(19)'" : 'node -e \'require("node:fs").writeFileSync("checked", "yes")\'' },
        });
    }
    const npm = await realpath((await exec("which", ["npm"])).stdout.trim());
    const shim = path.join(cwd, "bin", "npm");
    await writeFile(shim, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify(["npm", ...args]) + "\\n");
if (args[0] === "outdated") {
    console.log(process.env.FAKE_OUTDATED ?? "{}");
    process.exit(process.env.FAKE_OUTDATED ? 1 : 0);
}
if (args[0] !== "audit") {
    const child = spawnSync(process.execPath, [${JSON.stringify(npm)}, ...args], { stdio: "inherit" });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
}
`);
    await chmod(shim, 0o755);
    const env = { ...process.env, PATH: `${path.join(cwd, "bin")}${path.delimiter}${process.env.PATH}` };
    await assert.rejects(
        exec("npm", ["run", "release:gate", "--", "--only", "alpha", "--only", "beta"], {
            cwd,
            env: { ...env, FAKE_OUTDATED: JSON.stringify({ stale: { current: "1.0.0", latest: "2.0.0" } }) },
        }),
        /deps-preflight FAILED — 1 outdated & unwaived/,
    );
    const selected = await exec("npm", ["run", "release:gate", "--", "--only", "alpha", "--only", "beta"], { cwd, env });
    assert.equal(await readFile(path.join(cwd, "alpha", "checked"), "utf8"), "yes");
    assert.equal(await readFile(path.join(cwd, "beta", "checked"), "utf8"), "yes");
    assert.match(selected.stdout, /2 package-specific check\(s\)/);
    const calls = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some((args) => args[0].endsWith("package-provenance.mjs") && args.includes("--pack") && args.includes("alpha") && args.includes("beta")));
    assert.ok(calls.some((args) => args[0].endsWith("package-publint.mjs") && args.includes("alpha") && args.includes("beta")));
    assert.ok(calls.some((args) => args[0].endsWith("package-types.mjs") && args.includes("alpha") && args.includes("beta")));
    assert.equal(calls.some((args) => args.includes("excluded")), false);
    assert.equal(calls.some((args) => args[0] === "npm" && args[1] === "outdated"), true);
    await assert.rejects(exec(process.execPath, [gatesScript, "--only", "missing"], { cwd, env }), /unknown workspace directory: missing/);
    await assert.rejects(exec(process.execPath, [gatesScript], { cwd, env }), /release:check/);
});

const OUT = { linkedom: { current: "0.18.13", latest: "1.0.0" } };
const WAIVER = { reason: "1.0 drops required loose-fragment parsing", issue: "https://example.test/issues/500", lane: "mimetypes" };

describe("deps-preflight classify — fail on any unwaived update", () => {
    it("{§release-candidate-graph} passes a fresh tree (nothing outdated)", () => {
        const { blockers, excused } = classify({}, {}, [], new Set());
        assert.deepEqual(blockers, []);
        assert.deepEqual(excused, []);
    });

    it("{§release-candidate-graph} blocks an outdated package with no waiver", () => {
        const { blockers, excused } = classify(OUT, {}, [], new Set());
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].name, "linkedom");
        assert.equal(blockers[0].latest, "1.0.0");
    });

    it("{§release-candidate-graph} excuses an outdated package with a complete waiver", () => {
        const { blockers, excused } = classify(OUT, { linkedom: WAIVER }, [], new Set());
        assert.equal(blockers.length, 0);
        assert.equal(excused.length, 1);
        assert.equal(excused[0].name, "linkedom");
    });

    it("{§release-candidate-graph} blocks an incomplete waiver (missing issue)", () => {
        const { blockers, excused } = classify(OUT, { linkedom: { reason: "later", lane: "mimetypes" } }, [], new Set());
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
    });

    it("{§release-candidate-graph} ownerVeto outranks a complete waiver — blocks and flags it vetoed", () => {
        const { blockers, excused } = classify(OUT, { linkedom: WAIVER }, ["linkedom"], new Set());
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].vetoed, true);
    });

    it("{§release-candidate-graph} handles npm's array shape (one dep outdated across several workspaces)", () => {
        const arr = { turndown: [{ current: "7.2.0", latest: "7.2.4" }, { current: "7.2.0", latest: "7.2.4" }] };
        const { blockers } = classify(arr, {}, [], new Set());
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].latest, "7.2.4");
    });

    it("{§release-candidate-graph} skips workspace platform packages but blocks @plurnk-scoped externals (#349)", () => {
        const out = {
            "@plurnk/plurnk-contracts": { current: "1.9.0", latest: "1.9.1" },
            "@plurnk/plurnk-mimetypes-grammar-fsharp": { current: "1.3.1", latest: "1.4.0" },
        };
        const { blockers, excused } = classify(out, {}, [], new Set(["@plurnk/plurnk-contracts"]));
        assert.equal(excused.length, 0);
        assert.equal(blockers.length, 1);
        assert.equal(blockers[0].name, "@plurnk/plurnk-mimetypes-grammar-fsharp");
    });
});

const candidateArchiveFixture = async (t, manifests) => {
    const directory = await mkdtemp(path.join(tmpdir(), "plurnk-qualified-release-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const records = [];
    for (const manifest of manifests) {
        const cwd = path.join(directory, manifest.name);
        await mkdir(cwd, { recursive: true });
        await writeJson(path.join(cwd, "package.json"), { type: "module", ...manifest });
        await writeFile(path.join(cwd, "index.js"), "export const value = 42;\n");
        records.push(await packCandidate({
            cwd, root: cwd, repo: "example", packageFile: "package.json", manifest,
            commit: "a".repeat(40),
        }, directory));
    }
    await writeJson(path.join(directory, "release.json"), { qualified: "2026-10-07T00:00:00Z", packages: records });
    return { directory, records };
};

test("{§release-candidate-graph} qualification installs independent archives and retains the resolved composition", async (t) => {
    const { directory, records } = await candidateArchiveFixture(t, [
        { name: "release-fixture-contract", version: "3.2.0" },
        { name: "release-fixture-service", version: "2.4.0", dependencies: { "release-fixture-contract": "^3.0.0" } },
        { name: "release-fixture-client", version: "4.1.2", optionalDependencies: { "release-fixture-service": "^2.0.0" } },
    ]);
    const evidence = path.join(directory, "installed-lock.json");
    await verifyConsumer(records, { directory, evidence });
    const lock = JSON.parse(await readFile(evidence, "utf8"));
    for (const { name, version, integrity } of records) {
        assert.equal(lock.packages[`node_modules/${name}`].version, version);
        assert.equal(lock.packages[`node_modules/${name}`].integrity, integrity);
    }
    assert.deepEqual((await readCandidate(directory)).packages, records);
});

test("{§release-candidate-graph} qualified archives carry the verified source and only shipped export conditions", async (t) => {
    const { directory, records } = await candidateArchiveFixture(t, [{
        name: "release-fixture", version: "2.0.0",
        exports: { ".": { "plurnk-dev": "./missing.ts", default: "./index.js" } },
    }]);
    const [record] = (await readCandidate(directory)).packages;
    assert.deepEqual(record.manifest.exports, { ".": { default: "./index.js" } });
    assert.equal(record.manifest.gitHead, records[0].commit);
});

test("{§release-candidate-graph} a changed archive cannot resume publication", async (t) => {
    const { directory, records } = await candidateArchiveFixture(t, [{ name: "release-fixture", version: "2.0.0" }]);
    await appendFile(path.join(directory, records[0].archive), "changed");
    await assert.rejects(readCandidate(directory), /qualified archive changed/);
});

test("{§release-candidate-graph} an edited manifest record cannot substitute an untested dependency", async (t) => {
    const { directory, records } = await candidateArchiveFixture(t, [{ name: "release-fixture", version: "2.0.0" }]);
    records[0].manifest.dependencies = { unexpected: "*" };
    await writeFile(path.join(directory, "release.json"), JSON.stringify({ qualified: "yes", packages: records }));
    await assert.rejects(readCandidate(directory), /qualified manifest changed/);
});

test("{§release-candidate-graph} incomplete qualification cannot publish", async (t) => {
    const { directory, records } = await candidateArchiveFixture(t, [{ name: "release-fixture", version: "2.0.0" }]);
    await writeFile(path.join(directory, "release.json"), JSON.stringify({ packages: records }));
    await assert.rejects(readCandidate(directory), /not completed qualification/);
});

test("{§release-candidate-graph} audit checks the selected production install with bounded network work", async () => {
    let called = false;
    await auditProduction("/candidate/consumer", { run: async (command, args, options) => {
        called = true;
        assert.equal(command, "npm");
        assert.deepEqual(args, ["audit", "--audit-level=moderate", "--omit=dev"]);
        assert.equal(options.cwd, "/candidate/consumer");
        assert.equal(options.env.npm_config_fetch_retries, "0");
        assert.equal(options.env.npm_config_fetch_timeout, "60000");
    } });
    assert.equal(called, true);
});

test("{§release-candidate-graph} real audit findings and unexpected failures retain their cause", async () => {
    for (const stderr of ["found 2 vulnerabilities (1 moderate, 1 high)", "invalid lockfile"]) {
        const failure = Object.assign(new Error("npm audit failed"), { stderr });
        await assert.rejects(auditProduction("/candidate/consumer", { run: async () => { throw failure; } }), (error) => error === failure);
    }
});

test("{§release-candidate-graph} an unreachable advisory service is reported rather than called clean", async () => {
    const warnings = [];
    await auditProduction("/candidate/consumer", {
        run: async () => { throw Object.assign(new Error("network"), { stderr: "npm warn audit network timeout" }); },
        warn: (message) => warnings.push(message),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /audit UNREACHABLE.*continuing/);
});

const runProbe = (env, options = {}) => probeInstalledDaemon({
    command: process.execPath,
    args: [daemonFixture],
    cwd: import.meta.dirname,
    env: { ...process.env, ...env },
    packageName: "@plurnk/plurnk-service",
    version: "1.10.1",
    timeoutMs: 5_000,
    stopTimeoutMs: 2_000,
    writeStdout: silent,
    writeStderr: silent,
    ...options,
});

test("{§release-candidate-graph} release probe authenticates its child-owned ephemeral listener and awaits graceful teardown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-release-probe-"));
    const cleanup = join(dir, "closed");
    const stale = createServer();
    try {
        await new Promise((resolve, reject) => {
            stale.once("error", reject);
            stale.listen(0, "127.0.0.1", resolve);
        });
        const address = stale.address();
        if (address === null || typeof address === "string") throw new Error("stale fixture did not bind TCP");
        const result = await runProbe({
            PLURNK_PORT: String(address.port),
            PLURNK_RELEASE_PROBE_CLEANUP: cleanup,
        });
        assert.notEqual(new URL(result.address).port, String(address.port), "operator/stale port input cannot select the probe listener");
        assert.equal(new URL(result.address).pathname, "/acp", "the full protocol endpoint is retained");
        await access(cleanup);
    } finally {
        await new Promise((resolve) => stale.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

for (const [mode, failure] of [
    ["no-auth", /listener returned 404 .*expected 401/u],
    ["bad-challenge", /listener did not advertise its Bearer credential authority/u],
    ["token-fails", /token exchange returned 401/u],
    ["bad-token", /token exchange did not return a Bearer access token/u],
    ["invalid-access", /listener returned 401 .*expected 404/u],
]) test(`{§acp-http-authorization} release probe rejects ${mode} without bypassing authentication`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-release-probe-auth-"));
    const cleanup = join(dir, "closed");
    try {
        await assert.rejects(runProbe({
            PLURNK_RELEASE_PROBE_FIXTURE: mode,
            PLURNK_RELEASE_PROBE_CLEANUP: cleanup,
        }), failure);
        await access(cleanup);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§release-candidate-graph} release probe rejects the spawned artifact's wrong version and still reaps it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-release-probe-version-"));
    const cleanup = join(dir, "closed");
    try {
        await assert.rejects(
            runProbe({
                PLURNK_RELEASE_PROBE_VERSION: "1.9.2",
                PLURNK_RELEASE_PROBE_CLEANUP: cleanup,
            }),
            /identified @plurnk\/plurnk-service@1\.9\.2; expected @plurnk\/plurnk-service@1\.10\.1/,
        );
        await access(cleanup);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§release-candidate-graph} release probe rejects premature child exit with its exact status", async () => {
    await assert.rejects(
        runProbe({ PLURNK_RELEASE_PROBE_FIXTURE: "exit" }),
        /exited before readiness \(7\)/,
    );
});

test("{§release-candidate-graph} release probe rejects unsuccessful shutdown after successful readiness", async () => {
    await assert.rejects(
        runProbe({ PLURNK_RELEASE_PROBE_FIXTURE: "fail-stop" }),
        /installed daemon shutdown failed \(9\)/,
    );
});

test("{§release-candidate-graph} release probe reaps a nonresponsive daemon but does not call forced shutdown successful", async () => {
    await assert.rejects(
        runProbe({ PLURNK_RELEASE_PROBE_FIXTURE: "hang-stop" }, { stopTimeoutMs: 100 }),
        /installed daemon did not shut down within 100ms; forced termination \(SIGKILL\)/,
    );
});

test("{§release-candidate-graph} release probe preserves both a listener failure and an unsuccessful shutdown", async () => {
    await assert.rejects(
        runProbe({
            PLURNK_RELEASE_PROBE_FIXTURE: "fail-stop",
            PLURNK_RELEASE_PROBE_VERSION: "1.9.2",
        }),
        (error) => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.message, "installed daemon probe and teardown failed");
            assert.equal(error.errors.length, 2);
            assert.match(error.errors[0].message, /identified.*1\.9\.2; expected.*1\.10\.1/);
            assert.match(error.errors[1].message, /installed daemon shutdown failed \(9\)/);
            return true;
        },
    );
});

test("{§release-candidate-graph} release probe preserves a spawn failure instead of masking it during teardown", async () => {
    await assert.rejects(
        runProbe({}, { command: join(tmpdir(), "plurnk-missing-release-probe") }),
        { code: "ENOENT" },
    );
});

test("{§release-candidate-graph} release probe rejects a non-ACP responder and still reaps the child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-release-probe-http-"));
    const cleanup = join(dir, "closed");
    try {
        await assert.rejects(
            runProbe({
                PLURNK_RELEASE_PROBE_FIXTURE: "bad-http",
                PLURNK_RELEASE_PROBE_CLEANUP: cleanup,
            }),
            /listener returned 200 text\/plain/,
        );
        await access(cleanup);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

const pkg = (name, version, fields = {}) => ({ name, version, ...fields });

test("{§release-candidate-graph} each dependency is checked against its own version, not a platform stamp", () => {
    const packages = [
        pkg("service", "2.4.0", { dependencies: { framework: "^3.1.0", extension: "2.0.1" } }),
        pkg("framework", "3.2.0"),
        pkg("extension", "2.0.1", { peerDependencies: { framework: ">=3.1.0 <4" } }),
    ];
    const graph = candidateGraph(packages);
    assert.deepEqual(publicationOrder(graph).map(({ name }) => name), ["framework", "extension", "service"]);
});

test("{§release-candidate-graph} an absent independent product is not inspected or required", () => {
    const graph = candidateGraph([pkg("hooks", "2.0.1", { peerDependencies: { modules: "^2.0.0" } })]);
    assert.deepEqual(publicationOrder(graph).map(({ name }) => name), ["hooks"]);
});

test("{§release-candidate-graph} invalid candidate edges identify the exact consumer and incompatible dependency", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
        assert.throws(() => candidateGraph([
            pkg("extension", "2.0.0", { [field]: { framework: "^1.0.0" } }),
            pkg("framework", "2.0.0"),
        ]), new RegExp(`extension@2\\.0\\.0: ${field}\\.framework@\\^1\\.0\\.0 excludes candidate 2\\.0\\.0`));
    }
});

test("{§release-candidate-graph} compatibility uses ordinary SemVer ranges and does not require matching majors", () => {
    for (const range of ["^2.0.0", "~2.1.0", ">=2 <3", "^1 || ^2", "2.1.3"]) {
        assert.doesNotThrow(() => candidateGraph([
            pkg("consumer", "7.0.0", { dependencies: { framework: range } }), pkg("framework", "2.1.3"),
        ]));
    }
});

test("{§release-candidate-graph} duplicate identities and invalid package versions fail before publication", () => {
    assert.throws(() => candidateGraph([pkg("one", "2.0.0"), pkg("one", "2.1.0")]), /duplicate candidate package one/);
    assert.throws(() => candidateGraph([pkg("one", "next")]), /one: invalid package version/);
    for (const version of ["2.0.0-beta.1", "2.0.0+build", "v2.0.0"]) {
        assert.throws(() => candidateGraph([pkg("one", version)]), /expected stable major.minor.patch/);
    }
});

test("{§release-candidate-graph} build-only edges do not introduce runtime publication cycles", () => {
    const graph = candidateGraph([
        pkg("framework", "2.0.0", { devDependencies: { grammar: "2.0.0" } }),
        pkg("grammar", "2.0.0", { peerDependencies: { framework: "^2.0.0" } }),
    ]);
    assert.deepEqual(publicationOrder(graph).map(({ name }) => name), ["framework", "grammar"]);
});

test("{§release-candidate-graph} a runtime dependency cycle names the path and cannot publish partially", () => {
    assert.throws(() => publicationOrder(candidateGraph([
        pkg("one", "2.0.0", { dependencies: { two: "^2.0.0" } }),
        pkg("two", "2.0.0", { dependencies: { one: "^2.0.0" } }),
    ])), /publication cycle: one -> two -> one/);
});

const regName = "@plurnk/example";
const regVersion = "2.1.3";
const regCandidate = { name: regName, version: regVersion, integrity: "sha512-tested", commit: "a".repeat(40) };
const regError = (code) => Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) });

test("{§release-candidate-graph} registry queries the exact version even when it is not latest", async () => {
    const result = await registryPackage(regName, regVersion, async (spec) => {
        assert.equal(spec, `${regName}@${regVersion}`);
        return JSON.stringify({ name: regName, version: regVersion, "dist-tags": { latest: "3.0.0" } });
    });
    assert.equal(result.version, regVersion);
});

test("{§release-candidate-graph} npm 12's manifest array still verifies exact registry identity", async () => {
    const manifest = { name: regName, version: regVersion, dist: { integrity: regCandidate.integrity } };
    assert.deepEqual(await registryPackage(regName, regVersion, async () => JSON.stringify([manifest])), manifest);
    await assert.rejects(registryPackage(regName, regVersion, async () => JSON.stringify([{ ...manifest, version: "3.0.0" }])), /different identity/);
    await assert.rejects(registryPackage(regName, regVersion, async () => JSON.stringify([manifest, manifest])), /no unique package manifest/);
});

test("{§release-candidate-graph} only explicit missing-version evidence permits publication", async () => {
    assert.equal(await registryPackage(regName, regVersion, async () => { throw regError("E404"); }), undefined);
    for (const cause of [regError("E401"), regError("E500"), regError("ETIMEDOUT"), new Error("connection lost")]) {
        await assert.rejects(registryPackage(regName, regVersion, async () => { throw cause; }), (result) => {
            assert.equal(result.cause, cause);
            assert.match(result.message, /registry lookup failed/);
            return true;
        });
    }
});

test("{§release-candidate-graph} malformed and mismatched registry responses fail closed", async () => {
    await assert.rejects(registryPackage(regName, regVersion, async () => "not json"), SyntaxError);
    await assert.rejects(registryPackage(regName, regVersion, async () => JSON.stringify({ name: regName, version: "3.0.0" })), /different identity/);
});

test("{§release-candidate-graph} resuming an immutable version requires the same archive and source", () => {
    const published = { name: regName, version: regVersion, dist: { integrity: regCandidate.integrity }, gitHead: regCandidate.commit };
    assert.doesNotThrow(() => assertPublishedArtifact(regCandidate, published));
    for (const mismatch of [
        { version: "2.1.4" }, { name: "different" }, { dist: { integrity: "sha512-different" } }, { gitHead: "b".repeat(40) },
    ]) assert.throws(() => assertPublishedArtifact(regCandidate, { ...published, ...mismatch }), /differs/);
});

test("{§release-candidate-graph} registry visibility tolerates ordinary post-publication propagation", async () => {
    const observed = [null, "1.7.0", "1.8.0"];
    const waits = [];

    await awaitRegistryVersion({
        name: "@plurnk/example",
        version: "1.8.0",
        lookup: async () => observed.shift(),
        wait: async (milliseconds) => waits.push(milliseconds),
    });

    assert.equal(REGISTRY_VISIBILITY_ATTEMPTS, 90);
    assert.deepEqual(waits, [10_000, 10_000]);
});

test("{§release-candidate-graph} registry visibility remains bounded and names the unpublished artifact", async () => {
    let attempts = 0;

    await assert.rejects(
        awaitRegistryVersion({
            name: "@plurnk/example",
            subject: "example leaf",
            version: "1.8.0",
            attempts: 3,
            lookup: async () => {
                attempts += 1;
                return null;
            },
            wait: async () => undefined,
        }),
        /example leaf: published but the registry never served 1\.8\.0/,
    );
    assert.equal(attempts, 3);
});

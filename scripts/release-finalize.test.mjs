import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertReleaseHosting, finalizeRelease } from "./release-finalize.mjs";
import { releaseNotes } from "./changelog.mjs";

// {§release-finalization}: command-boundary witnesses; no registry or remote writes.
const COMMIT = "a".repeat(40);
const fixture = ({ tag = false, release = false, registry = "1.2.3", remoteTag, permission = true } = {}) => {
    const calls = [];
    const manifest = { name: "@plurnk/plurnk-service", version: "1.2.3" };
    const run = async (command, args) => {
        calls.push([command, ...args]);
        const line = args.join(" ");
        if (command === "npm") return JSON.stringify({ ...manifest, version: registry });
        if (command === "gh") {
            if (args[0] === "api" && !line.includes("/releases")) return JSON.stringify({ permissions: { push: permission } });
            if (args[0] === "api") return JSON.stringify(release ? [{ tag_name: "v1.2.3", draft: false, prerelease: false }] : []);
            if (args[1] === "create") { release = true; return "https://github.com/plurnk/plurnk-service/releases/tag/v1.2.3"; }
        }
        if (command === "git") {
            if (line === "remote get-url origin") return "ssh://git@ssh.possumtech.com/plurnk/plurnk-service.git";
            if (line === "remote get-url github") return "git@github.com:plurnk/plurnk-service.git";
            if (args[0] === "show") return JSON.stringify(manifest);
            if (args[0] === "rev-parse") return args[1].endsWith("^{commit}") ? COMMIT : "b".repeat(40);
            if (line === "tag --list v1.2.3") return tag ? "v1.2.3" : "";
            if (args[0] === "ls-remote") {
                if (args.includes("refs/heads/main")) return `${COMMIT}\trefs/heads/main`;
                return remoteTag ? `${remoteTag}\trefs/tags/v1.2.3` : "";
            }
            if (args[0] === "tag" && args[1] === "-s") { tag = true; return ""; }
            if (args[0] === "verify-commit" || args[0] === "verify-tag" || args[0] === "merge-base" || args.includes("push")) return "";
        }
        assert.fail(`unexpected command: ${command} ${line}`);
    };
    return { calls, run, options: { root: "/release-fixture", repo: "plurnk-service", packageFile: "plurnk-core/package.json", version: "1.2.3", commit: COMMIT, notes: "Fixes:\n\n- A verified fix.\n" } };
};

test("release hosting refuses missing GitHub write authority before publication", async () => {
    const { run } = fixture({ permission: false });
    await assert.rejects(assertReleaseHosting("/release-fixture", "plurnk-service", run), /GitHub.*write/);
});

test("finalization signs the exact published commit, pushes tags, then creates a verified-tag release", async () => {
    const { calls, run, options } = fixture();
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

test("repair requires an existing signed tag, not today's HEAD", async () => {
    const missing = fixture();
    await assert.rejects(finalizeRelease({ ...missing.options, commit: undefined }, missing.run), /existing.*tag/);
    assert.ok(!missing.calls.some((c) => c.includes("push") || c.includes("create")));
    const repair = fixture({ tag: true });
    await finalizeRelease({ ...repair.options, commit: undefined }, repair.run);
    assert.ok(repair.calls.some((c) => c[1] === "verify-tag"));
    assert.ok(!repair.calls.some((c) => c[1] === "tag" && c[2] === "-s"));
});

test("repeating finalization keeps tags and existing release records unchanged", async () => {
    const { run, options, calls } = fixture({ tag: true, release: true });
    await finalizeRelease(options, run);
    assert.ok(!calls.some((c) => c.includes("create") || c.includes("edit") || c.includes("-s")));
});

test("an unserved version cannot create a tag or a Release", async () => {
    const { run, options, calls } = fixture({ registry: "1.2.2" });
    await assert.rejects(finalizeRelease(options, run), /not served/);
    assert.ok(!calls.some((c) => c.includes("push") || c.includes("-s") || c.includes("create")));
});

test("a conflicting remote tag is never overwritten or announced", async () => {
    const { run, options, calls } = fixture({ tag: true, remoteTag: "c".repeat(40) });
    await assert.rejects(finalizeRelease(options, run), /conflicting.*tag/);
    assert.ok(!calls.some((c) => c.includes("push") || c.includes("create")));
});

test("GitHub failure propagates; a retry repairs only the missing record", async () => {
    const { run, options } = fixture({ tag: true });
    await assert.rejects(finalizeRelease(options, async (cmd, args) => {
        if (cmd === "gh" && args[1] === "create") throw new Error("GitHub unavailable");
        return run(cmd, args);
    }), /GitHub unavailable/);
    await finalizeRelease(options, run);
});

test("wrong tag identity, unsigned sources, and unmerged commits cannot be released", async () => {
    for (const failure of ["tag", "signature", "ancestry", "gitHead"]) {
        const { run, options, calls } = fixture({ tag: true });
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

test("release notes are derived from the exact tagged range, not later commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "plurnk-release-notes-"));
    const exec = promisify(execFile);
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

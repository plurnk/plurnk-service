import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPackageTypes } from "./package-types.mjs";

const fixture = async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "plurnk-package-types-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packages = {
        "code package": { name: "@example/code", files: ["dist/**/*"] },
        meta: { name: "@plurnk/plurnk-meta", files: ["dist/**/*", "POLICY.md", "recap.md"] },
        assets: { name: "@example/assets", files: ["assets/**/*"] },
        private: { name: "@example/private", private: true, files: ["dist/**/*"] },
    };
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: Object.keys(packages) }));
    for (const [directory, manifest] of Object.entries(packages)) {
        await mkdir(path.join(root, directory));
        await writeFile(path.join(root, directory, "package.json"), JSON.stringify(manifest));
    }
    return root;
};

test("optional type audit checks packed public code with explicit profile and asset exclusions", async (t) => {
    const root = await fixture(t);
    const calls = [];
    const count = await checkPackageTypes(root, {
        run: async (command, args, cwd) => { calls.push({ command, args, cwd }); return { code: 0, signal: null }; },
        report: () => {},
    });
    assert.equal(count, 3);
    const common = ["exec", "--yes", "--package=@arethetypeswrong/cli@0.18.5", "--", "attw", "--pack"];
    assert.deepEqual(calls, [
        { command: "npm", cwd: root, args: [...common, "code package", "--profile", "esm-only", "--format", "table", "--no-color"] },
        { command: "npm", cwd: root, args: [...common, "meta", "--profile", "esm-only", "--format", "table", "--no-color", "--exclude-entrypoints", "./POLICY.md", "./recap.md"] },
        { command: "npm", cwd: root, args: [...common, "assets", "--profile", "esm-only", "--format", "table", "--no-color"] },
    ]);
});

test("optional type audit selects an exact workspace and rejects absent or private selections", async (t) => {
    const root = await fixture(t);
    const calls = [];
    const options = { run: async (...args) => { calls.push(args); return { code: 0, signal: null }; }, report: () => {} };
    assert.equal(await checkPackageTypes(root, { ...options, only: "code package" }), 1);
    assert.equal(calls.length, 1);
    await assert.rejects(checkPackageTypes(root, { ...options, only: "../elsewhere" }), /Unknown workspace: \.\.\/elsewhere/);
    await assert.rejects(checkPackageTypes(root, { ...options, only: "private" }), /No public package selected/);
    assert.equal(calls.length, 1, "invalid selections never launch the checker");
});

test("optional type audit reports every checker failure and does not turn errors into success", async (t) => {
    const root = await fixture(t);
    let calls = 0;
    await assert.rejects(checkPackageTypes(root, {
        run: async () => ++calls === 1 ? { code: 1, signal: null } : { code: null, signal: "SIGTERM" },
        report: () => {},
    }), /code package: exit 1[\s\S]*meta: signal SIGTERM/);
    assert.equal(calls, 3, "one bad package does not hide the remaining results");
    const cause = new Error("spawn npm ENOENT");
    await assert.rejects(checkPackageTypes(root, {
        run: async () => { throw cause; }, report: () => {},
    }), (error) => error === cause);
});

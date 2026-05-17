// Tests for SPEC §9 plugin discovery.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { discoverPlugins } from "../../src/core/PluginLoader.ts";

// Helpers to build a synthetic node_modules layout
const makeTempNodeModules = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-plugin-test-"));
    await mkdir(resolve(dir, "@plurnk"), { recursive: true });
    return dir;
};

const seedPackage = async (nodeModulesDir: string, name: string, plurnk: { kind: string; name: string } | null, extra: Record<string, unknown> = {}): Promise<void> => {
    const packageDir = resolve(nodeModulesDir, "@plurnk", name);
    await mkdir(packageDir, { recursive: true });
    const packageJson: Record<string, unknown> = { name: `@plurnk/${name}`, version: "0.0.0", ...extra };
    if (plurnk !== null) packageJson.plurnk = plurnk;
    await writeFile(resolve(packageDir, "package.json"), JSON.stringify(packageJson, null, 2));
};

test("discoverPlugins returns empty array when @plurnk subdir doesn't exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-empty-"));
    try {
        const plugins = await discoverPlugins(dir);
        assert.deepEqual(plugins, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins returns empty array when @plurnk dir is empty", async () => {
    const dir = await makeTempNodeModules();
    try {
        const plugins = await discoverPlugins(dir);
        assert.deepEqual(plugins, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins finds packages with a 'plurnk' manifest field", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-schemes-fake", { kind: "scheme", name: "fake" });
        await seedPackage(dir, "plurnk-mimetypes-typescript", { kind: "mimetype", name: "application/typescript" });
        const plugins = await discoverPlugins(dir);
        assert.equal(plugins.length, 2);
        const names = plugins.map((p) => p.packageName);
        // Alphabetical
        assert.deepEqual(names, ["@plurnk/plurnk-mimetypes-typescript", "@plurnk/plurnk-schemes-fake"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins extracts manifest fields", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-schemes-fake", { kind: "scheme", name: "fake" });
        const plugins = await discoverPlugins(dir);
        assert.equal(plugins[0].manifest.kind, "scheme");
        assert.equal(plugins[0].manifest.name, "fake");
        assert.match(plugins[0].packagePath, /plurnk-schemes-fake$/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins skips packages without a 'plurnk' field", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-utility", null);
        await seedPackage(dir, "plurnk-schemes-real", { kind: "scheme", name: "real" });
        const plugins = await discoverPlugins(dir);
        assert.equal(plugins.length, 1);
        assert.equal(plugins[0].packageName, "@plurnk/plurnk-schemes-real");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins skips packages with invalid kind", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-bad", { kind: "not-a-kind" as "scheme", name: "x" });
        await seedPackage(dir, "plurnk-good", { kind: "scheme", name: "x" });
        const plugins = await discoverPlugins(dir);
        assert.equal(plugins.length, 1);
        assert.equal(plugins[0].packageName, "@plurnk/plurnk-good");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins skips packages with missing name in manifest", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-incomplete", { kind: "scheme" } as { kind: "scheme"; name: string });
        const plugins = await discoverPlugins(dir);
        assert.deepEqual(plugins, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins accepts all three valid kinds: provider, scheme, mimetype", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-providers-fake", { kind: "provider", name: "fake" });
        await seedPackage(dir, "plurnk-schemes-fake", { kind: "scheme", name: "fake" });
        await seedPackage(dir, "plurnk-mimetypes-fake", { kind: "mimetype", name: "text/fake" });
        const plugins = await discoverPlugins(dir);
        assert.equal(plugins.length, 3);
        const kinds = plugins.map((p) => p.manifest.kind).toSorted();
        assert.deepEqual(kinds, ["mimetype", "provider", "scheme"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins skips packages with unparseable package.json", async () => {
    const dir = await makeTempNodeModules();
    try {
        const badDir = resolve(dir, "@plurnk", "plurnk-bad");
        await mkdir(badDir, { recursive: true });
        await writeFile(resolve(badDir, "package.json"), "not valid json {{");
        await seedPackage(dir, "plurnk-good", { kind: "scheme", name: "good" });
        const plugins = await discoverPlugins(dir);
        assert.equal(plugins.length, 1);
        assert.equal(plugins[0].packageName, "@plurnk/plurnk-good");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

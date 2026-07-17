// Tests for SPEC §plugin-discovery plugin discovery.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import PluginLoader from "../../src/core/PluginLoader.ts";
import type { DiscoveredPlugin } from "../../src/core/PluginLoader.ts";

const fakePlugin = (kind: "mimetype" | "scheme" | "provider", name: string): DiscoveredPlugin => ({
    packageName: `@plurnk/plurnk-${kind}s-${name.replace(/\//g, "-")}`,
    packagePath: `/tmp/fake/${name}`,
    manifest: { kind, name },
});

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
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.deepEqual(plugins, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins returns empty array when @plurnk dir is empty", async () => {
    const dir = await makeTempNodeModules();
    try {
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.deepEqual(plugins, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins finds packages with a 'plurnk' manifest field", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-schemes-fake", { kind: "scheme", name: "fake" });
        await seedPackage(dir, "plurnk-mimetypes-typescript", { kind: "mimetype", name: "application/typescript" });
        const plugins = await PluginLoader.discoverPlugins(dir);
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
        const plugins = await PluginLoader.discoverPlugins(dir);
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
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.equal(plugins.length, 1);
        assert.equal(plugins[0].packageName, "@plurnk/plurnk-schemes-real");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins skips packages with invalid kind", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-bad", { kind: "not-a-kind" as "scheme", name: "x" });
        await seedPackage(dir, "plurnk-good", { kind: "scheme", name: "x" });
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.equal(plugins.length, 1);
        assert.equal(plugins[0].packageName, "@plurnk/plurnk-good");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins skips packages with missing name in manifest", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-incomplete", { kind: "scheme" } as { kind: "scheme"; name: string });
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.deepEqual(plugins, []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("discoverPlugins accepts all three valid kinds: provider, scheme, mimetype", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-providers-fake", { kind: "provider", name: "fake" });
        await seedPackage(dir, "plurnk-schemes-fake", { kind: "scheme", name: "fake" });
        await seedPackage(dir, "plurnk-mimetypes-fake", { kind: "mimetype", name: "text/fake" });
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.equal(plugins.length, 3);
        const kinds = plugins.map((p) => p.manifest.kind).toSorted();
        assert.deepEqual(kinds, ["mimetype", "provider", "scheme"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("assertIdentityMatch: mimetype instance.mimetype must match manifest.name", () => {
    const plugin = fakePlugin("mimetype", "text/markdown");
    PluginLoader.assertIdentityMatch(plugin, { mimetype: "text/markdown" });  // ok
    assert.throws(
        () => PluginLoader.assertIdentityMatch(plugin, { mimetype: "text/plain" }),
        /identity mismatch.*text\/markdown.*text\/plain/,
    );
});

test("assertIdentityMatch: mimetype instance without mimetype field rejected", () => {
    const plugin = fakePlugin("mimetype", "text/markdown");
    assert.throws(
        () => PluginLoader.assertIdentityMatch(plugin, {}),
        /must declare a string `mimetype` field/,
    );
});

test("assertIdentityMatch: scheme class manifest.name must match manifest.name when present", () => {
    const plugin = fakePlugin("scheme", "known");
    class GoodScheme { static manifest = { name: "known" }; }
    class BadScheme { static manifest = { name: "wrong" }; }
    class NoManifestScheme {}  // transitional — bundled schemes don't have static manifest yet
    PluginLoader.assertIdentityMatch(plugin, new GoodScheme());  // ok
    PluginLoader.assertIdentityMatch(plugin, new NoManifestScheme());  // ok (transitional)
    assert.throws(
        () => PluginLoader.assertIdentityMatch(plugin, new BadScheme()),
        /identity mismatch.*known.*wrong/,
    );
});

test("assertIdentityMatch: providers skip identity check (vendor name vs model identity separation)", () => {
    const plugin = fakePlugin("provider", "openai");
    // Providers don't carry a top-level identity matching manifest.name; model is per-config.
    PluginLoader.assertIdentityMatch(plugin, { model: "gpt-5" });  // no throw
    PluginLoader.assertIdentityMatch(plugin, {});  // no throw even with empty instance
});

test("discoverPlugins skips packages with unparseable package.json", async () => {
    const dir = await makeTempNodeModules();
    try {
        const badDir = resolve(dir, "@plurnk", "plurnk-bad");
        await mkdir(badDir, { recursive: true });
        await writeFile(resolve(badDir, "package.json"), "not valid json {{");
        await seedPackage(dir, "plurnk-good", { kind: "scheme", name: "good" });
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.equal(plugins.length, 1);
        assert.equal(plugins[0].packageName, "@plurnk/plurnk-good");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

// #514 — the stepchild covenant: plurnk.builtAgainst verified BEFORE import. A skewed artifact
// refuses LEGIBLY naming both versions (never #512's mid-import SyntaxError on a removed export);
// an absent field is a legacy artifact — warn once, proceed.
test("[§plugin-built-against] a version-skewed stepchild refuses legibly BEFORE import — both versions named (#514)", async () => {
    const head = await PluginLoader.headVersion();
    const skewed: DiscoveredPlugin = {
        packageName: "@plurnk/plurnk-providers-nonexistent-skewed",  // unimportable — the throw MUST precede import
        packagePath: "/tmp/fake/skewed",
        manifest: { kind: "provider", name: "skewed", builtAgainst: "1.0.5" },
    };
    await assert.rejects(
        () => PluginLoader.loadPlugin(skewed),
        (e: Error) => {
            assert.match(e.message, /built against 1\.0\.5; loaded /, "the skew names the artifact's version");
            assert.ok(e.message.includes(head), "the skew names the loaded head");
            assert.match(e.message, /republish pending/, "the cure is stated");
            assert.doesNotMatch(e.message, /Cannot find|does not provide an export/, "refused BEFORE import — never the #512 detonation");
            return true;
        },
    );
});

test("[§plugin-built-against] an absent builtAgainst is a legacy artifact — one warning, load proceeds to the import (#514)", async () => {
    const logged: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string | Uint8Array) => { logged.push(String(s)); return realWrite(s); };
    try {
        const legacy: DiscoveredPlugin = {
            packageName: "@plurnk/plurnk-providers-nonexistent-legacy",
            packagePath: "/tmp/fake/legacy",
            manifest: { kind: "provider", name: "legacy" },  // no builtAgainst
        };
        // Proceeds PAST the covenant check to the import (which fails on the fake package —
        // an import-shaped error here proves the boundary let the legacy artifact through).
        await assert.rejects(() => PluginLoader.loadPlugin(legacy), /Cannot find|Failed to load|not found/i);
        await assert.rejects(() => PluginLoader.loadPlugin(legacy), /Cannot find|Failed to load|not found/i);
        assert.equal(logged.filter((l) => l.includes("declares no plurnk.builtAgainst")).length, 1, "warned exactly ONCE across repeat loads");
    } finally { (process.stderr as { write: unknown }).write = realWrite; }
});

test("[§plugin-built-against] discoverPlugins extracts builtAgainst from the manifest (#514)", async () => {
    const dir = await makeTempNodeModules();
    try {
        await seedPackage(dir, "plurnk-providers-stamped", { kind: "provider", name: "stamped", builtAgainst: "1.0.7" } as never);
        const plugins = await PluginLoader.discoverPlugins(dir);
        assert.equal(plugins.length, 1);
        assert.equal(plugins[0].manifest.builtAgainst, "1.0.7", "the covenant field rides discovery");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

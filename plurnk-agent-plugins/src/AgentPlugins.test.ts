import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPlaceholders, schemaVersion } from "@plurnk/plurnk-meta/agent-plugin";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import PluginDirectory from "./PluginDirectory.ts";
import PluginRoots from "./PluginRoots.ts";

// ─── AgentPlugins.test.ts ───
{
test("{§agent-plugins-expansion} both placeholders expand at every occurrence", () => {
    assert.equal(
        expandPlaceholders("${PLUGIN_ROOT}/bin:${PLUGIN_DATA}/cache:${PLUGIN_ROOT}", { root: "/plugins/p", data: "/data/p" }),
        "/plugins/p/bin:/data/p/cache:/plugins/p",
    );
});

test("{§agent-plugins-expansion} text a replacement introduces is never scanned again", () => {
    assert.equal(expandPlaceholders("${PLUGIN_ROOT}", { root: "/odd/${PLUGIN_DATA}", data: "/data" }), "/odd/${PLUGIN_DATA}");
});

test("{§agent-plugins-expansion} any other placeholder stays literal", () => {
    assert.equal(expandPlaceholders("${HOME}/${PLUGIN_ROOTS}/$PLUGIN_ROOT/${plugin_root}", { root: "/r", data: "/d" }), "${HOME}/${PLUGIN_ROOTS}/$PLUGIN_ROOT/${plugin_root}");
});

test("{§agent-plugins-roots} a canonical identifier names its version; nothing else does", () => {
    assert.equal(schemaVersion("https://agent-plugins.org/schemas/1.1.0/plugin.schema.json", "plugin"), "1.1.0");
    assert.equal(schemaVersion("https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", "plugin"), null);
    assert.equal(schemaVersion("https://example.com/schemas/1.0.0/plugin.schema.json", "plugin"), null);
});
}

// ─── PluginDirectory.test.ts ───
{
interface ExpectedReport {
    readonly path: string;
    readonly section: string;
    readonly outcome: string;
}

interface Expected {
    readonly section: string;
    readonly requirement: string;
    readonly plugin: "accepted" | "rejected";
    readonly skills?: readonly string[];
    readonly mcpServers?: readonly string[] | null;
    readonly reports: readonly ExpectedReport[];
}

const CORPUS = fileURLToPath(new URL("../test/conformance/", import.meta.url));
const key = ({ path, section, outcome }: ExpectedReport): string => `${path}\u0000${section}\u0000${outcome}`;
const cases = (await readdir(CORPUS, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted();

test("{§agent-plugins-expansion} the corpus holds one case per normative requirement", () => {
    assert.ok(cases.length >= 50, `expected the full corpus, found ${cases.length} cases`);
});

for (const name of cases) {
    const expected = JSON.parse(await readFile(join(CORPUS, name, "expected.json"), "utf8")) as Expected;
    test(`{§agent-plugins-expansion} §${expected.section} ${name}: ${expected.requirement}`, async () => {
        const { plugin, reports } = await PluginDirectory.load(join(CORPUS, name, "plugin"));
        assert.equal(plugin === null ? "rejected" : "accepted", expected.plugin);
        if (plugin !== null) {
            assert.deepEqual(plugin.skills.map((skill) => skill.document.name).toSorted(), expected.skills);
            assert.deepEqual(plugin.mcpServers === null ? null : [...plugin.mcpServers.keys()].toSorted(), expected.mcpServers);
        }
        assert.deepEqual(reports.map(key).toSorted(), expected.reports.map(key).toSorted());
    });
}

test("{§agent-plugins-expansion} every report names its plugin directory and says what happened", async () => {
    const directory = join(CORPUS, "manifest-unknown-field", "plugin");
    const { reports } = await PluginDirectory.load(directory);
    assert.deepEqual(reports, [{
        root: directory, path: "plugin.json", section: "5.2", outcome: "ignored",
        message: "unknown top-level field \"displayName\" is ignored",
    }]);
});

test("{§agent-plugins-roots} unknown fields never survive validation", async () => {
    const { plugin } = await PluginDirectory.load(join(CORPUS, "manifest-unknown-field", "plugin"));
    assert.deepEqual(plugin?.manifest, { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "unknown-field" });
});

test("{§agent-plugins-roots} a non-object extensions field is dropped, not kept", async () => {
    const { plugin } = await PluginDirectory.load(join(CORPUS, "manifest-extensions-not-object", "plugin"));
    assert.equal(plugin?.manifest.extensions, undefined);
    assert.equal(plugin?.manifest.name, "extensions-string");
});

test("{§agent-plugins-roots} a directory that does not exist is rejected with a report", async () => {
    const directory = join(CORPUS, "no-such-case");
    const { plugin, reports } = await PluginDirectory.load(directory);
    assert.equal(plugin, null);
    assert.deepEqual(reports.map(({ path, section, outcome }) => ({ path, section, outcome })), [{ path: "", section: "11.1", outcome: "rejected" }]);
});

test("{§agent-plugins-containment} unreadable component paths preserve other components", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "agent-plugin-component-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "plugin.json"), JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "fixture",
    }));
    await mkdir(join(directory, "skills", "usable"), { recursive: true });
    await writeFile(join(directory, "skills", "usable", "SKILL.md"), "---\nname: usable\ndescription: A usable skill.\n---\nUse this.\n");
    await symlink("mcp.json", join(directory, "mcp.json"));
    const { plugin, reports } = await PluginDirectory.load(directory);
    assert.deepEqual(plugin?.skills.map(({ document }) => document.name), ["usable"]);
    assert.equal(plugin.mcpServers, null);
    assert.deepEqual(reports.map(({ path, outcome }) => ({ path, outcome })), [{ path: "mcp.json", outcome: "invalid" }]);
    assert.match(reports[0].message, /ELOOP/);
});
}

// ─── PluginRoots.test.ts ───
{
const manifest = (name: string): string => JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name });

const plugin = async (root: string, directory: string, name: string): Promise<void> => {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "plugin.json"), manifest(name));
};

test("{§agent-plugins-roots} earlier roots shadow later ones by manifest name, whatever the directory is called", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "agent-plugins-roots-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const project = join(base, "project");
    const global = join(base, "global");
    await plugin(project, "zeta", "shared");
    await plugin(project, "alpha", "only-project");
    await plugin(global, "shared", "shared");
    await plugin(global, "beta", "only-global");
    const { plugins, reports } = await PluginRoots.discover([{ scope: "project", directory: project }, { scope: "global", directory: global }]);
    assert.deepEqual(plugins.map((entry) => `${entry.scope}:${entry.manifest.name}`), ["project:only-project", "project:shared", "global:only-global"]);
    assert.deepEqual(reports.map(({ root, section, outcome }) => ({ root, section, outcome })), [{ root: join(global, "shared"), section: "client", outcome: "shadowed" }]);
});

test("{§agent-plugins-roots} within one root the first directory in code-point order wins", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "agent-plugins-roots-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    await plugin(base, "b-copy", "twin");
    await plugin(base, "a-original", "twin");
    const { plugins, reports } = await PluginRoots.discover([{ scope: "global", directory: base }]);
    assert.deepEqual(plugins.map(({ root }) => root.endsWith("a-original")), [true]);
    assert.deepEqual(reports.map(({ root, outcome }) => ({ root, outcome })), [{ root: join(base, "b-copy"), outcome: "shadowed" }]);
});

test("{§agent-plugins-roots} explicit installed directories follow roots in the same identity cascade", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "agent-plugins-roots-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const user = join(base, "user");
    const npm = join(base, "node_modules");
    await plugin(user, "replacement", "shared");
    await plugin(npm, "published", "shared");
    await plugin(npm, "other", "npm-only");
    const { plugins, reports } = await PluginRoots.discover([{ scope: "global", directory: user }], [
        { scope: "npm", directory: join(npm, "published") },
        { scope: "npm", directory: join(npm, "other") },
    ]);
    assert.deepEqual(plugins.map((entry) => [entry.scope, entry.manifest.name]), [["global", "shared"], ["npm", "npm-only"]]);
    assert.deepEqual(reports.map(({ outcome }) => outcome), ["shadowed"]);
});

test("{§agent-plugins-roots} files, dot-entries, and missing roots hold no plugins; a plain directory is reported", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "agent-plugins-roots-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    await plugin(base, "real", "real");
    await writeFile(join(base, "marketplace.json"), "{}");
    await mkdir(join(base, ".cache"));
    await mkdir(join(base, "data"));
    const { plugins, reports } = await PluginRoots.discover([{ scope: "global", directory: base }, { scope: "absent", directory: join(base, "missing") }]);
    assert.deepEqual(plugins.map((entry) => entry.manifest.name), ["real"]);
    assert.deepEqual(reports.map(({ root, path, section, outcome }) => ({ root, path, section, outcome })), [
        { root: join(base, "data"), path: "plugin.json", section: "5.1", outcome: "rejected" },
    ]);
});

test("{§agent-plugins-roots} unreadable roots and candidates are reported without losing healthy siblings", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "agent-plugins-roots-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const invalidRoot = join(base, "invalid");
    const validRoot = join(base, "valid");
    await writeFile(invalidRoot, "not a directory");
    await plugin(validRoot, "healthy", "healthy");
    await symlink("loop", join(validRoot, "loop"));
    const { plugins, reports } = await PluginRoots.discover([
        { scope: "project", directory: invalidRoot }, { scope: "global", directory: validRoot },
    ]);
    assert.deepEqual(plugins.map((entry) => entry.manifest.name), ["healthy"]);
    assert.deepEqual(reports.map(({ root, outcome }) => ({ root, outcome })), [
        { root: invalidRoot, outcome: "rejected" },
        { root: join(validRoot, "loop"), outcome: "rejected" },
    ]);
    assert.match(reports[0].message, /ENOTDIR/);
    assert.match(reports[1].message, /ELOOP/);
});
}

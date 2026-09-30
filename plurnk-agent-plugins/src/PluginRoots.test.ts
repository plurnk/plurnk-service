import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PluginRoots from "./PluginRoots.ts";

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
    assert.deepEqual(plugins.map(({ scope, manifest }) => `${scope}:${manifest.name}`), ["project:only-project", "project:shared", "global:only-global"]);
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

test("{§agent-plugins-roots} files, dot-entries, and missing roots hold no plugins; a plain directory is reported", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "agent-plugins-roots-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    await plugin(base, "real", "real");
    await writeFile(join(base, "marketplace.json"), "{}");
    await mkdir(join(base, ".cache"));
    await mkdir(join(base, "data"));
    const { plugins, reports } = await PluginRoots.discover([{ scope: "global", directory: base }, { scope: "absent", directory: join(base, "missing") }]);
    assert.deepEqual(plugins.map(({ manifest }) => manifest.name), ["real"]);
    assert.deepEqual(reports.map(({ root, path, section, outcome }) => ({ root, path, section, outcome })), [
        { root: join(base, "data"), path: "plugin.json", section: "5.1", outcome: "rejected" },
    ]);
});

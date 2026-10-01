// {§agent-roots} {§agent-plugins-hosting} Read-only plugin source discovery.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../core/Db.ts";
import HostPaths from "../core/HostPaths.ts";
import { agentRootScopes } from "./AgentRoots.ts";
import WorkspacePlugins from "./WorkspacePlugins.ts";

const withRoots = (t: TestContext, value: string): void => {
    const previous = process.env.PLURNK_SERVICE_ROOTS;
    process.env.PLURNK_SERVICE_ROOTS = value;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_ROOTS;
        else process.env.PLURNK_SERVICE_ROOTS = previous;
    });
};

const plugins = async (t: TestContext, projectRoot: string | null): Promise<{ plugins: WorkspacePlugins; hostPaths: HostPaths }> => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-workspace-plugins-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home, env: {} });
    const db = { envelope_get_workspace: { get: async () => ({ project_root: projectRoot }) } } as unknown as Db;
    return { plugins: new WorkspacePlugins({ db, hostPaths }), hostPaths };
};

test("{§agent-roots} the roots knob is a comma list of project, plurnk and global, and anything else fails by name", (t) => {
    withRoots(t, "project, global");
    assert.deepEqual([...agentRootScopes()], ["project", "global"]);
    withRoots(t, "");
    assert.deepEqual([...agentRootScopes()], []);
    withRoots(t, "project,home");
    assert.throws(() => agentRootScopes(), /PLURNK_SERVICE_ROOTS names 'home'; each root is one of project, plurnk, global/u);
});

test("{§agent-roots} a daemon reads only the roots the knob names", async (t) => {
    withRoots(t, "project");
    const project = await mkdtemp(join(tmpdir(), "plurnk-workspace-project-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    const { plugins: reader, hostPaths } = await plugins(t, project);
    const read = await reader.read(1);
    assert.deepEqual(read.roots, { project: hostPaths.projectPluginsDir(project), plurnk: null, global: null });
});

test("{§agent-plugins-hosting} data belongs to a canonical installed instance, not merely a plugin name", async (t) => {
    withRoots(t, "project");
    const root = await mkdtemp(join(tmpdir(), "plurnk-plugin-data-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hostPaths = new HostPaths({ home: join(root, "home"), env: {} });
    const projects = [join(root, "a"), join(root, "b"), join(root, "c")];
    for (const project of projects) await mkdir(hostPaths.projectPluginsDir(project), { recursive: true });
    const manifest = { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "shared" };
    for (const project of projects.slice(0, 2)) {
        const directory = join(hostPaths.projectPluginsDir(project), "shared");
        await mkdir(directory);
        await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
    }
    await symlink(join(hostPaths.projectPluginsDir(projects[0]!), "shared"), join(hostPaths.projectPluginsDir(projects[2]!), "shared"));
    const db = { envelope_get_workspace: { get: async ({ id }: { id: number }) => ({ project_root: projects[id] }) } } as unknown as Db;
    const reader = new WorkspacePlugins({ db, hostPaths });
    const a = (await reader.read(0)).plugins[0]!;
    const b = (await reader.read(1)).plugins[0]!;
    const c = (await reader.read(2)).plugins[0]!;
    assert.notEqual(a.data, b.data, "distinct installations cannot share data by manifest name alone");
    assert.equal(a.data, c.data, "two workspaces referencing the same installation share its data");
    await writeFile(join(a.root, "plugin.json"), JSON.stringify({ ...manifest, version: "2.0.0" }));
    assert.equal((await reader.read(0)).plugins[0]!.data, a.data, "updates retain the installation's data");
    await writeFile(join(a.root, "plugin.json"), "invalid-json");
    await reader.read(0);
    assert.ok(reader.notices(0).some(({ level, message }) => level === "warn" && message?.includes("plugin.json")));
    await writeFile(join(a.root, "plugin.json"), JSON.stringify(manifest));
    await reader.read(0);
    assert.deepEqual(reader.notices(0), [], "repaired configuration does not keep an obsolete workspace warning");
});

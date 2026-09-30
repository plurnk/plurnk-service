// {§agent-roots} {§agent-plugins-hosting} Read-only plugin source discovery.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

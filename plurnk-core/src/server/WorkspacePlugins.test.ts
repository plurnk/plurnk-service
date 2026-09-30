// {§agent-roots} {§agent-plugins-hosting} {§mcp-plugin-servers} — the roots a daemon reads, and the one
// plugin Core writes: an added MCP server's.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SCHEMA, PLUGIN_SCHEMA } from "@plurnk/plurnk-agent-plugins";
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

test("{§mcp-plugin-servers} an added server's plugin is written once, reused as the same plugin, never written over another, and deleted", async (t) => {
    withRoots(t, "project,plurnk,global");
    const { plugins: writer, hostPaths } = await plugins(t, null);
    const entry = { type: "stdio", command: "npx", args: ["-y", "example-mcp-server@1.0.0"] } as const;
    const first = await writer.writeServer(1, { scope: "plurnk", name: "example", entry });
    assert.equal(first.kind, "written");
    assert.equal(first.kind === "written" && first.created, true);
    const directory = join(hostPaths.plurnkPluginsDir, "example");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "plugin.json"), "utf8")), { $schema: PLUGIN_SCHEMA, name: "example" });
    assert.deepEqual(JSON.parse(await readFile(join(directory, "mcp.json"), "utf8")), { $schema: MCP_SCHEMA, mcpServers: { example: entry } });
    const again = await writer.writeServer(1, { scope: "plurnk", name: "example", entry });
    assert.equal(again.kind === "written" && again.created, false, "exactly that plugin already in place is the same write");
    assert.deepEqual(await writer.writeServer(1, { scope: "plurnk", name: "example", entry: { ...entry, args: ["other"] } }),
        { kind: "occupied", directory }, "a different declaration is never written over");
    assert.deepEqual(await writer.writeServer(1, { scope: "project", name: "example", entry }), { kind: "unrooted" }, "a workspace without a project has no project root");
    await writer.deleteServer(1, { scope: "plurnk", name: "example" });
    assert.equal(existsSync(directory), false);
});

test("{§mcp-plugin-servers} a directory that is not a plugin at the server's name is occupied", async (t) => {
    withRoots(t, "project,plurnk,global");
    const { plugins: writer, hostPaths } = await plugins(t, null);
    const directory = join(hostPaths.globalPluginsDir, "example");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "notes.txt"), "not a plugin");
    assert.deepEqual(await writer.writeServer(1, { scope: "global", name: "example", entry: { type: "stdio", command: "npx" } }), { kind: "occupied", directory });
    assert.equal(await readFile(join(directory, "notes.txt"), "utf8"), "not a plugin");
});

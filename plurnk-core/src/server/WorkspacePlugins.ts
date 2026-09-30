// {§agent-plugins-hosting} — a workspace's installed Agent Plugins: the project, plurnk and global
// roots this daemon reads ({§agent-roots}) in precedence order, each plugin with the PLUGIN_DATA
// directory its subprocesses receive; and the one-server plugins the workspace's own MCP servers are.
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    MCP_SCHEMA,
    PLUGIN_SCHEMA,
    PluginDirectory,
    PluginRoots,
    type DiscoveredPlugin,
    type McpServerEntry,
    type PluginReport,
} from "@plurnk/plurnk-agent-plugins";
import type { Db } from "../core/Db.ts";
import HostPaths from "../core/HostPaths.ts";
import { AGENT_ROOT_SCOPES, agentRootScopes, type AgentRootScope } from "./AgentRoots.ts";

export interface InstalledPlugin extends DiscoveredPlugin {
    // PLUGIN_DATA: a consumer creates it before launching one of the plugin's subprocesses.
    readonly data: string;
}

export interface WorkspacePluginSet {
    readonly plugins: readonly InstalledPlugin[];
    readonly reports: readonly PluginReport[];
    // Changes exactly when a plugin, its manifest, its MCP configuration or its skills change.
    readonly signature: string;
    // Each root this daemon reads for the workspace; null where it reads none: the workspace has no
    // project, or the root is not among {§agent-roots}.
    readonly roots: Readonly<Record<AgentRootScope, string | null>>;
}

// {§mcp-plugin-servers} — writing the one-server plugin an added server is.
export type ServerPluginWrite =
    | { readonly kind: "written"; readonly root: string; readonly data: string; readonly created: boolean }
    | { readonly kind: "occupied"; readonly directory: string }
    | { readonly kind: "unrooted" };

export default class WorkspacePlugins {
    readonly #db: Db;
    readonly #hostPaths: HostPaths;

    constructor({ db, hostPaths }: { readonly db: Db; readonly hostPaths: HostPaths }) {
        this.#db = db;
        this.#hostPaths = hostPaths;
    }

    async #roots(workspaceId: number): Promise<Record<AgentRootScope, string | null>> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const projectRoot = workspace?.project_root ?? null;
        const read = agentRootScopes();
        const directory = (scope: AgentRootScope): string | null => {
            if (!read.has(scope)) return null;
            if (scope === "global") return this.#hostPaths.globalPluginsDir;
            if (scope === "plurnk") return this.#hostPaths.plurnkPluginsDir;
            return projectRoot === null ? null : this.#hostPaths.projectPluginsDir(projectRoot);
        };
        return { project: directory("project"), plurnk: directory("plurnk"), global: directory("global") };
    }

    async read(workspaceId: number): Promise<WorkspacePluginSet> {
        const roots = await this.#roots(workspaceId);
        const { plugins, reports } = await PluginRoots.discover(AGENT_ROOT_SCOPES.flatMap((scope) => {
            const directory = roots[scope];
            return directory === null ? [] : [{ scope, directory }];
        }));
        const installed = plugins.map((plugin): InstalledPlugin => ({ ...plugin, data: this.#hostPaths.pluginDataDir(plugin.manifest.name) }));
        const signature = createHash("sha256").update(JSON.stringify(installed.map((plugin) => [
            plugin.scope,
            plugin.root,
            plugin.manifest,
            plugin.mcpServers === null ? null : [...plugin.mcpServers],
            plugin.skills.map((skill) => [skill.directory, skill.document.source]),
        ]))).digest("hex");
        return { plugins: installed, reports, signature, roots };
    }

    // The plugin is named for its one server and declares nothing else; finding exactly that plugin
    // already in place is the same write.
    async writeServer(
        workspaceId: number,
        { scope, name, entry }: { readonly scope: AgentRootScope; readonly name: string; readonly entry: McpServerEntry },
    ): Promise<ServerPluginWrite> {
        const root = (await this.#roots(workspaceId))[scope];
        if (root === null) return { kind: "unrooted" };
        const directory = join(root, name);
        const data = this.#hostPaths.pluginDataDir(name);
        const present = await lstat(directory).then(() => true, (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return false;
            throw cause;
        });
        if (present) {
            const { plugin } = await PluginDirectory.load(directory);
            const same = plugin !== null && plugin.manifest.name === name && plugin.mcpServers?.size === 1
                && isDeepStrictEqual(plugin.mcpServers.get(name), entry);
            return same ? { kind: "written", root: plugin.root, data, created: false } : { kind: "occupied", directory };
        }
        // {§host-path-layout} — a configuration directory plurnk creates is private.
        await mkdir(directory, { recursive: true, ...(scope === "plurnk" ? { mode: 0o700 } : {}) });
        await writeFile(join(directory, "plugin.json"), `${JSON.stringify({ $schema: PLUGIN_SCHEMA, name }, null, 4)}\n`);
        await writeFile(join(directory, "mcp.json"), `${JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: { [name]: entry } }, null, 4)}\n`);
        return { kind: "written", root: await realpath(directory), data, created: true };
    }

    async deleteServer(workspaceId: number, { scope, name }: { readonly scope: AgentRootScope; readonly name: string }): Promise<void> {
        const root = (await this.#roots(workspaceId))[scope];
        if (root === null) return;
        await rm(join(root, name), { recursive: true, force: true });
    }
}

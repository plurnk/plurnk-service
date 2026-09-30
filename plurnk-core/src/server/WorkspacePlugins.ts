// {§agent-plugins-hosting} — a workspace's installed Agent Plugins: the project, plurnk and global
// roots this daemon reads ({§agent-roots}) in precedence order, each plugin with the PLUGIN_DATA
// directory its subprocesses receive.
import { createHash } from "node:crypto";
import {
    PluginRoots,
    type DiscoveredPlugin,
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

}

// {§agent-plugins-hosting} — a workspace's installed Agent Plugins: the project, plurnk and global
// roots this daemon reads ({§agent-roots}) in precedence order, each plugin with the PLUGIN_DATA
// directory its subprocesses receive.
import { createHash } from "node:crypto";
import type { InstalledPlugin, WorkspacePluginSet } from "@plurnk/plurnk-agent-plugins";
import type { Db } from "../core/Db.ts";
import HostPaths from "../core/HostPaths.ts";
import type { AgentRootScope } from "./AgentRoots.ts";
import PluginSources from "./PluginSources.ts";
import { join } from "node:path";
import type { Notice } from "@plurnk/plurnk-contracts";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";

export default class WorkspacePlugins {
    readonly #db: Db;
    readonly #hostPaths: HostPaths;
    readonly #nodeModules: string;
    readonly #notices = new Map<number, readonly Notice[]>();

    constructor({ db, hostPaths, nodeModules = join(process.cwd(), "node_modules") }: {
        readonly db: Db; readonly hostPaths: HostPaths; readonly nodeModules?: string;
    }) {
        this.#db = db;
        this.#hostPaths = hostPaths;
        this.#nodeModules = nodeModules;
    }

    async read(workspaceId: number): Promise<WorkspacePluginSet<AgentRootScope>> {
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const projectRoot = workspace?.project_root ?? null;
        const { plugins, reports, roots, configurationErrors } = await PluginSources.read({
            hostPaths: this.#hostPaths, projectRoot, nodeModules: this.#nodeModules,
        });
        const diagnostics = new ConfigurationDiagnostics();
        diagnostics.pluginReports(reports);
        for (const error of configurationErrors) diagnostics.record("plugins", error);
        this.#notices.set(workspaceId, diagnostics.notices());
        const installed = plugins.map((plugin): InstalledPlugin => ({ ...plugin, data: this.#hostPaths.pluginDataDir(plugin.manifest.name, plugin.root) }));
        const signature = createHash("sha256").update(JSON.stringify(installed.map((plugin) => [
            plugin.scope,
            plugin.root,
            plugin.manifest,
            plugin.mcpServers === null ? null : [...plugin.mcpServers],
            plugin.skills.map((skill) => [skill.directory, skill.document.source]),
        ]))).digest("hex");
        return { plugins: installed, reports, signature, roots };
    }

    notices(workspaceId: number): readonly Notice[] {
        return this.#notices.get(workspaceId) ?? [];
    }

}

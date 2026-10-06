// {§plugin-set-module-slice} — what a daemon module reads from the host's plugin hosting: a
// workspace's installed Agent Plugins. The base module contract is `@plurnk/plurnk-modules`
// ({§module-seam-slices}).
import type { DiscoveredPlugin } from "./PluginRoots.ts";
import type { PluginReport } from "./PluginReport.ts";

export interface InstalledPlugin extends DiscoveredPlugin {
    // PLUGIN_DATA: a consumer creates it before launching one of the plugin's subprocesses.
    readonly data: string;
}

// A workspace's plugins in root precedence order. `Scope` names the roots the host reads; this
// package treats a root scope as opaque, as discovery does.
export interface WorkspacePluginSet<Scope extends string = string> {
    readonly plugins: readonly InstalledPlugin[];
    readonly reports: readonly PluginReport[];
    // Changes exactly when a plugin, its manifest, its MCP configuration or its skills change.
    readonly signature: string;
    // Each root the host reads for the workspace; null where it reads none.
    readonly roots: Readonly<Record<Scope, string | null>>;
}

// The setup slice a module uses to read a workspace's installed plugins.
export interface WorkspacePluginsSeam<Scope extends string = string> {
    readWorkspacePlugins(workspaceId: number): Promise<WorkspacePluginSet<Scope>>;
}

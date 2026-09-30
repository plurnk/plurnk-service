import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import PluginDirectory, { type AgentPlugin } from "./PluginDirectory.ts";
import type { PluginReport } from "./PluginReport.ts";

export interface PluginRoot {
    readonly scope: string;
    readonly directory: string;
}

export interface DiscoveredPlugin extends AgentPlugin {
    readonly scope: string;
}

export interface PluginDiscovery {
    readonly plugins: readonly DiscoveredPlugin[];
    readonly reports: readonly PluginReport[];
}

const missing = (cause: unknown): boolean => (cause as NodeJS.ErrnoException).code === "ENOENT";

// A dangling link is not a directory; any other failure surfaces.
const isDirectory = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isDirectory();
    } catch (cause) {
        if (missing(cause)) return false;
        throw cause;
    }
};

// {§agent-plugins-roots} A missing root holds no plugins; files and dot-entries are not candidates.
const directories = async (directory: string): Promise<string[]> => {
    let names: string[];
    try {
        names = (await readdir(directory)).filter((name) => !name.startsWith(".")).toSorted();
    } catch (cause) {
        if (missing(cause)) return [];
        throw cause;
    }
    const kinds = await Promise.all(names.map((name) => isDirectory(join(directory, name))));
    return names.filter((_name, index) => kinds[index]);
};

// {§agent-plugins-roots} Earlier roots win; within a root, directory names in code-point order decide.
export default class PluginRoots {
    static async discover(roots: readonly PluginRoot[]): Promise<PluginDiscovery> {
        const plugins: DiscoveredPlugin[] = [];
        const reports: PluginReport[] = [];
        const owners = new Map<string, DiscoveredPlugin>();
        for (const { scope, directory } of roots) {
            for (const name of await directories(directory)) {
                const load = await PluginDirectory.load(join(directory, name));
                reports.push(...load.reports);
                if (load.plugin === null) continue;
                const owner = owners.get(load.plugin.manifest.name);
                if (owner !== undefined) {
                    reports.push({
                        root: join(directory, name), path: "", section: "client", outcome: "shadowed",
                        message: `plugin ${load.plugin.manifest.name} is shadowed by ${owner.root} (${owner.scope})`,
                    });
                    continue;
                }
                const plugin = { ...load.plugin, scope };
                owners.set(plugin.manifest.name, plugin);
                plugins.push(plugin);
            }
        }
        return { plugins, reports };
    }
}

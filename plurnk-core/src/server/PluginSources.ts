import { lstat } from "node:fs/promises";
import { join } from "node:path";
import Meta, { ConfigurationError, type PackageCandidate } from "@plurnk/plurnk-meta";
import { PluginRoots, type PluginDiscovery } from "@plurnk/plurnk-agent-plugins";
import HostPaths from "../core/HostPaths.ts";
import { AGENT_ROOT_SCOPES, agentRootScopes, type AgentRootScope } from "./AgentRoots.ts";

export interface PluginSourceSet extends PluginDiscovery {
    readonly roots: Readonly<Record<AgentRootScope, string | null>>;
    readonly packages: readonly PackageCandidate[];
    readonly pluginPackages: ReadonlySet<string>;
    readonly configurationErrors: readonly ConfigurationError[];
}

// {§agent-plugins-hosting} One source cascade for native startup and workspace components.
export default class PluginSources {
    static async read({ hostPaths = new HostPaths(), projectRoot = null, nodeModules, packageDirs,
        environment = process.env }: {
        readonly hostPaths?: HostPaths;
        readonly projectRoot?: string | null;
        readonly nodeModules: string;
        readonly packageDirs?: readonly PackageCandidate[];
        readonly environment?: NodeJS.ProcessEnv;
    }): Promise<PluginSourceSet> {
        let selected: ReturnType<typeof agentRootScopes>;
        const configurationErrors: ConfigurationError[] = [];
        try {
            selected = agentRootScopes(environment);
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            configurationErrors.push(cause);
            selected = new Set();
        }
        const roots = {
            project: selected.has("project") && projectRoot !== null ? hostPaths.projectPluginsDir(projectRoot) : null,
            plurnk: selected.has("plurnk") ? hostPaths.plurnkPluginsDir : null,
            global: selected.has("global") ? hostPaths.globalPluginsDir : null,
        };
        const packages = (packageDirs ?? await Meta.packageDirs(nodeModules))
            .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        const pluginPackages = new Set<string>();
        const readablePlugins: string[] = [];
        for (const { dir } of packages) {
            const location = join(dir, "plugin.json");
            try {
                await lstat(location);
                pluginPackages.add(dir);
                readablePlugins.push(dir);
            } catch (cause) {
                const code = (cause as NodeJS.ErrnoException).code;
                if (code !== "ENOENT" && code !== "ENOTDIR") {
                    configurationErrors.push(new ConfigurationError(location, `${location}: plugin manifest could not be inspected.`, { cause }));
                    pluginPackages.add(dir);
                }
            }
        }
        const discovered = await PluginRoots.discover(AGENT_ROOT_SCOPES.flatMap((scope) => {
            const directory = roots[scope];
            return directory === null ? [] : [{ scope, directory }];
        }), readablePlugins.map((directory) => ({ scope: "npm", directory })));
        return { ...discovered, roots, packages, pluginPackages, configurationErrors };
    }
}

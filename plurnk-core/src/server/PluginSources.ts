import { errnoCode } from "@plurnk/plurnk-contracts";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import Meta, { ConfigurationError, type PackageCandidate } from "@plurnk/plurnk-meta";
import { PluginRoots, type PluginDiscovery } from "@plurnk/plurnk-agent-plugins";
import HostPaths from "../core/HostPaths.ts";
import { CONFIGURATION_ROOT_SCOPES, agentRootScopes, type ConfigurationRootScope } from "./AgentRoots.ts";

export interface PluginSourceSet extends PluginDiscovery {
    readonly roots: Readonly<Record<ConfigurationRootScope, string | null>>;
    readonly packages: readonly PackageCandidate[];
    readonly pluginRoots: ReadonlySet<string>;
    readonly pluginPackages: ReadonlySet<string>;
    readonly moduleDirs: readonly string[];
    readonly configurationErrors: readonly ConfigurationError[];
}

// {§functionality-inspection} One source cascade for native startup and workspace components.
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
        const roots: Readonly<Record<ConfigurationRootScope, string | null>> = {
            project: selected.has("project") && projectRoot !== null ? hostPaths.projectPluginsDir(projectRoot) : null,
            plurnk: selected.has("plurnk") ? hostPaths.plurnkPluginsDir : null,
            "xdg-global": selected.has("global") && hostPaths.xdgPluginsDir !== hostPaths.globalPluginsDir ? hostPaths.xdgPluginsDir : null,
            global: selected.has("global") ? hostPaths.globalPluginsDir : null,
        };
        const allPackages = (packageDirs ?? await Meta.packageDirs(nodeModules))
            .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        const inspected = await Promise.all(allPackages.map(async ({ dir }) => {
            const location = join(dir, "plugin.json");
            try {
                await lstat(location);
                return { dir, readable: true, error: null };
            } catch (cause) {
                const code = errnoCode(cause);
                if (code === "ENOENT" || code === "ENOTDIR") return null;
                return {
                    dir,
                    readable: false,
                    error: new ConfigurationError(location, `${location}: plugin manifest could not be inspected.`, { cause }),
                };
            }
        }));
        const pluginPackages = new Set<string>();
        const readablePlugins: string[] = [];
        for (const item of inspected) {
            if (item === null) continue;
            pluginPackages.add(item.dir);
            if (item.readable) readablePlugins.push(item.dir);
            if (item.error !== null) configurationErrors.push(item.error);
        }
        const discovered = await PluginRoots.discover(CONFIGURATION_ROOT_SCOPES.flatMap((scope) => {
            const directory = roots[scope];
            return directory === null ? [] : [{ scope, directory }];
        }), readablePlugins.map((directory) => ({ scope: "npm", directory })));
        const packages = allPackages.filter(({ dir }) => !pluginPackages.has(dir));
        const pluginRoots = new Set(discovered.plugins.map(({ root }) => root));
        const moduleDirs = [...pluginRoots, ...packages.map(({ dir }) => dir)];
        return { ...discovered, roots, packages, pluginRoots, pluginPackages, moduleDirs, configurationErrors };
    }
}

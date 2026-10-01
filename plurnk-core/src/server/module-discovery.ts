import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Meta, { ConfigurationError } from "@plurnk/plurnk-meta";
import type { PluginReport } from "@plurnk/plurnk-agent-plugins";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type { DaemonModule } from "./DaemonModule.ts";
import HostPaths from "../core/HostPaths.ts";
import PluginSources from "./PluginSources.ts";
import EnvDefaults from "../core/env-defaults.ts";

// {§module-discovery} Standard plugin bundles and capability-library packages
// meet the same daemon lifecycle; project roots never supply native code.

const EXPLICIT_COMPOSITION = new Set([
    "@plurnk/plurnk-agui",
    "@plurnk/plurnk-hooks",
    "@plurnk/plurnk-mcp",
]);

interface ModuleManifest {
    readonly packageName: string;
    readonly module: string;
    readonly manifestPath: string;
}

const assertDaemonModule = (
    value: unknown,
    packageName: string,
    source: "export" | "factory",
): DaemonModule<ApplicationPort> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        const detail = source === "factory"
            ? "factory returned a non-object DaemonModule"
            : "must export a DaemonModule object or no-argument factory";
        throw new TypeError(`module package '${packageName}' ${detail}.`);
    }
    for (const member of ["setup", "start", "stop", "close"] as const) {
        const hook = (value as Record<string, unknown>)[member];
        if (hook !== undefined && typeof hook !== "function") {
            throw new TypeError(
                `module package '${packageName}' lifecycle member '${member}' must be a function when present.`,
            );
        }
    }
    return value as DaemonModule<ApplicationPort>;
};

const readManifest = async (dir: string): Promise<ModuleManifest | null> => {
    const manifest = await Meta.readManifest(dir, "module");
    if (manifest === null || manifest.packageName === null) return null;
    const moduleSubpath = manifest.plurnk.module;
    if (typeof moduleSubpath !== "string" || moduleSubpath.length === 0) return null;
    return { packageName: manifest.packageName, module: moduleSubpath, manifestPath: manifest.manifestPath };
};

export const discoverDaemonModules = async (
    options: { cwd?: string; hostPaths?: HostPaths; packageDirs?: Array<{ dir: string; name: string }> } = {},
): Promise<{
    readonly modules: ReadonlyArray<DaemonModule<ApplicationPort>>;
    readonly skipped: readonly string[];
    readonly reports: readonly PluginReport[];
    readonly configurationErrors: readonly ConfigurationError[];
}> => {
    const sources = await PluginSources.read({
        nodeModules: join(options.cwd ?? process.cwd(), "node_modules"),
        hostPaths: options.hostPaths, packageDirs: options.packageDirs,
    });
    const dirs = [
        ...sources.plugins.map(({ root }) => ({ dir: root })),
        ...sources.packages.filter(({ dir }) => !sources.pluginPackages.has(dir)),
    ];
    const modules: DaemonModule<ApplicationPort>[] = [];
    const configurationErrors: ConfigurationError[] = [...sources.configurationErrors];
    const skipped: string[] = [];
    for (const candidate of dirs) {
        let manifest: ModuleManifest | null;
        try {
            manifest = await readManifest(candidate.dir);
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            configurationErrors.push(cause);
            continue;
        }
        if (manifest === null) continue;
        if (EXPLICIT_COMPOSITION.has(manifest.packageName)) continue;
        if (!Meta.isTrusted(manifest.packageName)) {
            skipped.push(manifest.packageName);
            continue;
        }
        try {
            if (sources.plugins.some(({ root }) => root === candidate.dir)) {
                await EnvDefaults.nativeFile(candidate.dir, manifest.packageName);
            }
            const imported = await import(pathToFileURL(join(candidate.dir, manifest.module)).href) as {
                default?: unknown;
            };
            const exported = imported.default;
            if (exported === undefined) {
                throw new Error(`module package '${manifest.packageName}' exports no default DaemonModule at '${manifest.module}'.`);
            }
            if (typeof exported !== "function") {
                modules.push(assertDaemonModule(exported, manifest.packageName, "export"));
                continue;
            }
            if (exported.length !== 0) {
                throw new TypeError(
                    `module package '${manifest.packageName}' DaemonModule factory must accept no arguments.`,
                );
            }
            const created = await (exported as () => unknown | Promise<unknown>)();
            modules.push(assertDaemonModule(created, manifest.packageName, "factory"));
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
                configurationErrors.push(new ConfigurationError(manifest.manifestPath,
                    `${manifest.packageName}: ${(cause as Error).message}`, { cause }));
                continue;
            }
            if (!(cause instanceof ConfigurationError)) throw cause;
            configurationErrors.push(cause);
        }
    }
    return { modules, skipped, reports: sources.reports, configurationErrors };
};

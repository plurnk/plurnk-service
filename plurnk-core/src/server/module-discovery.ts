import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import Meta, { ConfigurationError } from "@plurnk/plurnk-meta";
import type { PluginReport } from "@plurnk/plurnk-agent-plugins";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import type { HostSetupSeam } from "./ModuleHost.ts";
import HostPaths from "../core/HostPaths.ts";
import PluginSources from "./PluginSources.ts";
import EnvDefaults from "../core/env-defaults.ts";

// {§module-discovery} Standard plugin bundles and extension packages
// meet the same daemon lifecycle; project roots never supply native code.

interface ModuleManifest {
    readonly packageName: string;
    readonly module: string;
    readonly manifestPath: string;
}

const assertDaemonModule = (
    value: unknown,
    packageName: string,
    source: "export" | "factory",
): DaemonModule<HostSetupSeam, ApplicationPort> => {
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
    return value as DaemonModule<HostSetupSeam, ApplicationPort>;
};

// {§module-discovery} — a package names its entry as an export subpath, resolved through its own
// export map as {§executor-dynamic-runtimes} does, so conditions select source or build; a bundle
// names a file beneath ai.plurnk/.
const moduleEntry = async (manifest: NonNullable<Awaited<ReturnType<typeof Meta.readManifest>>>, packageName: string, entry: string): Promise<string> => {
    if (basename(manifest.manifestPath) === "plugin.json") return Meta.moduleFile(manifest, entry);
    if (!entry.startsWith("./")) {
        throw new ConfigurationError(manifest.manifestPath, `${packageName}: plurnk.module '${entry}' must be an export subpath such as "./module".`);
    }
    try {
        return createRequire(manifest.manifestPath).resolve(`${packageName}${entry.slice(1)}`);
    } catch (cause) {
        throw new ConfigurationError(manifest.manifestPath, `${packageName}: plurnk.module '${entry}' does not resolve through the package's exports.`, { cause });
    }
};

const readManifest = async (dir: string): Promise<ModuleManifest | null> => {
    const manifest = await Meta.readManifest(dir, "module");
    if (manifest === null || manifest.packageName === null) return null;
    const entry = manifest.plurnk.module;
    if (typeof entry !== "string" || entry.length === 0) return null;
    return { packageName: manifest.packageName, module: await moduleEntry(manifest, manifest.packageName, entry), manifestPath: manifest.manifestPath };
};

// `registered` names the owners the host already registered explicitly: a package registered
// explicitly is never also discovered, and is skipped before its code is imported.
export const discoverDaemonModules = async (
    options: { cwd?: string; hostPaths?: HostPaths; packageDirs?: Array<{ dir: string; name: string }>; registered?: ReadonlySet<string> } = {},
): Promise<{
    // Each module with its owner, the package it came from ({§module-discovery}).
    readonly modules: ReadonlyArray<{ readonly module: DaemonModule<HostSetupSeam, ApplicationPort>; readonly owner: string }>;
    readonly skipped: readonly string[];
    readonly reports: readonly PluginReport[];
    // A declaration's error is the extensions family's; a module's own configuration error is the
    // module's, `module:<owner>`.
    readonly configurationErrors: ReadonlyArray<{ readonly family: string; readonly cause: ConfigurationError }>;
}> => {
    const sources = await PluginSources.read({
        nodeModules: join(options.cwd ?? process.cwd(), "node_modules"),
        hostPaths: options.hostPaths, packageDirs: options.packageDirs,
    });
    const dirs = [
        ...sources.plugins.map(({ root }) => ({ dir: root })),
        ...sources.packages.filter(({ dir }) => !sources.pluginPackages.has(dir)),
    ];
    const modules: Array<{ readonly module: DaemonModule<HostSetupSeam, ApplicationPort>; readonly owner: string }> = [];
    const configurationErrors: Array<{ readonly family: string; readonly cause: ConfigurationError }> = sources.configurationErrors
        .map((cause) => ({ family: "extensions", cause }));
    const skipped: string[] = [];
    for (const candidate of dirs) {
        let manifest: ModuleManifest | null;
        try {
            manifest = await readManifest(candidate.dir);
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            configurationErrors.push({ family: "extensions", cause });
            continue;
        }
        if (manifest === null) continue;
        if (options.registered?.has(manifest.packageName) === true) continue;
        if (!Meta.isTrusted(manifest.packageName)) {
            skipped.push(manifest.packageName);
            continue;
        }
        try {
            if (sources.plugins.some(({ root }) => root === candidate.dir)) {
                await EnvDefaults.nativeFile(candidate.dir, manifest.packageName);
            }
            const imported = await import(pathToFileURL(manifest.module).href) as {
                default?: unknown;
            };
            const exported = imported.default;
            if (exported === undefined) {
                throw new Error(`module package '${manifest.packageName}' exports no default DaemonModule at '${manifest.module}'.`);
            }
            if (typeof exported !== "function") {
                modules.push({ module: assertDaemonModule(exported, manifest.packageName, "export"), owner: manifest.packageName });
                continue;
            }
            if (exported.length !== 0) {
                throw new TypeError(
                    `module package '${manifest.packageName}' DaemonModule factory must accept no arguments.`,
                );
            }
            const created = await (exported as () => unknown | Promise<unknown>)();
            modules.push({ module: assertDaemonModule(created, manifest.packageName, "factory"), owner: manifest.packageName });
        } catch (cause) {
            const family = `module:${manifest.packageName}`;
            if ((cause as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
                configurationErrors.push({ family, cause: new ConfigurationError(manifest.manifestPath,
                    `${manifest.packageName}: ${(cause as Error).message}`, { cause }) });
                continue;
            }
            if (!(cause instanceof ConfigurationError)) throw cause;
            configurationErrors.push({ family, cause });
        }
    }
    return { modules, skipped, reports: sources.reports, configurationErrors };
};

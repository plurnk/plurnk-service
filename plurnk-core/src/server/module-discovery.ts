import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import Meta from "@plurnk/plurnk-meta";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type { DaemonModule } from "./DaemonModule.ts";

// {§module-discovery} — third-party daemon-module composition. A package
// declares `plurnk: { kind: "module", module: "<export-subpath>" }`; the export
// is one DaemonModule (an object, or a no-arg factory returning one).
// Discovery mirrors the executor family ({§plugin-discovery}): scope-agnostic
// package scan, trust gate ({§plugin-trust-boundary}), lazy import.
//
// The service's explicit composition — the AG-UI, hooks, and MCP modules —
// carries init options and is wired in service.ts; discovery never duplicates
// those packages.

const EXPLICIT_COMPOSITION = new Set([
    "@plurnk/plurnk-agui",
    "@plurnk/plurnk-hooks",
    "@plurnk/plurnk-mcp",
]);

interface ModuleManifest {
    readonly packageName: string;
    readonly module: string;
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
    for (const member of ["setup", "start", "close"] as const) {
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
    let raw: string;
    try {
        raw = await fs.readFile(join(dir, "package.json"), "utf8");
    } catch {
        return null;
    }
    let pkg: Record<string, unknown>;
    try {
        pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
    const plurnk = pkg.plurnk;
    if (!Meta.declaresKind(plurnk, "module")) return null;
    const moduleSubpath = (plurnk as { module?: unknown }).module;
    if (typeof moduleSubpath !== "string" || moduleSubpath.length === 0) return null;
    const packageName = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : null;
    if (packageName === null) return null;
    return { packageName, module: moduleSubpath };
};

export const discoverDaemonModules = async (
    options: { cwd?: string; packageDirs?: Array<{ dir: string; name: string }> } = {},
): Promise<{ readonly modules: ReadonlyArray<DaemonModule<ApplicationPort>>; readonly skipped: readonly string[] }> => {
    const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
    const dirs = (options.packageDirs
        ?? await Meta.packageDirs(join(options.cwd ?? process.cwd(), "node_modules")))
        .toSorted((left, right) => compareText(left.name, right.name) || compareText(left.dir, right.dir));
    const pending: Array<Promise<DaemonModule<ApplicationPort>>> = [];
    const skipped: string[] = [];
    for (const candidate of dirs) {
        const manifest = await readManifest(candidate.dir);
        if (manifest === null) continue;
        if (EXPLICIT_COMPOSITION.has(manifest.packageName)) continue;
        if (!Meta.isTrusted(manifest.packageName)) {
            skipped.push(manifest.packageName);
            continue;
        }
        pending.push((async (): Promise<DaemonModule<ApplicationPort>> => {
            const imported = await import(pathToFileURL(join(candidate.dir, manifest.module)).href) as {
                default?: unknown;
            };
            const exported = imported.default;
            if (exported === undefined) {
                throw new Error(`module package '${manifest.packageName}' exports no default DaemonModule at '${manifest.module}'.`);
            }
            if (typeof exported !== "function") {
                return assertDaemonModule(exported, manifest.packageName, "export");
            }
            if (exported.length !== 0) {
                throw new TypeError(
                    `module package '${manifest.packageName}' DaemonModule factory must accept no arguments.`,
                );
            }
            const created = await (exported as () => unknown | Promise<unknown>)();
            return assertDaemonModule(created, manifest.packageName, "factory");
        })());
    }
    return { modules: await Promise.all(pending), skipped };
};

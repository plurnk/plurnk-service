import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { isRecord, type ApplicationServiceUpdateResult } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import { updateCatalogCache } from "@plurnk/plurnk-models";
import { getBuildInfo, type BuildInfo } from "../build-info.ts";
import HostPaths from "./HostPaths.ts";
import Results, { OperationFailureError } from "./results.ts";

const execFileAsync = promisify(execFile);

export interface ServiceUpdaterOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly hostPaths?: HostPaths;
    readonly buildInfo?: BuildInfo;
    readonly catalogUrl?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly npmInstall?: (info: BuildInfo) => Promise<string>;
}

const defaultNpmInstall = async (info: BuildInfo): Promise<string> => {
    const scopeDir = dirname(info.path);
    const nodeModulesDir = dirname(scopeDir);
    const clientPkgJson = resolve(nodeModulesDir, "@plurnk", "plurnk", "package.json");
    const packages = [
        `${info.package}@latest`,
        ...(existsSync(clientPkgJson) ? ["@plurnk/plurnk@latest"] : []),
    ];
    await execFileAsync("npm", ["install", "-g", "--no-audit", "--no-fund", ...packages]);
    try {
        const raw: unknown = JSON.parse(await readFile(resolve(info.path, "package.json"), "utf8"));
        if (isRecord(raw) && typeof raw.version === "string") {
            return raw.version;
        }
    } catch {
        // fall through to previous version if path moved
    }
    return info.version;
};

// {§service-update} Explicit operator-triggered model-catalog and package update.
export default class ServiceUpdater {
    static validateConfiguration(env: NodeJS.ProcessEnv = process.env): boolean {
        return Knob.flag("PLURNK_SERVICE_UPDATEABLE", env);
    }

    static async run(options: ServiceUpdaterOptions = {}): Promise<ApplicationServiceUpdateResult> {
        const env = options.env ?? process.env;
        if (!ServiceUpdater.validateConfiguration(env)) {
            throw new OperationFailureError(
                Results.failure(
                    "daemon:update",
                    "update-disabled",
                    403,
                    "service update is disabled by PLURNK_SERVICE_UPDATEABLE=0 — update packages with npm and configure uncataloged models via provider environment knobs",
                    {},
                    { retryable: false },
                ),
            );
        }
        const hostPaths = options.hostPaths ?? new HostPaths({ env });
        const catalog = await updateCatalogCache(hostPaths.modelsCacheFile, {
            ...(options.catalogUrl === undefined ? {} : { url: options.catalogUrl }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
        const info = options.buildInfo ?? await getBuildInfo();
        if (info.artifact === "source") {
            return {
                catalog,
                npm: {
                    status: "source",
                    package: info.package,
                    previousVersion: info.version,
                    currentVersion: info.version,
                },
            };
        }
        const install = options.npmInstall ?? defaultNpmInstall;
        const currentVersion = await install(info);
        return {
            catalog,
            npm: {
                status: currentVersion !== info.version ? "updated" : "unchanged",
                package: info.package,
                previousVersion: info.version,
                currentVersion,
            },
        };
    }

    static formatReport(result: ApplicationServiceUpdateResult): string {
        const added = result.catalog.addedModels > 0 ? `, +${result.catalog.addedModels} new` : "";
        const catLine = `catalog: ${result.catalog.status} (${result.catalog.models} models across ${result.catalog.providers} providers${added})`;
        const npmLine = result.npm.status === "source"
            ? `npm: ${result.npm.package}@${result.npm.currentVersion} (source checkout)`
            : result.npm.status === "updated"
                ? `npm: ${result.npm.package} ${result.npm.previousVersion} -> ${result.npm.currentVersion}`
                : `npm: ${result.npm.package}@${result.npm.currentVersion} (unchanged)`;
        return `${catLine}\n${npmLine}`;
    }
}

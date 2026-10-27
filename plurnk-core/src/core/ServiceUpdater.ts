import type { ApplicationServiceUpdateResult } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import { updateCatalogCache } from "@plurnk/plurnk-models";
import { getBuildInfo, type BuildInfo } from "../build-info.ts";
import HostPaths from "./HostPaths.ts";
import Results, { OperationFailureError } from "./results.ts";

export interface ServiceUpdaterOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly hostPaths?: HostPaths;
    readonly buildInfo?: BuildInfo;
    readonly catalogUrl?: string;
    readonly fetch?: typeof globalThis.fetch;
}

const PACKAGE_UPGRADE_COMMAND = "npm install -g @plurnk/plurnk-service@latest @plurnk/plurnk@latest";

// {§startup-admission} Explicit operator-triggered model-catalog refresh.
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
                    "service update is disabled by PLURNK_SERVICE_UPDATEABLE=0 — configure uncataloged models via provider environment knobs",
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
        return {
            catalog,
            service: {
                package: info.package,
                version: info.version,
                artifact: info.artifact,
                upgradeCommand: PACKAGE_UPGRADE_COMMAND,
            },
        };
    }

    static formatReport(result: ApplicationServiceUpdateResult): string {
        const added = result.catalog.addedModels > 0 ? `, +${result.catalog.addedModels} new` : "";
        const catLine = `catalog: ${result.catalog.status} (${result.catalog.models} models across ${result.catalog.providers} providers${added})`;
        const suffix = result.service.artifact === "source" ? " (source checkout)" : "";
        const verLine = `version: ${result.service.package}@${result.service.version}${suffix} — to update packages, stop the daemon and run: ${result.service.upgradeCommand}`;
        return `${catLine}\n${verLine}`;
    }
}

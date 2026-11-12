import createAcpModule from "@plurnk/plurnk-acp/module";
import createAuthModule from "@plurnk/plurnk-auth/module";
import { errnoCode, isRecord } from "@plurnk/plurnk-contracts";
import { configuredDefinitions, validateConfiguration as validateMcp } from "@plurnk/plurnk-mcp";
import createMcpModules from "@plurnk/plurnk-mcp/module";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import { validateConfiguration as validateSchedule } from "@plurnk/plurnk-schedule";
import createScheduleModule from "@plurnk/plurnk-schedule/module";
import createSkillsModule from "@plurnk/plurnk-skills/module";
import type { HostSetupSeam } from "./ModuleHost.ts";

interface ComposedDaemonModule {
    readonly owner: string;
    readonly module: DaemonModule<HostSetupSeam>;
}

export interface ComposedDaemonModules {
    readonly modules: readonly ComposedDaemonModule[];
    readonly configurationErrors: ReadonlyArray<{ readonly owner: string; readonly cause: ConfigurationError }>;
}

const isDaemonModule = (value: unknown): value is DaemonModule<HostSetupSeam> => isRecord(value);

const loadOptionalModule = async (specifier: string): Promise<readonly DaemonModule<HostSetupSeam>[]> => {
    let resolved: string;
    try {
        resolved = import.meta.resolve(specifier);
    } catch (cause) {
        if (errnoCode(cause) === "ERR_MODULE_NOT_FOUND") return [];
        throw cause;
    }
    const mod: unknown = await import(resolved);
    if (!isRecord(mod) || typeof mod.default !== "function") {
        throw new Error(`optional module '${specifier}' has no default factory export`);
    }
    const instance: unknown = Reflect.apply(mod.default, undefined, []);
    if (!isDaemonModule(instance)) {
        throw new Error(`optional module '${specifier}' factory returned no object`);
    }
    return [instance];
};

const FIRST_PARTY_MODULES: ReadonlyArray<{
    readonly owner: string;
    readonly create: () => readonly DaemonModule<HostSetupSeam>[] | Promise<readonly DaemonModule<HostSetupSeam>[]>;
}> = [
    { owner: "@plurnk/plurnk-acp", create: () => [createAcpModule()] },
    { owner: "@plurnk/plurnk-auth", create: () => [createAuthModule()] },
    { owner: "@plurnk/plurnk-mcp", create: createMcpModules },
    { owner: "@plurnk/plurnk-otel", create: () => loadOptionalModule("@plurnk/plurnk-otel/module") },
    { owner: "@plurnk/plurnk-schedule", create: () => [createScheduleModule()] },
    { owner: "@plurnk/plurnk-skills", create: () => [createSkillsModule()] },
    { owner: "@plurnk/plurnk-web", create: () => loadOptionalModule("@plurnk/plurnk-web/module") },
];

// {§observability-boundary} {§module-lifecycle} — first-party daemon modules are composed statically
// by `@plurnk/plurnk-service` (with optional modules omitted when `--omit=optional` excludes them);
// explicit host or test registrations under the same owner take precedence.
export default class ServiceModules {
    static async compose({ registered = new Set<string>() }: {
        readonly registered?: ReadonlySet<string>;
    } = {}): Promise<ComposedDaemonModules> {
        const modules: ComposedDaemonModule[] = [];
        const configurationErrors: Array<{ owner: string; cause: ConfigurationError }> = [];
        for (const { owner, create } of FIRST_PARTY_MODULES) {
            if (registered.has(owner)) continue;
            try {
                for (const module of await create()) modules.push({ owner, module });
            } catch (cause) {
                if (!(cause instanceof ConfigurationError)) throw cause;
                configurationErrors.push({ owner: `module:${owner}`, cause });
            }
        }
        return { modules, configurationErrors };
    }

    static async validateConfiguration(directories: readonly string[]): Promise<void> {
        validateMcp();
        await configuredDefinitions(directories);
        validateSchedule();
        const { modules, configurationErrors } = await ServiceModules.compose();
        const causes = [
            ...configurationErrors.map(({ cause }) => cause),
            ...modules.flatMap(({ module }) => (module.contained ?? []).map(({ key, message }) => new ConfigurationError(key, message))),
        ];
        if (causes.length > 0) throw new Error(causes.map(({ message }) => message).join("\n"), { cause: causes[0] });
    }
}

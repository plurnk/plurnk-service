import { errnoCode } from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import ConfigPolicy from "./ConfigPolicy.ts";
import OperatorConfig from "./OperatorConfig.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const BIND_TIME_EXACT = new Set([
    "PLURNK_HOST",
    "PLURNK_PORT",
    "PLURNK_SERVICE_DB_PATH",
    "PLURNK_SERVICE_STATE_ROOT",
    "PLURNK_SERVICE_AUTO_VACUUM",
]);

export interface EnvFileSpec {
    readonly path: string;
    readonly required: boolean;
}

export interface CliFlagOverride {
    readonly value: string;
    readonly flagName: string;
}

export interface BindTimeDrift {
    readonly key: string;
    readonly source: string;
    readonly message: string;
}

export interface ServiceConfigOverride {
    readonly value: string;
    readonly secret: boolean;
}

export interface ServiceShadow {
    readonly key: string;
    readonly hostSource: string;
    readonly hostValue: string;
    readonly serviceSource: string;
    readonly message: string;
}

export interface CascadeReloadResult {
    readonly changed: boolean;
    readonly generation: number;
    readonly operatorFiles: ReadonlyArray<{ readonly path: string; readonly content: string }>;
    readonly undeclared: ReadonlyArray<{ readonly key: string; readonly file: string }>;
    readonly parseErrors: readonly ConfigurationError[];
    readonly restartRequired: readonly BindTimeDrift[];
    readonly serviceShadows: readonly ServiceShadow[];
}

interface PinnedValue {
    readonly value: string | undefined;
    readonly source: string | undefined;
    readonly fileValue: string | undefined;
}

// {§operator-config-precedence} — two-stage monotonic environment cascade:
//   Stage 1 (host baseline, read-only): defaults -> operator .env -> .env.local -> --config -> --env-file* -> bootEnv -> CLI flags
//   Stage 2 (in-service tier): host -> service (service_config + encrypted ServiceSecretStore)
// Bind-time, confinement, and Functionality-family keys remain strictly host-only; ceilings narrow
// monotonically (most-restrictive-wins); shadowing an explicit host override emits a loud provenance notice.
export default class OperatorEnvCascade {
    readonly #bootEnv: Readonly<Record<string, string>>;
    readonly #cliFlags: ReadonlyMap<string, CliFlagOverride>;
    readonly #envFiles: readonly EnvFileSpec[];
    readonly #configFile: string | null;
    readonly #localConfigFile: string;
    readonly #operatorConfigFile: string;
    readonly #defaultsMap: ReadonlyMap<string, { readonly value: string; readonly owner: string }>;
    readonly #declares: (key: string) => boolean;
    readonly #env: NodeJS.ProcessEnv;

    #signatures = new Map<string, string>();
    #managedKeys = new Set<string>();
    #sources = new Map<string, string>();
    #hostEffective = new Map<string, string>();
    #hostSources = new Map<string, string>();
    #fileWinners = new Map<string, { readonly value: string; readonly source: string }>();
    #serviceEntries = new Map<string, ServiceConfigOverride>();
    #serviceVersion = 0;
    #appliedServiceVersion = -1;
    #pinnedBindValues: ReadonlyMap<string, PinnedValue> | null = null;
    #restartRequired: readonly BindTimeDrift[] = [];
    #serviceShadows: readonly ServiceShadow[] = [];
    #generation = 0;

    constructor({
        bootEnv,
        cliFlags,
        envFiles,
        configFile,
        localConfigFile,
        operatorConfigFile,
        defaultsMap,
        declares,
        serviceEntries,
        env = process.env,
    }: {
        readonly bootEnv: Readonly<Record<string, string>>;
        readonly cliFlags: ReadonlyMap<string, CliFlagOverride>;
        readonly envFiles: readonly EnvFileSpec[];
        readonly configFile: string | null;
        readonly localConfigFile: string;
        readonly operatorConfigFile: string;
        readonly defaultsMap: ReadonlyMap<string, { readonly value: string; readonly owner: string }>;
        readonly declares: (key: string) => boolean;
        readonly serviceEntries?: ReadonlyMap<string, ServiceConfigOverride>;
        readonly env?: NodeJS.ProcessEnv;
    }) {
        this.#bootEnv = { ...bootEnv };
        this.#cliFlags = new Map(cliFlags);
        this.#envFiles = envFiles.map(({ path, required }) => ({ path: resolve(path), required }));
        this.#configFile = configFile === null ? null : resolve(configFile);
        this.#localConfigFile = resolve(localConfigFile);
        this.#operatorConfigFile = resolve(operatorConfigFile);
        this.#defaultsMap = defaultsMap;
        this.#declares = declares;
        this.#env = env;
        if (serviceEntries !== undefined) {
            this.#serviceEntries = new Map(serviceEntries);
        }
    }

    static snapshotEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
        const snapshot: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
            if (value !== undefined) snapshot[key] = value;
        }
        return snapshot;
    }

    static isBindTimeKey(key: string): boolean {
        return OperatorConfig.isBindTimeKey(key);
    }

    static statSignature(path: string): string {
        try {
            const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
            if (stat === undefined) return "absent";
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch {
            return "unreadable";
        }
    }

    // Boot-time loading before package defaults are collected: enforces required `--env-file` and
    // `--config` presence with exit-64 diagnostics while preserving `{§operator-config-precedence}`.
    static applyBootFiles({
        bootEnv,
        envFiles,
        configFile,
        localConfigFile,
        operatorConfigFile,
        cliFlags,
        env = process.env,
    }: {
        readonly bootEnv: Readonly<Record<string, string>>;
        readonly envFiles: readonly EnvFileSpec[];
        readonly configFile: string | null;
        readonly localConfigFile: string;
        readonly operatorConfigFile: string;
        readonly cliFlags: ReadonlyMap<string, CliFlagOverride>;
        readonly env?: NodeJS.ProcessEnv;
    }): void {
        const layers: Array<{ readonly rawPath: string; readonly resolved: string; readonly required: boolean }> = [
            { rawPath: operatorConfigFile, resolved: resolve(operatorConfigFile), required: false },
            { rawPath: localConfigFile, resolved: resolve(localConfigFile), required: false },
            ...(configFile === null ? [] : [{ rawPath: configFile, resolved: resolve(configFile), required: true }]),
            ...envFiles.map(({ path, required }) => ({ rawPath: path, resolved: resolve(path), required })),
        ];
        // Validate required files in CLI/high-to-low order so diagnostics match existing boot checks.
        for (const layer of [...envFiles.toReversed().map(({ path, required }) => ({ rawPath: path, resolved: resolve(path), required })), ...(configFile === null ? [] : [{ rawPath: configFile, resolved: resolve(configFile), required: true }])]) {
            if (!existsSync(layer.resolved)) {
                if (layer.required) {
                    throw Object.assign(new Error(`${layer.rawPath} does not exist`), { exitCode: 64 });
                }
            }
        }
        const merged = new Map<string, string>();
        for (const layer of layers) {
            if (!existsSync(layer.resolved)) continue;
            let content: string;
            try {
                content = readFileSync(layer.resolved, "utf8");
            } catch (cause) {
                throw Object.assign(
                    new Error(`failed to load ${layer.rawPath}: ${cause instanceof Error ? cause.message : String(cause)}`),
                    { exitCode: 64 },
                );
            }
            const parsed = parseEnv(content);
            for (const [key, value] of Object.entries(parsed)) {
                if (value !== undefined && ENV_NAME.test(key)) merged.set(key, value);
            }
        }
        for (const [key, value] of Object.entries(bootEnv)) {
            merged.set(key, value);
        }
        for (const [key, { value }] of cliFlags) {
            merged.set(key, value);
        }
        for (const [key, value] of merged) {
            env[key] = value;
        }
    }

    get bootEnv(): Readonly<Record<string, string>> {
        return this.#bootEnv;
    }

    get sources(): ReadonlyMap<string, string> {
        return this.#sources;
    }

    get hostEffective(): ReadonlyMap<string, string> {
        return this.#hostEffective;
    }

    get hostSources(): ReadonlyMap<string, string> {
        return this.#hostSources;
    }

    hostEnv(): NodeJS.ProcessEnv {
        if (this.#hostEffective.size === 0) return this.#env;
        return Object.fromEntries(this.#hostEffective);
    }

    get serviceEntries(): ReadonlyMap<string, ServiceConfigOverride> {
        return this.#serviceEntries;
    }

    get serviceShadows(): readonly ServiceShadow[] {
        return this.#serviceShadows;
    }

    get defaultsMap(): ReadonlyMap<string, { readonly value: string; readonly owner: string }> {
        return this.#defaultsMap;
    }

    get generation(): number {
        return this.#generation;
    }

    get restartRequired(): readonly BindTimeDrift[] {
        return this.#restartRequired;
    }

    setServiceEntries(entries: ReadonlyMap<string, ServiceConfigOverride>): void {
        this.#serviceEntries = new Map(entries);
        this.#serviceVersion += 1;
    }

    watchedFiles(): string[] {
        return [...new Set([
            this.#operatorConfigFile,
            this.#localConfigFile,
            ...(this.#configFile === null ? [] : [this.#configFile]),
            ...this.#envFiles.map(({ path }) => path),
        ])];
    }

    operatorFiles(): string[] {
        return [...new Set([
            ...(this.#configFile === null ? [] : [this.#configFile]),
            this.#operatorConfigFile,
            this.#localConfigFile,
        ])];
    }

    // Freeze bind-time keys (listener address, DB path/SQLite pragmas, auth secret/posture) at their
    // boot-admitted values so a live `.env` edit keeps the running daemon coherent and emits a
    // restart-required diagnostic instead of silently mutating `process.env`.
    pinBindTimeValues(): void {
        const pinned = new Map<string, PinnedValue>();
        const keys = new Set<string>([
            ...BIND_TIME_EXACT,
            ...[...this.#defaultsMap.keys()].filter((k) => OperatorEnvCascade.isBindTimeKey(k)),
            ...Object.keys(this.#env).filter((k) => OperatorEnvCascade.isBindTimeKey(k)),
        ]);
        for (const key of keys) {
            pinned.set(key, {
                value: this.#env[key],
                source: this.#sources.get(key),
                fileValue: this.#fileWinners.get(key)?.value,
            });
        }
        this.#pinnedBindValues = pinned;
    }

    hasChanged(): boolean {
        if (this.#appliedServiceVersion !== this.#serviceVersion) return true;
        const watched = this.watchedFiles();
        if (this.#signatures.size !== watched.length) return true;
        for (const path of watched) {
            if (this.#signatures.get(path) !== OperatorEnvCascade.statSignature(path)) return true;
        }
        return false;
    }

    refreshIfChanged(options: { readonly force?: boolean } = {}): CascadeReloadResult {
        if (!options.force && !this.hasChanged()) {
            return {
                changed: false,
                generation: this.#generation,
                operatorFiles: [],
                undeclared: [],
                parseErrors: [],
                restartRequired: this.#restartRequired,
                serviceShadows: this.#serviceShadows,
            };
        }

        const nextSignatures = new Map<string, string>();
        for (const path of this.watchedFiles()) {
            nextSignatures.set(path, OperatorEnvCascade.statSignature(path));
        }

        // Stage 1: pure Host baseline, low -> high per {§operator-config-precedence}.
        const orderedFiles: Array<{ readonly path: string; readonly isOperatorFile: boolean }> = [
            { path: this.#operatorConfigFile, isOperatorFile: true },
            { path: this.#localConfigFile, isOperatorFile: true },
            ...(this.#configFile === null ? [] : [{ path: this.#configFile, isOperatorFile: true }]),
            ...this.#envFiles.map(({ path }) => ({ path, isOperatorFile: false })),
        ];

        const hostEffective = new Map<string, string>();
        const hostSources = new Map<string, string>();
        for (const [key, { value, owner }] of this.#defaultsMap) {
            hostEffective.set(key, value);
            hostSources.set(key, `defaults (${owner})`);
        }

        const fileWinners = new Map<string, { readonly value: string; readonly source: string }>();
        const operatorFileContents: Array<{ readonly path: string; readonly content: string }> = [];
        const seenOperatorPaths = new Set<string>();
        const undeclared: Array<{ readonly key: string; readonly file: string }> = [];
        const parseErrors: ConfigurationError[] = [];

        for (const { path, isOperatorFile } of orderedFiles) {
            let content: string;
            try {
                content = readFileSync(path, "utf8");
            } catch (cause) {
                if (errnoCode(cause) === "ENOENT") continue;
                parseErrors.push(new ConfigurationError(
                    path,
                    `Failed to read ${path}: ${cause instanceof Error ? cause.message : String(cause)}.`,
                ));
                continue;
            }
            if (isOperatorFile && !seenOperatorPaths.has(path)) {
                seenOperatorPaths.add(path);
                operatorFileContents.push({ path, content });
                for (const key of OperatorConfig.undeclared(content, this.#declares)) {
                    undeclared.push({ key, file: path });
                }
            }
            const parsed = parseEnv(content);
            for (const [key, value] of Object.entries(parsed)) {
                if (value === undefined) continue;
                if (!ENV_NAME.test(key)) {
                    parseErrors.push(new ConfigurationError(
                        path,
                        `Malformed environment entry in ${path}: ${JSON.stringify(key)}.`,
                    ));
                    continue;
                }
                hostEffective.set(key, value);
                hostSources.set(key, path);
                fileWinners.set(key, { value, source: path });
            }
        }

        for (const [key, value] of Object.entries(this.#bootEnv)) {
            hostEffective.set(key, value);
            const def = this.#defaultsMap.get(key);
            const fw = fileWinners.get(key);
            if (def !== undefined && value === def.value && (fw === undefined || fw.value === value)) {
                hostSources.set(key, `defaults (${def.owner})`);
            } else {
                hostSources.set(key, "process environment");
            }
        }

        for (const [key, { value, flagName }] of this.#cliFlags) {
            hostEffective.set(key, value);
            hostSources.set(key, `flag:${flagName}`);
        }

        const restartRequired: BindTimeDrift[] = [];
        if (this.#pinnedBindValues !== null) {
            const candidateBindKeys = new Set<string>([
                ...this.#pinnedBindValues.keys(),
                ...[...hostEffective.keys()].filter((k) => OperatorEnvCascade.isBindTimeKey(k)),
                ...[...fileWinners.keys()].filter((k) => OperatorEnvCascade.isBindTimeKey(k)),
            ]);
            for (const key of [...candidateBindKeys].toSorted()) {
                const pinned = this.#pinnedBindValues.get(key) ?? { value: undefined, source: undefined, fileValue: undefined };
                const candidateValue = hostEffective.get(key);
                const fw = fileWinners.get(key);
                const fileChangedAgainstBoot = fw !== undefined && fw.value !== pinned.fileValue && fw.value !== pinned.value;
                if (candidateValue === pinned.value && !fileChangedAgainstBoot) continue;
                const candidateSource = fileChangedAgainstBoot && fw !== undefined
                    ? fw.source
                    : (hostSources.get(key) ?? this.#operatorConfigFile);
                if (pinned.value === undefined) {
                    hostEffective.delete(key);
                    hostSources.delete(key);
                } else {
                    hostEffective.set(key, pinned.value);
                    if (pinned.source !== undefined) hostSources.set(key, pinned.source);
                    else hostSources.delete(key);
                }
                restartRequired.push({
                    key,
                    source: candidateSource,
                    message: `${key} changed in ${candidateSource}; restart the daemon to apply.`,
                });
            }
        }

        // Stage 2: Service tier strictly inward over Stage 1 host baseline (host -> service).
        const effective = new Map<string, string>(hostEffective);
        const sources = new Map<string, string>(hostSources);
        const serviceShadows: ServiceShadow[] = [];

        for (const [key, override] of [...this.#serviceEntries.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
            if (!ENV_NAME.test(key) || ConfigPolicy.isHostOnly(key)) continue;
            const hostValue = hostEffective.get(key);
            const hostSource = hostSources.get(key);
            const composed = ConfigPolicy.composeCeiling(key, hostValue, override.value);
            const serviceSource = override.secret ? "service (secret)" : "service";
            effective.set(key, composed);
            sources.set(key, serviceSource);
            if (hostSource !== undefined && hostValue !== undefined && !hostSource.startsWith("defaults (") && composed !== hostValue) {
                serviceShadows.push({
                    key,
                    hostSource,
                    hostValue,
                    serviceSource,
                    message: `${key} in ${serviceSource} shadows ${hostSource} (unset at service scope to restore the host value).`,
                });
            }
        }

        for (const key of this.#managedKeys) {
            if (!effective.has(key) && !(key in this.#bootEnv)) {
                delete this.#env[key];
            }
        }
        for (const [key, value] of effective) {
            if (this.#env[key] !== value) this.#env[key] = value;
        }

        this.#managedKeys = new Set(effective.keys());
        this.#hostEffective = hostEffective;
        this.#hostSources = hostSources;
        this.#sources = sources;
        this.#fileWinners = fileWinners;
        this.#signatures = nextSignatures;
        this.#appliedServiceVersion = this.#serviceVersion;
        this.#restartRequired = restartRequired;
        this.#serviceShadows = serviceShadows;
        this.#generation += 1;

        return {
            changed: true,
            generation: this.#generation,
            operatorFiles: operatorFileContents,
            undeclared,
            parseErrors,
            restartRequired,
            serviceShadows,
        };
    }
}

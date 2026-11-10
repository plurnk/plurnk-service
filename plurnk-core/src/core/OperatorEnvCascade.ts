import { errnoCode } from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import OperatorConfig from "./OperatorConfig.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const BIND_TIME_EXACT = new Set([
    "PLURNK_HOST",
    "PLURNK_PORT",
    "PLURNK_SERVICE_DB_PATH",
    "PLURNK_SERVICE_STATE_ROOT",
    "PLURNK_AUTH",
    "PLURNK_SECRET",
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

export interface CascadeReloadResult {
    readonly changed: boolean;
    readonly generation: number;
    readonly operatorFiles: ReadonlyArray<{ readonly path: string; readonly content: string }>;
    readonly undeclared: ReadonlyArray<{ readonly key: string; readonly file: string }>;
    readonly parseErrors: readonly ConfigurationError[];
    readonly restartRequired: readonly BindTimeDrift[];
}

interface PinnedValue {
    readonly value: string | undefined;
    readonly source: string | undefined;
    readonly fileValue: string | undefined;
}

// {§operator-config-precedence} — tracks the layered environment provenance over an immutable boot
// shell snapshot so operator files can be recomputed cleanly on live edits, additions, or deletions
// without restarting the daemon or overwriting shell/CLI overrides.
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
    #fileWinners = new Map<string, { readonly value: string; readonly source: string }>();
    #pinnedBindValues: ReadonlyMap<string, PinnedValue> | null = null;
    #restartRequired: readonly BindTimeDrift[] = [];
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
    }

    static snapshotEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
        const snapshot: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
            if (value !== undefined) snapshot[key] = value;
        }
        return snapshot;
    }

    static isBindTimeKey(key: string): boolean {
        return BIND_TIME_EXACT.has(key) || key.startsWith("PLURNK_SERVICE_SQLITE_");
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

    get generation(): number {
        return this.#generation;
    }

    get restartRequired(): readonly BindTimeDrift[] {
        return this.#restartRequired;
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
            };
        }

        const nextSignatures = new Map<string, string>();
        for (const path of this.watchedFiles()) {
            nextSignatures.set(path, OperatorEnvCascade.statSignature(path));
        }

        // Ordered low -> high per {§operator-config-precedence}.
        const orderedFiles: Array<{ readonly path: string; readonly isOperatorFile: boolean }> = [
            { path: this.#operatorConfigFile, isOperatorFile: true },
            { path: this.#localConfigFile, isOperatorFile: true },
            ...(this.#configFile === null ? [] : [{ path: this.#configFile, isOperatorFile: true }]),
            ...this.#envFiles.map(({ path }) => ({ path, isOperatorFile: false })),
        ];

        const effective = new Map<string, string>();
        const sources = new Map<string, string>();
        for (const [key, { value, owner }] of this.#defaultsMap) {
            effective.set(key, value);
            sources.set(key, `defaults (${owner})`);
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
                effective.set(key, value);
                sources.set(key, path);
                fileWinners.set(key, { value, source: path });
            }
        }

        for (const [key, value] of Object.entries(this.#bootEnv)) {
            effective.set(key, value);
            const def = this.#defaultsMap.get(key);
            const fw = fileWinners.get(key);
            if (def !== undefined && value === def.value && (fw === undefined || fw.value === value)) {
                sources.set(key, `defaults (${def.owner})`);
            } else {
                sources.set(key, "process environment");
            }
        }

        for (const [key, { value, flagName }] of this.#cliFlags) {
            effective.set(key, value);
            sources.set(key, `flag:${flagName}`);
        }

        const restartRequired: BindTimeDrift[] = [];
        if (this.#pinnedBindValues !== null) {
            const candidateBindKeys = new Set<string>([
                ...this.#pinnedBindValues.keys(),
                ...[...effective.keys()].filter((k) => OperatorEnvCascade.isBindTimeKey(k)),
                ...[...fileWinners.keys()].filter((k) => OperatorEnvCascade.isBindTimeKey(k)),
            ]);
            for (const key of [...candidateBindKeys].toSorted()) {
                const pinned = this.#pinnedBindValues.get(key) ?? { value: undefined, source: undefined, fileValue: undefined };
                const candidateValue = effective.get(key);
                const fw = fileWinners.get(key);
                const fileChangedAgainstBoot = fw !== undefined && fw.value !== pinned.fileValue && fw.value !== pinned.value;
                if (candidateValue === pinned.value && !fileChangedAgainstBoot) continue;
                const candidateSource = fileChangedAgainstBoot && fw !== undefined
                    ? fw.source
                    : (sources.get(key) ?? this.#operatorConfigFile);
                if (pinned.value === undefined) {
                    effective.delete(key);
                    sources.delete(key);
                } else {
                    effective.set(key, pinned.value);
                    if (pinned.source !== undefined) sources.set(key, pinned.source);
                    else sources.delete(key);
                }
                restartRequired.push({
                    key,
                    source: candidateSource,
                    message: `${key} changed in ${candidateSource}; restart the daemon to apply.`,
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
        this.#sources = sources;
        this.#fileWinners = fileWinners;
        this.#signatures = nextSignatures;
        this.#restartRequired = restartRequired;
        this.#generation += 1;

        return {
            changed: true,
            generation: this.#generation,
            operatorFiles: operatorFileContents,
            undeclared,
            parseErrors,
            restartRequired,
        };
    }
}

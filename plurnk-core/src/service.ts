#!/usr/bin/env node

// oxlint-disable-next-line import/no-unassigned-import -- {§startup-admission}: it must evaluate before every later import
import "./core/runtime-guard.ts";
import { parseArgs, parseEnv } from "node:util";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isIPv6 } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import SqlRite from "@possumtech/sqlrite";
import { errnoCode } from "@plurnk/plurnk-contracts";
import type { Db } from "./core/Db.ts";
import { sqlFunctionPaths } from "./core/sql-functions.ts";
import { sqliteSynchronous } from "./core/sqlite-synchronous.ts";
import Daemon from "./server/Daemon.ts";
import HttpListener from "./server/HttpListener.ts";
import DaemonLock, { type DaemonStatus } from "./server/DaemonLock.ts";
import ServiceHelp from "./core/ServiceHelp.ts";
import EnvDefaults from "./core/env-defaults.ts";
import EnvCatalog from "./core/env-catalog.ts";
import HostPaths from "./core/HostPaths.ts";
import OperatorConfig from "./core/OperatorConfig.ts";
import OperatorEnvCascade, { type CascadeReloadResult, type CliFlagOverride } from "./core/OperatorEnvCascade.ts";
import Meta, { ConfigurationError } from "@plurnk/plurnk-meta";
import { formatModelReadinessCauses, parseAliasesFromEnv, resolveActiveRoute, resolveChildRoute, routeReadiness } from "@plurnk/plurnk-providers";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import ServiceModules from "./server/ServiceModules.ts";
import { discoverDaemonModules } from "./server/module-discovery.ts";
import ConfigurationDiagnostics from "./server/ConfigurationDiagnostics.ts";
import { workspacePaths } from "./server/AgentRoots.ts";
import { formatBuildInfo, getBuildInfo } from "./build-info.ts";
import ServiceTeardown from "./core/ServiceTeardown.ts";
import Paths from "./Paths.ts";
import { Digest, Share } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import ProviderInstantiate from "./core/ProviderInstantiate.ts";
import { loadCatalogCache } from "@plurnk/plurnk-models";
import ServiceUpdater from "./core/ServiceUpdater.ts";
import ExecEnv from "./schemes/exec-env.ts";

// How often `stop` looks for the signalled process to be gone.
const STOP_POLL_MS = 100;

const RELOADABLE_DIAGNOSTIC_OWNERS = new Set([
    "operator-env",
    "credentials",
    "bind-time",
    "model-aliases",
    "model",
    "model-child",
    "file-creation",
    "effect-policy",
    "proposal-policy",
    "wait",
    "execution",
    "executor-config",
    "updater",
    "notifications",
    "retention",
    "workspace-config",
]);

export interface SystemdUnitProbeResult {
    readonly activeState?: string;
    readonly subState?: string;
    readonly mainPid?: number;
}

export interface SystemdUnitInspection {
    readonly scope: "user" | "system";
    readonly path: string;
    readonly installed: boolean;
    readonly activeState?: string;
    readonly subState?: string;
    readonly mainPid?: number;
    readonly ownsDaemon: boolean;
}

// The `plurnk-service` executable: launches the daemon (start) or applies the schema baseline.
// Not the user-facing client — that is the separate `plurnk` project.
export default class Service {
    // This file's own directory holds the runtime code + its .sql (src/ in dev, dist/ in a
    // published install); its parent is the package root (migrations/, .env.defaults).
    static #codeDir = dirname(fileURLToPath(import.meta.url));
    static #projectRoot = resolve(Service.#codeDir, "..");
    static #hostPaths = new HostPaths();
    static #configuration = new ConfigurationDiagnostics();
    static #cascade: OperatorEnvCascade | null = null;
    static #defaultsMap = new Map<string, { value: string; owner: string }>();
    static #declares: (key: string) => boolean = () => false;

    // The node_modules holding the service's extension deps (exec/scheme/mimetype), resolved
    // from this file's REAL location by the shared membership walk. Falls back to CWD.
    static #installedNodeModules(): string {
        return Meta.nearestNodeModules(Service.#codeDir) ?? resolve(process.cwd(), "node_modules");
    }

    static #die(code: number, message: string): never {
        process.stderr.write(`${message}\n`);
        process.exit(code);
    }

    // Node loads pre-script env-file flags itself. The published bin receives post-script
    // flags here; main traverses them in reverse so loadEnvFile's set-if-unset behavior gives
    // both forms the same later-file-wins ordering ({§operator-config-precedence}).
    static #envFileArgs(): Array<{ path: string; required: boolean }> {
        return process.argv.flatMap((a): Array<{ path: string; required: boolean }> => {
            if (a.startsWith("--env-file-if-exists=")) return [{ path: a.slice(a.indexOf("=") + 1), required: false }];
            if (a.startsWith("--env-file=")) return [{ path: a.slice(a.indexOf("=") + 1), required: true }];
            return [];
        });
    }

    static #configFileArg(): string | null {
        const index = process.argv.findIndex((arg) => arg === "--config" || arg.startsWith("--config="));
        if (index === -1) return null;
        const arg = process.argv[index];
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : process.argv[index + 1];
        return value === undefined ? null : Service.#hostPaths.expandUserPath(value);
    }

    static #requireEnv(name: string): string {
        const value = process.env[name];
        if (value === undefined || value.length === 0) Service.#die(78, `missing required env ${name} (declare it in .env.defaults)`);
        return value;
    }

    static #databasePath(): string {
        const configured = process.env.PLURNK_SERVICE_DB_PATH;
        return configured === undefined || configured.length === 0
            ? Service.#hostPaths.databaseFile
            : resolve(Service.#hostPaths.expandUserPath(configured));
    }

    static assertRouteReady(
        route: ProviderSpec,
        env: NodeJS.ProcessEnv = process.env,
        key: "PLURNK_MODEL" | "PLURNK_MODEL_CHILD" = "PLURNK_MODEL",
    ): void {
        const readiness = routeReadiness(route, env);
        if (readiness === null || readiness.ready) return;
        const requirements = formatModelReadinessCauses(readiness);
        const label = route.alias === undefined
            ? `${route.provider}/${route.model}`
            : `${route.alias} (${route.provider}/${route.model})`;
        throw new ConfigurationError(
            key,
            `${key} selects ${label}, which requires ${requirements} in the daemon environment.`,
        );
    }

    static #modelConfiguration(): {
        readonly aliases: ReturnType<typeof parseAliasesFromEnv>;
        readonly active: ReturnType<typeof resolveActiveRoute>;
    } {
        const aliases = parseAliasesFromEnv(process.env);
        const active = resolveActiveRoute(process.env);
        const child = resolveChildRoute(process.env);
        if (active !== null) Service.assertRouteReady(active, process.env, "PLURNK_MODEL");
        if (child !== null) Service.assertRouteReady(child, process.env, "PLURNK_MODEL_CHILD");
        return { aliases, active };
    }

    static #formatModelRoute(route: ProviderSpec | null): string {
        if (route === null) return "not selected";
        const exact = `${route.provider}/${route.model}`;
        return route.alias === undefined ? exact : `${route.alias}=${exact}`;
    }

    static async #validateConfiguration(): Promise<void> {
        sqliteSynchronous();
        Daemon.validateConfiguration();
        Daemon.validateWorkspaceConfiguration();
        await ServiceModules.validateConfiguration(workspacePaths(Service.#hostPaths, process.cwd()).configurationRoots.map(({ directory }) => directory));
        // {§module-contract} — a discovered module validates its own configuration as its factory
        // constructs it; the offline check constructs every one, starts none, and fails on what any
        // contained ({§module-contract}).
        const { modules, configurationErrors } = await discoverDaemonModules({ cwd: dirname(Service.#installedNodeModules()), hostPaths: Service.#hostPaths });
        const causes = [
            ...configurationErrors.map(({ cause }) => cause),
            ...modules.flatMap(({ module }) => (module.contained ?? []).map(({ key, message }) => new ConfigurationError(key, message))),
        ];
        if (causes.length > 0) throw new Error(causes.map(({ message }) => message).join("\n"), { cause: causes[0] });
    }

    static async #ensureOperatorConfig(): Promise<void> {
        if (Service.#hostPaths.invalidXdg.length > 0) {
            process.stderr.write(
                `plurnk-service: ignored relative XDG variable(s): ${Service.#hostPaths.invalidXdg.join(", ")}; `
                + "run plurnk-service config check\n",
            );
        }
        if (await OperatorConfig.ensure(Service.#hostPaths, Paths.policy)) {
            process.stderr.write(
                `plurnk-service: created ${Service.#hostPaths.configDir} — edit ${Service.#hostPaths.configFile}; `
                + "run plurnk-service config defaults for every installed option\n",
            );
        }
    }

    static #sqliteKnob(name: string): number | undefined {
        const raw = process.env[name];
        if (raw === undefined || raw.trim() === "") return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n)) Service.#die(78, `${name} must be an integer, got ${JSON.stringify(raw)}`);
        return n;
    }

    static async #openDb(dbPath: string, exclusive: boolean = false): Promise<Db> {
        const synchronous = sqliteSynchronous();
        const tuning: Record<string, number> = {};
        for (const [env, opt] of [
            ["PLURNK_SERVICE_SQLITE_TIMEOUT", "timeout"],
            ["PLURNK_SERVICE_SQLITE_CACHE_SIZE", "cacheSize"],
            ["PLURNK_SERVICE_SQLITE_MMAP_SIZE", "mmapSize"],
            ["PLURNK_SERVICE_SQLITE_MAX_PAGE_COUNT", "maxPageCount"],
        ] as const) {
            const v = Service.#sqliteKnob(env);
            if (v !== undefined) tuning[opt] = v;
        }
        // sqlrite's own contract for the pool size; -1 is refused here, never read as "match cores".
        const readers = Service.#sqliteKnob("PLURNK_SERVICE_SQLITE_READERS");
        if (readers !== undefined) {
            if (!Number.isSafeInteger(readers) || readers < 0) {
                Service.#die(78, `PLURNK_SERVICE_SQLITE_READERS must be a non-negative integer (read-only database Sessions beside the writer), got ${readers}`);
            }
            tuning.readers = readers;
        }
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
        const lock = exclusive ? await DaemonLock.acquire(dbPath) : null;
        try {
            const db = await SqlRite.open({
                path: dbPath,
                synchronous,
                dir: [resolve(Service.#projectRoot, "migrations"), Service.#codeDir],
                functions: sqlFunctionPaths,
                ...tuning,
            });
            if (lock !== null) {
                const close = db.close.bind(db);
                db.close = async () => {
                    try {
                        await close();
                    } finally {
                        await lock.release();
                    }
                };
            }
            return db;
        } catch (cause) {
            await lock?.release();
            // SQLite's bare "disk I/O error" names neither file nor culprit. The classic footgun fails
            // exactly this way: the main DB was deleted while -wal/-shm sidecars survived (often still
            // held by a running daemon). Fail hard, legibly — name the path and the stale sidecars.
            const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`].filter((p) => existsSync(p));
            const hint = sidecars.length > 0
                ? ` — stale sidecar(s) present (${sidecars.join(", ")}): a prior daemon may still hold the old database; stop it and delete the sidecars`
                : "";
            // A missing column or table after migration means the shape disagrees with the version
            // ({§db-migrations}). Say so; the bare cause reads like a bug.
            const diagnosis = cause instanceof Error ? cause.message : String(cause);
            const baseline = /precedes the 5\.0\.0 support floor|is newer than this build/.test(diagnosis)
                ? ` — ${diagnosis}`
                : /^no such (?:column|table)\b|\bhas no column named\b/.test(diagnosis)
                    ? ` — the database shape disagrees with its schema version: point PLURNK_SERVICE_DB_PATH at a new file or move the database and its -wal and -shm sidecars aside once every daemon holding it has stopped ({§db-migrations})`
                    : "";
            throw new Error(`open ${dbPath} failed${hint}${baseline}`, { cause });
        }
    }

    static async #migrate(): Promise<void> {
        const dbPath = Service.#databasePath();
        const db = await Service.#openDb(dbPath, true);
        try { process.stdout.write(`migrated: ${dbPath}\n`); }
        finally { await db.close(); }
    }

    static #applyCascadeDiagnostics(
        result: CascadeReloadResult,
        runningDaemon = false,
    ): { readonly route: ProviderSpec | null; readonly routeText: string } {
        const configuration = Service.#configuration;
        configuration.clearReloadable(RELOADABLE_DIAGNOSTIC_OWNERS);
        for (const { key, file } of result.undeclared) configuration.undeclared(key, file);
        for (const err of result.parseErrors) configuration.record("operator-env", err);
        const bootEnv = Service.#cascade?.bootEnv ?? {};
        for (const drift of Service.detectCredentialDrift(bootEnv, result.operatorFiles, process.env)) {
            configuration.record("credentials", drift);
        }
        for (const item of result.restartRequired) {
            configuration.restartRequired(item.key, item.source, item.message);
        }
        configuration.captureSync("model-aliases", () => parseAliasesFromEnv());
        const route = configuration.captureSync("model", () => resolveActiveRoute());
        const childRoute = configuration.captureSync("model-child", () => resolveChildRoute());
        if (route !== null) {
            configuration.captureSync("model", () => Service.assertRouteReady(route, process.env, "PLURNK_MODEL"));
        }
        if (childRoute !== null) {
            configuration.captureSync("model-child", () => Service.assertRouteReady(childRoute, process.env, "PLURNK_MODEL_CHILD"));
        }
        if (runningDaemon) {
            Daemon.captureReloadableConfiguration(configuration, Service.#hostPaths);
        }
        const invalidModel = route === null && Boolean(process.env.PLURNK_MODEL);
        const routeText = invalidModel ? "invalid model configuration" : route === null ? "no model" : Service.#formatModelRoute(route);
        return { route, routeText };
    }

    // {§startup-admission} — client admission does not construct providers.
    static async #start(): Promise<void> {
        const cascade = Service.#cascade;
        if (cascade !== null) {
            const refreshed = cascade.refreshIfChanged({ force: true });
            Service.#applyCascadeDiagnostics(refreshed, false);
            cascade.pinBindTimeValues();
        }
        const dbPath = Service.#databasePath();
        const host = Service.#requireEnv("PLURNK_HOST");
        // {§http-host} — PLURNK_PORT is the daemon's one listener for all module mounts.
        const port = Number(Service.#requireEnv("PLURNK_PORT"));

        const configuration = Service.#configuration;
        await configuration.capture("model-aliases", () => parseAliasesFromEnv());
        const route = await configuration.capture("model", () => resolveActiveRoute());
        const childRoute = await configuration.capture("model-child", () => resolveChildRoute());
        if (route !== null) await configuration.capture("model", () => Service.assertRouteReady(route, process.env, "PLURNK_MODEL"));
        if (childRoute !== null) await configuration.capture("model-child", () => Service.assertRouteReady(childRoute, process.env, "PLURNK_MODEL_CHILD"));

        let daemon: Daemon | null = null;
        let admitted = false;
        let acpUrl = "";
        let healthUrl = "";
        let lockWriteChain = Promise.resolve();

        const queueLockAnnotation = (nextRouteText: string): Promise<void> => {
            if (!admitted || daemon === null) return lockWriteChain;
            const auth = daemon.credentials.operatorSecret !== null;
            const overrides = Object.fromEntries(
                Service.#resolvedEntries()
                    .filter((e) => e.overridden)
                    .map((e) => [e.key, { value: e.value, source: e.source }]),
            );
            const restartRequired = (Service.#cascade?.restartRequired ?? []).map((item) => item.message);
            lockWriteChain = lockWriteChain
                .then(() => DaemonLock.annotate(dbPath, {
                    reloadedAt: Date.now(),
                    acpUrl,
                    healthUrl,
                    auth,
                    route: nextRouteText,
                    overrides,
                    restartRequired,
                }))
                .catch(() => {});
            return lockWriteChain;
        };

        const reloadEnvironment = (options?: { readonly force?: boolean }): { readonly generation: number } => {
            if (cascade === null) return { generation: 0 };
            const result = cascade.refreshIfChanged(options);
            if (result.changed) {
                const { routeText: nextRouteText } = Service.#applyCascadeDiagnostics(result, true);
                void queueLockAnnotation(nextRouteText);
            }
            return { generation: cascade.generation };
        };

        // {§startup-admission}: the daemon's one listener wins the configured
        // address before anything may mutate durable state ({§http-host}). It answers 503
        // until daemon activation admits it, after every module has started.
        const listener = await HttpListener.bind({
            host,
            port,
            onHealthProbe: async () => {
                await daemon?.reloadEnvironmentNow();
                await lockWriteChain;
            },
        });
        let db: Db | null = null;
        const teardown = new ServiceTeardown(
            async (deadline) => { await daemon?.stop(deadline); },
            ["database close", async () => { await db?.close(); }],
            ["HTTP listener close", async () => { await listener.close(); }],
        );
        try {
            // {§startup-admission}: after listener ownership, persistence
            // and its exclusive owner precede capability activation.
            db = await Service.#openDb(dbPath, true);
            // {§observability-boundary} — the SDK is the plurnk-otel module's, discovered and set up with every
            // other module ({§otel-module}); the service loads none.
            daemon = new Daemon({
                db,
                dbPath,
                nodeModulesPath: Service.#installedNodeModules(),
                hostPaths: Service.#hostPaths,
                http: listener,
                configuration,
                reloadEnvironment,
            });
            // {§module-lifecycle} — the service composes no module: the daemon discovers every one,
            // and the socket never closes or rebinds between admission and readiness.
            await daemon.start();
            const acpAddr = listener.httpAddress();
            for (const notice of configuration.notices()) process.stderr.write(`plurnk-service: ${notice.message}\n`);
            // {§credential-authority} — the posture, and where a tool running as the operator finds the secret.
            process.stderr.write(daemon.credentials.operatorSecret === null
                ? "plurnk-service: authentication off (PLURNK_AUTH=0)\n"
                : daemon.secretFile === null
                    ? "plurnk-service: authentication on; PLURNK_SECRET is the configured operator secret\n"
                    : `plurnk-service: authentication on; the operator secret is in ${daemon.secretFile}\n`);
            const invalidModel = route === null && Boolean(process.env.PLURNK_MODEL);
            if (route === null && !invalidModel) {
                process.stderr.write(
                    `plurnk-service: no model configured — choose a profile in ${Service.#hostPaths.configFile}; `
                    + "run plurnk-service config defaults for every installed option. Loops fail legibly until then.\n",
                );
            }
            const routeText = invalidModel ? "invalid model configuration" : route === null ? "no model" : Service.#formatModelRoute(route);
            // {§startup-admission} — a URL (IPv6 in brackets), then two JSON strings: exact under spaces.
            const hostBracketed = isIPv6(acpAddr.host) ? `[${acpAddr.host}]` : acpAddr.host;
            acpUrl = `http://${hostBracketed}:${acpAddr.port}/acp`;
            healthUrl = `http://${hostBracketed}:${acpAddr.port}/health`;
            admitted = true;
            await queueLockAnnotation(routeText);
            process.stdout.write(`plurnk-service acp=${acpUrl} db=${JSON.stringify(dbPath)} route=${JSON.stringify(routeText)}\n`);

            process.on("SIGHUP", () => {
                void (async () => {
                    try {
                        await daemon?.reloadEnvironmentNow({ force: true });
                        await lockWriteChain;
                    } catch (cause) {
                        console.error("plurnk-service SIGHUP reload failed:", cause);
                    }
                })();
            });

            const shutdown = (): void => {
                teardown.request(
                    (cause) => {
                        process.exitCode = 1;
                        process.stderr.write(
                            ServiceTeardown.diagnostic("plurnk-service shutdown", cause),
                            () => process.exit(1),
                        );
                    },
                    // {§module-shutdown-order} — a clean teardown ends the process itself: a handle an
                    // abandoned wait left alive must never keep a stopped daemon running (#823).
                    () => process.exit(process.exitCode ?? 0),
                );
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        } catch (cause) {
            await teardown.fail(cause);
        }
    }

    // {§startup-admission} SIGTERM to the process that holds the configured database, then wait for it to
    // exit: its own shutdown is bounded by PLURNK_SERVICE_STOP_TIMEOUT_MS ({§module-shutdown-order}).
    static async #stop(): Promise<void> {
        const dbPath = Service.#hostPaths.configuredDatabasePath();
        const pid = await DaemonLock.owner(dbPath);
        if (pid === null) {
            process.stderr.write(`plurnk-service: not running (${dbPath})\n`);
            return;
        }
        try { process.kill(pid, "SIGTERM"); }
        catch (cause) { if (errnoCode(cause) !== "ESRCH") throw cause; }
        while (DaemonLock.alive(pid)) await sleep(STOP_POLL_MS);
        process.stderr.write(`plurnk-service: stopped pid ${pid} (${dbPath})\n`);
    }

    // {§startup-admission} {§operator-config-precedence} Validate configuration, signal SIGHUP to the
    // running daemon, and synchronize through its /health reload barrier.
    static async #reload(): Promise<void> {
        if (Service.#hostPaths.invalidXdg.length > 0) {
            throw new Error(
                `relative XDG variable(s) are invalid and ignored: ${Service.#hostPaths.invalidXdg.join(", ")}`,
            );
        }
        const unavailable = Service.#configuration.notices().filter(({ level }) => level === "warn" || level === "error");
        if (unavailable.length > 0) throw new Error(unavailable.map(({ message }) => message).join("\n"));
        const { active } = Service.#modelConfiguration();
        await Service.#validateConfiguration();

        const candidateDbPaths = [...new Set([Service.#databasePath(), Service.#hostPaths.databaseFile])];
        let dbPath = candidateDbPaths[0];
        let daemonStatus: DaemonStatus | null = null;
        for (const candidate of candidateDbPaths) {
            const found = await DaemonLock.status(candidate);
            if (found !== null) {
                dbPath = candidate;
                daemonStatus = found;
                break;
            }
        }
        if (daemonStatus === null) {
            throw new Error(`daemon is not running (${dbPath})`);
        }
        try {
            process.kill(daemonStatus.pid, "SIGHUP");
        } catch (cause) {
            if (errnoCode(cause) === "ESRCH") throw new Error(`daemon is not running (${dbPath})`, { cause });
            throw cause;
        }
        if (daemonStatus.healthUrl !== undefined) {
            await fetch(daemonStatus.healthUrl).catch(() => {});
        } else {
            await sleep(STOP_POLL_MS);
        }
        const updated = (await DaemonLock.status(dbPath)) ?? daemonStatus;
        const staleFiles = Service.staleOperatorFiles(updated, Service.#operatorFiles());
        const restartRequired = Service.formatRestartRequired(updated, staleFiles);
        for (const notice of Service.#configuration.notices()) process.stderr.write(`${notice.message}\n`);
        if (restartRequired !== null) process.stderr.write(`${restartRequired}\n`);
        process.stdout.write(`reloaded: pid ${updated.pid} (model=${updated.route ?? Service.#formatModelRoute(active)})\n`);
    }

    static isSecretKey(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
        if (key === "OTEL_EXPORTER_OTLP_HEADERS") return true;
        if (/(?:^|_)(?:SECRET|PASS|PASSWORD|TOKEN|API_KEY|BEARER)$/u.test(key)) return true;
        if (!key.startsWith("PLURNK_") && ExecEnv.ownSecretTest(env)(key)) return true;
        return false;
    }

    static detectCredentialDrift(
        initialEnv: NodeJS.ProcessEnv,
        files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
        env: NodeJS.ProcessEnv = process.env,
    ): ConfigurationError[] {
        const errors: ConfigurationError[] = [];
        const seen = new Set<string>();
        for (const { path, content } of files) {
            const parsed = parseEnv(content);
            for (const [key, fileValue] of Object.entries(parsed)) {
                if (fileValue === undefined || fileValue.length === 0) continue;
                if (!Service.isSecretKey(key, env)) continue;
                const shellValue = initialEnv[key];
                if (shellValue === undefined || shellValue.length === 0 || shellValue === fileValue) continue;
                const id = `${key}\0${path}`;
                if (seen.has(id)) continue;
                seen.add(id);
                errors.push(new ConfigurationError(
                    key,
                    `Credential drift for \`${key}\`: process environment and ${path} have different values (process environment wins in this cascade; keep each credential in one authoritative store).`,
                ));
            }
        }
        return errors;
    }

    static #fileMtimeMs(path: string): number | null {
        try {
            return existsSync(path) ? statSync(path).mtimeMs : null;
        } catch {
            return null;
        }
    }

    // {§installation} {§operator-config-precedence}: operator files hot-reload in a running daemon,
    // advancing `reloadedAt`; files newer than `reloadedAt ?? startedAt` have not yet been reloaded,
    // and bind-time key changes or boot-override drift require a daemon restart.
    static staleOperatorFiles(
        daemonStatus: DaemonStatus | null,
        files: readonly string[],
        mtimeMs: (path: string) => number | null = Service.#fileMtimeMs,
    ): string[] {
        const baseline = daemonStatus?.reloadedAt ?? daemonStatus?.startedAt;
        if (baseline === undefined) return [];
        const out: string[] = [];
        for (const file of new Set(files)) {
            const mtime = mtimeMs(file);
            if (mtime !== null && mtime > baseline) out.push(file);
        }
        return out;
    }

    static formatRestartRequired(
        daemonStatus: DaemonStatus | null,
        staleFiles: readonly string[],
        overridesDiffer = false,
    ): string | null {
        if (daemonStatus === null) return null;
        if (daemonStatus.restartRequired !== undefined && daemonStatus.restartRequired.length > 0) {
            return `restart required: ${daemonStatus.restartRequired.join(" ")}`;
        }
        if (staleFiles.length > 0) {
            return `restart required: ${staleFiles.join(", ")} modified after daemon (pid ${daemonStatus.pid}) started; restart the daemon for changes to take effect`;
        }
        if (overridesDiffer) {
            return `restart required: current configuration differs from running daemon (pid ${daemonStatus.pid}); restart the daemon for changes to take effect`;
        }
        return null;
    }

    static #probeSystemdUnit(scope: "user" | "system"): SystemdUnitProbeResult | null {
        try {
            const args = [
                ...(scope === "user" ? ["--user"] : []),
                "show",
                "--property=ActiveState,SubState,MainPID",
                "--",
                "plurnk.service",
            ];
            const out = execFileSync("systemctl", args, {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const props = new Map<string, string>();
            for (const line of out.split("\n")) {
                const eq = line.indexOf("=");
                if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
            }
            const activeState = props.get("ActiveState");
            const subState = props.get("SubState");
            const rawPid = Number(props.get("MainPID") ?? "0");
            const mainPid = Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
            return {
                ...(activeState ? { activeState } : {}),
                ...(subState ? { subState } : {}),
                ...(mainPid !== undefined ? { mainPid } : {}),
            };
        } catch {
            return null;
        }
    }

    // {§installation}: report installed user and system systemd units and whether either unit's MainPID owns the daemon.
    static inspectSystemdUnits({
        userUnitPath = Service.#hostPaths.userSystemdUnitFile,
        systemUnitPath = Service.#hostPaths.systemSystemdUnitFile,
        daemonPid = null,
        exists = existsSync,
        probe = Service.#probeSystemdUnit,
    }: {
        readonly userUnitPath?: string;
        readonly systemUnitPath?: string;
        readonly daemonPid?: number | null;
        readonly exists?: (path: string) => boolean;
        readonly probe?: (scope: "user" | "system") => SystemdUnitProbeResult | null;
    } = {}): SystemdUnitInspection[] {
        const units: SystemdUnitInspection[] = [];
        for (const [scope, path] of [
            ["user", userUnitPath],
            ["system", systemUnitPath],
        ] as const) {
            if (!exists(path)) {
                units.push({ scope, path, installed: false, ownsDaemon: false });
                continue;
            }
            const probed = probe(scope);
            const mainPid = probed?.mainPid !== undefined && probed.mainPid > 0 ? probed.mainPid : undefined;
            const ownsDaemon = daemonPid != null && daemonPid > 0 && mainPid === daemonPid;
            units.push({
                scope,
                path,
                installed: true,
                ...(probed?.activeState ? { activeState: probed.activeState } : {}),
                ...(probed?.subState ? { subState: probed.subState } : {}),
                ...(mainPid !== undefined ? { mainPid } : {}),
                ownsDaemon,
            });
        }
        return units;
    }

    static formatSystemdLines(
        units: readonly SystemdUnitInspection[],
        daemonPid: number | null = null,
    ): string[] {
        const installed = units.filter((u) => u.installed);
        if (installed.length === 0) return ["systemd: no unit installed"];
        return installed.map((unit) => {
            const state = unit.activeState
                ? unit.subState ? `${unit.activeState} (${unit.subState})` : unit.activeState
                : "installed";
            const details = [state];
            if (unit.mainPid !== undefined) details.push(`main pid ${unit.mainPid}`);
            if (unit.ownsDaemon) {
                details.push("owns daemon");
            } else if ((daemonPid != null && daemonPid > 0) || installed.length > 1) {
                details.push("does not own daemon");
            }
            return `systemd ${unit.scope} unit: ${unit.path} (${details.join(", ")})`;
        });
    }

    static #operatorFiles(): string[] {
        const configFile = Service.#configFileArg();
        return [
            ...(configFile === null ? [] : [resolve(configFile)]),
            Service.#hostPaths.configFile,
            Service.#hostPaths.localConfigFile,
        ];
    }

    static #resolvedEntries(): Array<{
        readonly key: string;
        readonly value: string;
        readonly source: string;
        readonly overridden: boolean;
    }> {
        const entries: Array<{
            readonly key: string;
            readonly value: string;
            readonly source: string;
            readonly overridden: boolean;
        }> = [];
        const sources = Service.#cascade?.sources;
        for (const key of Object.keys(process.env).toSorted()) {
            const rawValue = process.env[key];
            if (rawValue === undefined) continue;
            const source = sources?.get(key) ?? "process environment";
            const def = Service.#defaultsMap.get(key);
            const fromLayer = source !== "process environment" && !source.startsWith("defaults (");
            const isProviderKey = !key.startsWith("PLURNK_") && ExecEnv.ownSecretTest(process.env)(key);
            if (def === undefined && !Service.#declares(key) && !fromLayer && !key.startsWith("OTEL_") && !isProviderKey) {
                continue;
            }
            const overridden = def === undefined || rawValue !== def.value || !source.startsWith("defaults (");
            const value = rawValue.length > 0 && Service.isSecretKey(key) ? "<redacted>" : rawValue;
            entries.push({ key, value, source, overridden });
        }
        return entries;
    }

    static async #liveDaemonStatus(dbPath: string): Promise<DaemonStatus | null> {
        const initial = await DaemonLock.status(dbPath);
        if (
            initial !== null
            && initial.healthUrl !== undefined
            && Service.staleOperatorFiles(initial, Service.#operatorFiles()).length > 0
        ) {
            await fetch(initial.healthUrl).catch(() => {});
            return (await DaemonLock.status(dbPath)) ?? initial;
        }
        return initial;
    }

    static async #configStatus(showAll = false, json = false): Promise<void> {
        const diagnostics = Service.#configuration;
        const aliases = await diagnostics.capture("model-aliases", () => parseAliasesFromEnv());
        const active = await diagnostics.capture("model", () => resolveActiveRoute());
        const child = await diagnostics.capture("model-child", () => resolveChildRoute());
        if (active !== null) await diagnostics.capture("model", () => Service.assertRouteReady(active, process.env, "PLURNK_MODEL"));
        if (child !== null) await diagnostics.capture("model-child", () => Service.assertRouteReady(child, process.env, "PLURNK_MODEL_CHILD"));
        const dbPath = Service.#databasePath();
        const daemonStatus = await Service.#liveDaemonStatus(dbPath);
        const systemdUnits = Service.inspectSystemdUnits({ daemonPid: daemonStatus?.pid ?? null });
        const entries = Service.#resolvedEntries();
        const overridden = entries.filter((e) => e.overridden);
        const currentOverridesMap = Object.fromEntries(overridden.map((e) => [e.key, { value: e.value, source: e.source }]));
        const daemonOverridesDiffer = daemonStatus?.overrides !== undefined
            && JSON.stringify(daemonStatus.overrides) !== JSON.stringify(currentOverridesMap);
        const staleFiles = Service.staleOperatorFiles(daemonStatus, Service.#operatorFiles());
        const restartRequired = Service.formatRestartRequired(daemonStatus, staleFiles, daemonOverridesDiffer);
        const modelText = active === null && process.env.PLURNK_MODEL ? "invalid configuration" : Service.#formatModelRoute(active);
        if (json) {
            process.stdout.write(`${JSON.stringify({
                configFile: Service.#hostPaths.configFile,
                localConfigFile: Service.#hostPaths.localConfigFile,
                database: dbPath,
                daemon: daemonStatus,
                restartRequired: restartRequired !== null,
                staleConfigFiles: staleFiles,
                systemd: systemdUnits,
                model: modelText,
                declaredAliases: aliases === null ? null : aliases.map(({ alias }) => alias),
                templates: {
                    installGuide: Paths.configuration,
                    systemdUnit: Paths.systemdUnit,
                    nginxConfig: Paths.nginxConfig,
                },
                entries: showAll ? entries : overridden,
            }, null, 2)}\n`);
        } else if (showAll) {
            const lines = entries.map((e) => `${e.key}=${e.value}  # ${e.source}`);
            process.stdout.write(`${lines.join("\n")}\n`);
        } else {
            const explicitFiles = Service.#envFileArgs().map(({ path }) => resolve(Service.#hostPaths.expandUserPath(path)));
            const configFile = Service.#configFileArg();
            const daemonLine = daemonStatus === null
                ? `daemon: not running (${dbPath})`
                : `daemon: running (pid ${daemonStatus.pid}${daemonStatus.acpUrl ? `, acp=${daemonStatus.acpUrl}` : ""}${daemonStatus.healthUrl ? `, health=${daemonStatus.healthUrl}` : ""}${daemonStatus.auth === undefined ? "" : `, auth=${daemonStatus.auth ? "on" : "off"}`}${daemonStatus.route ? `, model=${daemonStatus.route}` : ""})`;
            const daemonOverrideEntries = daemonStatus?.overrides === undefined ? [] : Object.entries(daemonStatus.overrides);
            const lines = [
                `config: ${Service.#hostPaths.configFile} (${existsSync(Service.#hostPaths.configFile) ? "present" : "absent"})`,
                daemonLine,
                ...(restartRequired === null ? [] : [restartRequired]),
                ...Service.formatSystemdLines(systemdUnits, daemonStatus?.pid ?? null),
                "sources (low -> high):",
                "  package .env.defaults floor",
                `  ${Service.#hostPaths.configFile}${existsSync(Service.#hostPaths.configFile) ? "" : " (absent)"}`,
                ...(existsSync(Service.#hostPaths.localConfigFile) ? [`  ${Service.#hostPaths.localConfigFile}`] : []),
                ...(configFile === null ? [] : [`  ${resolve(configFile)}${existsSync(configFile) ? "" : " (absent)"}`]),
                ...explicitFiles.map((path) => `  ${path}${existsSync(path) ? "" : " (absent)"}`),
                "  process environment",
                "  CLI flags",
                `model: ${modelText}`,
                `declared aliases: ${aliases === null ? "unavailable" : aliases.length === 0 ? "none" : aliases.map(({ alias }) => alias).join(", ")}`,
                `database: ${dbPath}`,
                ...(overridden.length === 0
                    ? ["overrides: none"]
                    : [
                        "overrides:",
                        ...overridden.map((e) => `  ${e.key}=${e.value}  # ${e.source}`),
                    ]),
                ...(daemonOverridesDiffer
                    ? [
                        daemonOverrideEntries.length === 0
                            ? "daemon overrides (at boot): none"
                            : "daemon overrides (at boot):",
                        ...daemonOverrideEntries.map(([k, v]) => `  ${k}=${v.value}  # ${v.source}`),
                    ]
                    : []),
                "templates:",
                `  install guide: ${Paths.configuration}`,
                `  systemd unit template (user scope): ${Paths.systemdUnit} (skill://plurnk/configuration/plurnk.service)`,
                `  nginx reverse proxy: ${Paths.nginxConfig} (skill://plurnk/configuration/plurnk.nginx.conf)`,
                "effective: plurnk-service config show",
                "defaults: plurnk-service config defaults",
                "validation: plurnk-service config check",
            ];
            process.stdout.write(`${lines.join("\n")}\n`);
        }
        for (const notice of diagnostics.notices()) process.stderr.write(`${notice.message}\n`);
    }

    static async #configCheck(): Promise<void> {
        if (Service.#hostPaths.invalidXdg.length > 0) {
            throw new Error(
                `relative XDG variable(s) are invalid and ignored: ${Service.#hostPaths.invalidXdg.join(", ")}`,
            );
        }
        const unavailable = Service.#configuration.notices().filter(({ level }) => level === "warn" || level === "error");
        if (unavailable.length > 0) throw new Error(unavailable.map(({ message }) => message).join("\n"));
        const { aliases, active } = Service.#modelConfiguration();
        await Service.#validateConfiguration();
        const daemonStatus = await Service.#liveDaemonStatus(Service.#databasePath());
        const staleFiles = Service.staleOperatorFiles(daemonStatus, Service.#operatorFiles());
        const restartRequired = Service.formatRestartRequired(daemonStatus, staleFiles);
        for (const notice of Service.#configuration.notices()) process.stderr.write(`${notice.message}\n`);
        if (restartRequired !== null) process.stderr.write(`${restartRequired}\n`);
        process.stdout.write([
            "configuration valid",
            `config: ${Service.#hostPaths.configFile}`,
            `model: ${Service.#formatModelRoute(active)}`,
            `declared aliases: ${aliases.length === 0 ? "none" : aliases.map(({ alias }) => alias).join(", ")}`,
            `database: ${Service.#databasePath()}`,
            "provider requests: none",
            "",
        ].join("\n"));
    }

    static async #configEdit(): Promise<void> {
        const editor = process.env.VISUAL || process.env.EDITOR;
        if (editor === undefined || editor.length === 0) {
            throw new Error(
                `VISUAL and EDITOR are unset; edit ${Service.#hostPaths.configFile}, `
                + "then run plurnk-service config check",
            );
        }
        await new Promise<void>((resolvePromise, rejectPromise) => {
            // VISUAL/EDITOR conventionally permits a shell command with flags.
            // Keep the user-owned command semantics, but pass the config path as
            // a quoted positional so whitespace and shell characters stay data.
            const child = spawn(
                "/bin/sh",
                ["-c", `${editor} "$1"`, "plurnk-service config edit", Service.#hostPaths.configFile],
                { stdio: "inherit" },
            );
            child.once("error", rejectPromise);
            child.once("exit", (code, signal) => {
                if (code === 0) resolvePromise();
                else rejectPromise(new Error(`${editor} exited ${code ?? `on ${signal ?? "unknown signal"}`}`));
            });
        });
    }

    static async main(): Promise<void> {
        const bootEnv = OperatorEnvCascade.snapshotEnv(process.env);
        const envFiles = Service.#envFileArgs().map(({ path, required }) => ({
            path: Service.#hostPaths.expandUserPath(path),
            required,
        }));
        const configFile = Service.#configFileArg();

        // A flag is a knob's spelling for one invocation: the service's own panel, and the keys it
        // shares with every client ({§operator-config-precedence}), which contracts declares.
        const flagDescriptors = await ServiceHelp.flags();
        const flagOptions: Record<string, { type: "string" }> = {};
        for (const f of flagDescriptors) {
            flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
        }

        const usage = ServiceHelp.format(flagDescriptors);

        const { positionals, values } = parseArgs({
            allowPositionals: true,
            strict: false,
            options: {
                help: { type: "boolean", short: "h" },
                version: { type: "boolean", short: "v" },
                config: { type: "string" },
                json: { type: "boolean" },
                workspace: { type: "string" },
                requiem: { type: "boolean" },
                ...flagOptions,
            },
        });

        const cliFlags = new Map<string, CliFlagOverride>();
        for (const f of flagDescriptors) {
            const key = f.flagName.replace(/^--/, "");
            const v = values[key];
            if (typeof v === "string") {
                cliFlags.set(f.envName, { value: v, flagName: f.flagName });
            }
        }

        try {
            OperatorEnvCascade.applyBootFiles({
                bootEnv,
                envFiles,
                configFile,
                localConfigFile: Service.#hostPaths.localConfigFile,
                operatorConfigFile: Service.#hostPaths.configFile,
                cliFlags,
                env: process.env,
            });
        } catch (cause) {
            if (cause instanceof Error && "exitCode" in cause && typeof cause.exitCode === "number") {
                Service.#die(cause.exitCode, cause.message);
            }
            throw cause;
        }
        Service.#hostPaths = new HostPaths();

        if (values.help) { process.stdout.write(usage); process.exit(0); }
        const buildInfo = await getBuildInfo();
        if (values.version) {
            process.stdout.write(`${formatBuildInfo(buildInfo)}\n`);
            process.exit(0);
        }

        // Root/trust flags participate before extension defaults are admitted to the shared floor.
        const { files: defaultsFiles, configurationErrors, reports } = await EnvDefaults.collect(
            Service.#projectRoot, Service.#installedNodeModules(), { hostPaths: Service.#hostPaths },
        );
        for (const cause of configurationErrors) Service.#configuration.record("extensions", cause);
        Service.#configuration.pluginReports(reports);
        const mergedDefaults = EnvDefaults.merge(defaultsFiles);
        Service.#defaultsMap = mergedDefaults;
        // {§model-catalog-cache} — load cached models.dev snapshot if present.
        try { loadCatalogCache(Service.#hostPaths.modelsCacheFile); } catch { /* ignore unreadable cache on boot */ }
        // {§operator-config-precedence} — the operator's files, never the process environment.
        const declares = EnvCatalog.declares(defaultsFiles);
        Service.#declares = declares;
        const cascade = new OperatorEnvCascade({
            bootEnv,
            cliFlags,
            envFiles,
            configFile,
            localConfigFile: Service.#hostPaths.localConfigFile,
            operatorConfigFile: Service.#hostPaths.configFile,
            defaultsMap: mergedDefaults,
            declares,
            env: process.env,
        });
        Service.#cascade = cascade;
        const initialReload = cascade.refreshIfChanged({ force: true });
        for (const { key, file } of initialReload.undeclared) Service.#configuration.undeclared(key, file);
        for (const err of initialReload.parseErrors) Service.#configuration.record("operator-env", err);
        for (const drift of Service.detectCredentialDrift(bootEnv, initialReload.operatorFiles, process.env)) {
            Service.#configuration.record("credentials", drift);
        }

        const command = typeof positionals[0] === "string" ? positionals[0] : "start";
        const action = typeof positionals[1] === "string" ? positionals[1] : null;
        let name = command;
        let handler: (() => Promise<void>) | null = null;
        if (command === "start" || command === "migrate") {
            if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);
            await Service.#ensureOperatorConfig();
            handler = command === "start" ? Service.#start : Service.#migrate;
        } else if (command === "stop") {
            if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);
            handler = Service.#stop;
        } else if (command === "reload") {
            if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);
            handler = Service.#reload;
        } else if (command === "update") {
            if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);
            handler = async () => {
                const result = await ServiceUpdater.run({ hostPaths: Service.#hostPaths, buildInfo });
                process.stdout.write(`${ServiceUpdater.formatReport(result)}\n`);
            };
        } else if (command === "config") {
            if (positionals.length > 2) Service.#die(64, `unexpected arguments: ${positionals.slice(2).join(" ")}`);
            name = action === null ? "config" : `config ${action}`;
            if (action === "defaults") {
                handler = async () => {
                    process.stdout.write(EnvDefaults.renderCatalog(defaultsFiles));
                    for (const notice of Service.#configuration.notices()) process.stderr.write(`${notice.message}\n`);
                };
            } else if (action === "edit") {
                await Service.#ensureOperatorConfig();
                handler = Service.#configEdit;
            } else if (action === "check") {
                handler = Service.#configCheck;
            } else if (action === "show") {
                handler = () => Service.#configStatus(true, values.json === true);
            } else if (action === null) {
                handler = () => Service.#configStatus(false, values.json === true);
            }
        } else if (command === "share") {
            if (positionals.length > 3) Service.#die(64, `unexpected arguments: ${positionals.slice(3).join(" ")}`);
            const workspace = values.workspace;
            if (workspace !== undefined && (typeof workspace !== "string" || !/^[1-9]\d*$/u.test(workspace))) Service.#die(64, "--workspace takes a workspace id");
            handler = async () => {
                const dbPath = typeof positionals[1] === "string" ? positionals[1] : Service.#hostPaths.configuredDatabasePath();
                const folder = typeof positionals[2] === "string" ? positionals[2] : Service.#hostPaths.shareFolder();
                const provider = values.requiem === true ? await ProviderInstantiate.loadActiveProvider() : undefined;
                if (provider === null) throw new Error("no active provider - set PLURNK_MODEL; a requiem needs a witness to testify");
                const shared = await Share.write({ openEvidence: EvidenceReader.open,
                    dbPath, folder, requiem: provider,
                    ...(typeof workspace === "string" ? { workspaceId: Number(workspace) } : {}),
                });
                process.stdout.write(`${shared.folder}\n`);
                process.stderr.write("share: this holds what the models saw and wrote, unredacted; review it before sending.\n");
            };
        } else if (command === "requiem") {
            if (positionals.length !== 3) Service.#die(64, `requiem takes <file.db> <folder>\n\n${usage}`);
            handler = async () => {
                const { path, reportPath, sessions } = await Digest.requiem({ openEvidence: EvidenceReader.open, dbPath: positionals[1], digestDir: positionals[2], provider: await ProviderInstantiate.loadActiveProvider() });
                process.stdout.write(`requiem: interviewed ${sessions} session(s) -> ${path}, ${reportPath}\n`);
            };
        }
        if (handler === null) Service.#die(64, `unknown command: ${positionals.join(" ")}\n\n${usage}`);

        process.stderr.write(`plurnk-service: ${formatBuildInfo(buildInfo)}\n`);
        try { await handler(); }
        catch (cause) {
            process.stderr.write(ServiceTeardown.diagnostic(name, cause));
            process.exit(1);
        }
    }
}

if (import.meta.main) {
    await Service.main();
}

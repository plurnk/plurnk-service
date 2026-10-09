#!/usr/bin/env node

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIPv6 } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import SqlRite from "@possumtech/sqlrite";
import type { Db } from "./core/Db.ts";
import Daemon from "./server/Daemon.ts";
import HttpListener from "./server/HttpListener.ts";
import DaemonLock from "./server/DaemonLock.ts";
import EnvFlags from "./core/EnvFlags.ts";
import EnvDefaults from "./core/env-defaults.ts";
import EnvCatalog from "./core/env-catalog.ts";
import HostPaths from "./core/HostPaths.ts";
import OperatorConfig from "./core/OperatorConfig.ts";
import Meta, { ConfigurationError } from "@plurnk/plurnk-meta";
import { parseAliasesFromEnv, resolveActiveRoute, resolveChildRoute } from "@plurnk/plurnk-providers";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import ServiceModules from "./server/ServiceModules.ts";
import { discoverDaemonModules } from "./server/module-discovery.ts";
import ConfigurationDiagnostics from "./server/ConfigurationDiagnostics.ts";
import { workspacePaths } from "./server/AgentRoots.ts";
import { formatBuildInfo, getBuildInfo } from "./build-info.ts";
import ServiceTeardown from "./core/ServiceTeardown.ts";
import Paths from "./Paths.ts";
import { startObservability, validateObservabilityConfiguration } from "./observe/init.ts";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import ProviderInstantiate from "./core/ProviderInstantiate.ts";
import { Share } from "@plurnk/plurnk-digest";

// The `plurnk-service` executable: launches the daemon (start) or applies the schema baseline.
// Not the user-facing client — that is the separate `plurnk` project.
export default class Service {
    // This file's own directory holds the runtime code + its .sql (src/ in dev, dist/ in a
    // published install); its parent is the package root (migrations/, .env.defaults).
    static #codeDir = dirname(fileURLToPath(import.meta.url));
    static #projectRoot = resolve(Service.#codeDir, "..");
    static #ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    static #hostPaths = new HostPaths();
    static #configuration = new ConfigurationDiagnostics();

    // The node_modules holding the service's extension deps (exec/scheme/mimetype), resolved
    // from this file's REAL location by the shared membership walk. Falls back to CWD.
    static #installedNodeModules(): string {
        return Meta.nearestNodeModules(Service.#codeDir) ?? resolve(process.cwd(), "node_modules");
    }

    static #die(code: number, message: string): never {
        process.stderr.write(`${message}\n`);
        process.exit(code);
    }

    static #loadEnv(path: string, required: boolean): void {
        if (existsSync(path)) {
            try { process.loadEnvFile(path); }
            catch (cause) { Service.#die(64, `failed to load ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        } else if (required) {
            Service.#die(64, `${path} does not exist`);
        }
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
        const arg = process.argv[index]!;
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

    static #modelConfiguration(): {
        readonly aliases: ReturnType<typeof parseAliasesFromEnv>;
        readonly active: ReturnType<typeof resolveActiveRoute>;
    } {
        const aliases = parseAliasesFromEnv(process.env);
        const active = resolveActiveRoute(process.env);
        resolveChildRoute();
        return { aliases, active };
    }

    static #formatModelRoute(route: ProviderSpec | null): string {
        if (route === null) return "not selected";
        const exact = `${route.provider}/${route.model}`;
        return route.alias === undefined ? exact : `${route.alias}=${exact}`;
    }

    static async #validateConfiguration(): Promise<void> {
        Daemon.validateConfiguration();
        Daemon.validateWorkspaceConfiguration();
        await ServiceModules.validateConfiguration(workspacePaths(Service.#hostPaths, process.cwd()).configurationRoots.map(({ directory }) => directory));
        // {§module-self-activation} — a discovered module validates its own configuration as its factory
        // constructs it; the offline check constructs every one, starts none, and fails on what any
        // contained ({§module-contained-configuration}).
        const { modules, configurationErrors } = await discoverDaemonModules({ cwd: dirname(Service.#installedNodeModules()), hostPaths: Service.#hostPaths });
        const causes = [
            ...configurationErrors.map(({ cause }) => cause),
            ...modules.flatMap(({ module }) => (module.contained ?? []).map(({ key, message }) => new ConfigurationError(key, message))),
        ];
        if (causes.length > 0) throw new Error(causes.map(({ message }) => message).join("\n"), { cause: causes[0] });
        validateObservabilityConfiguration();
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
                Service.#die(78, `PLURNK_SERVICE_SQLITE_READERS must be a non-negative integer (read-only database Workers beside the writer), got ${readers}`);
            }
            tuning.readers = readers;
        }
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
        const lock = exclusive ? await DaemonLock.acquire(dbPath) : null;
        try {
            const db = await SqlRite.open({
                path: dbPath,
                dir: [resolve(Service.#projectRoot, "migrations"), Service.#codeDir],
                functions: [
                    resolve(Service.#codeDir, `core/content_weight${Service.#ext}`),
                    resolve(Service.#codeDir, `core/glob_match${Service.#ext}`),
                    resolve(Service.#codeDir, `core/sha256${Service.#ext}`),
                ],
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
            return db as unknown as Db;
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
            const baseline = /^no such (?:column|table)\b|\bhas no column named\b/.test(diagnosis)
                ? ` — the database shape disagrees with its schema version: a database from a newer release needs that release; one from an unreleased development build is deleted with its -wal and -shm sidecars once every daemon holding it has stopped`
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

    // {§startup-admission} — client admission does not construct providers.
    static async #start(): Promise<void> {
        const dbPath = Service.#databasePath();
        const host = Service.#requireEnv("PLURNK_HOST");
        // {§http-host} — PLURNK_PORT is the daemon's one listener for all module mounts.
        const port = Number(Service.#requireEnv("PLURNK_PORT"));

        const configuration = Service.#configuration;
        await configuration.capture("model-aliases", () => parseAliasesFromEnv());
        const route = await configuration.capture("model", () => resolveActiveRoute());
        await configuration.capture("model-child", () => resolveChildRoute());
        // {§startup-listener-admission}: the daemon's one listener wins the configured
        // address before anything may mutate durable state ({§http-host}). It answers 503
        // until daemon activation admits it, after every module has started.
        const listener = await HttpListener.bind({ host, port });
        let db: Db | null = null;
        let daemon: Daemon | null = null;
        let observability: Awaited<ReturnType<typeof startObservability>> = null;
        const teardown = new ServiceTeardown(
            async (deadline) => { await daemon?.stop(deadline); },
            ["observability shutdown", async () => { await observability?.shutdown(); }],
            ["database close", async () => { await db?.close(); }],
            ["HTTP listener close", async () => { await listener.close(); }],
        );
        try {
            // {§startup-admission-order}: after listener ownership, persistence
            // and its exclusive owner precede capability activation.
            db = await Service.#openDb(dbPath, true);
            // {§observability-boundary} — config is normalized before any SDK
            // implementation loads; teardown already owns the admitted DB.
            observability = await configuration.capture("observability", () => startObservability());
            daemon = new Daemon({ db, dbPath, nodeModulesPath: Service.#installedNodeModules(), hostPaths: Service.#hostPaths, http: listener, configuration });
            // {§module-discovery} — the service composes no module: the daemon discovers every one,
            // and the socket never closes or rebinds between admission and readiness.
            await daemon.start();
            const aguiAddr = listener.httpAddress();
            for (const notice of configuration.notices()) process.stderr.write(`plurnk-service: ${notice.message}\n`);
            const invalidModel = route === null && Boolean(process.env.PLURNK_MODEL);
            if (route === null && !invalidModel) {
                process.stderr.write(
                    `plurnk-service: no model configured — choose a profile in ${Service.#hostPaths.configFile}; `
                    + "run plurnk-service config defaults for every installed option. Loops fail legibly until then.\n",
                );
            }
            const routeText = invalidModel ? "invalid model configuration" : route === null ? "no model" : Service.#formatModelRoute(route);
            // {§startup-readiness-line} — a URL (IPv6 in brackets), then two JSON strings: exact under spaces.
            const aguiUrl = `http://${isIPv6(aguiAddr.host) ? `[${aguiAddr.host}]` : aguiAddr.host}:${aguiAddr.port}/agui`;
            process.stdout.write(`plurnk-service agui=${aguiUrl} db=${JSON.stringify(dbPath)} route=${JSON.stringify(routeText)}\n`);

            const shutdown = (): void => {
                teardown.request(
                    (cause) => {
                        process.exitCode = 1;
                        process.stderr.write(
                            ServiceTeardown.diagnostic("plurnk-service shutdown", cause),
                            () => process.exit(1),
                        );
                    },
                    // {§crash-only-stop} — a clean teardown ends the process itself: a handle an
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

    static async #configStatus(): Promise<void> {
        const diagnostics = Service.#configuration;
        const aliases = await diagnostics.capture("model-aliases", () => parseAliasesFromEnv());
        const active = await diagnostics.capture("model", () => resolveActiveRoute());
        await diagnostics.capture("model-child", () => resolveChildRoute());
        const explicitFiles = Service.#envFileArgs().map(({ path }) => resolve(Service.#hostPaths.expandUserPath(path)));
        const configFile = Service.#configFileArg();
        const lines = [
            `config: ${Service.#hostPaths.configFile} (${existsSync(Service.#hostPaths.configFile) ? "present" : "absent"})`,
            "sources (low -> high):",
            "  package .env.defaults floor",
            `  ${Service.#hostPaths.configFile}${existsSync(Service.#hostPaths.configFile) ? "" : " (absent)"}`,
            ...(configFile === null ? [] : [`  ${resolve(configFile)}${existsSync(configFile) ? "" : " (absent)"}`]),
            ...explicitFiles.map((path) => `  ${path}${existsSync(path) ? "" : " (absent)"}`),
            "  process environment",
            "  CLI flags",
            `model: ${active === null && process.env.PLURNK_MODEL ? "invalid configuration" : Service.#formatModelRoute(active)}`,
            `declared aliases: ${aliases === null ? "unavailable" : aliases.length === 0 ? "none" : aliases.map(({ alias }) => alias).join(", ")}`,
            `database: ${Service.#databasePath()}`,
            "defaults: plurnk-service config defaults",
            "validation: plurnk-service config check",
        ];
        process.stdout.write(`${lines.join("\n")}\n`);
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
        await Service.#validateConfiguration();
        for (const notice of Service.#configuration.notices()) process.stderr.write(`${notice.message}\n`);
        const { aliases, active } = Service.#modelConfiguration();
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
        // loadEnvFile is set-if-unset, so every service-owned layer loads high→low. Within the
        // repeatable env-file tier, loading last→first preserves Node's later-file-wins order.
        // {§operator-config-precedence}
        for (const { path: envFile, required } of Service.#envFileArgs().toReversed()) {
            Service.#loadEnv(Service.#hostPaths.expandUserPath(envFile), required);
        }

        const configFile = Service.#configFileArg();

        if (configFile !== null) Service.#loadEnv(configFile, true);
        Service.#loadEnv(Service.#hostPaths.configFile, false);
        // A flag is a knob's spelling for one invocation: the service's own panel, and the keys it
        // shares with every client ({§operator-config-shared-keys}), which contracts declares.
        const flagDescriptors = [
            ...await EnvFlags.parseEnvDefaults(resolve(Service.#projectRoot, ".env.defaults")),
            ...await EnvFlags.parseEnvDefaults(Paths.sharedDefaults),
        ];
        const flagOptions: Record<string, { type: "string" }> = {};
        for (const f of flagDescriptors) {
            flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
        }

        const usage = `usage: plurnk-service [options] [start|migrate]
       plurnk-service [options] config [edit|defaults|check]
       plurnk-service [options] share [<file.db>] [<folder>] [--workspace=<id>] [--requiem]
       plurnk-service [options] requiem <file.db> <folder>

${EnvFlags.formatFlagsHelp(flagDescriptors)}

  --env-file=<path>            layer env from <path> (repeatable; later wins; errors if missing)
  --env-file-if-exists=<path>  layer env from <path> if present (repeatable; later wins)
  --config=<path>              layer additional env from <path>
  config defaults             print every installed package's annotated .env.defaults
  config check                validate configuration without contacting a provider
  share                        share a consistent copy of the database as a digest <folder>
                               (default database: the service's; default folder: a stamped child
                               of PLURNK_SERVICE_SHARE_FOLDER); --workspace=<id> limits it to one
                               workspace; --requiem adds the forensic interview (calls a model)
  requiem                      add the forensic interview to a digest <folder> of <file.db> (calls a model)
  -v, --version                show executable provenance
  -h, --help                   show this help
`;

        const { positionals, values } = parseArgs({
            allowPositionals: true,
            strict: false,
            options: {
                help: { type: "boolean", short: "h" },
                version: { type: "boolean", short: "v" },
                config: { type: "string" },
                workspace: { type: "string" },
                requiem: { type: "boolean" },
                ...flagOptions,
            },
        });

        for (const f of flagDescriptors) {
            const key = f.flagName.replace(/^--/, "");
            const v = values[key];
            if (typeof v === "string") process.env[f.envName] = v;
        }

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
        EnvDefaults.apply(EnvDefaults.merge(defaultsFiles));
        // {§operator-config-undeclared-key} — the operator's files, never the process environment.
        const declares = EnvCatalog.declares(defaultsFiles);
        for (const file of new Set([...(configFile === null ? [] : [resolve(configFile)]), Service.#hostPaths.configFile])) {
            if (!existsSync(file)) continue;
            for (const key of OperatorConfig.undeclared(await readFile(file, "utf8"), declares)) Service.#configuration.undeclared(key, file);
        }

        const command = typeof positionals[0] === "string" ? positionals[0] : "start";
        const action = typeof positionals[1] === "string" ? positionals[1] : null;
        let name = command;
        let handler: (() => Promise<void>) | null = null;
        if (command === "start" || command === "migrate") {
            if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);
            await Service.#ensureOperatorConfig();
            handler = command === "start" ? Service.#start : Service.#migrate;
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
            } else if (action === null) {
                handler = Service.#configStatus;
            }
        } else if (command === "share") {
            if (positionals.length > 3) Service.#die(64, `unexpected arguments: ${positionals.slice(3).join(" ")}`);
            const workspace = values.workspace;
            if (workspace !== undefined && (typeof workspace !== "string" || !/^[1-9]\d*$/u.test(workspace))) Service.#die(64, "--workspace takes a workspace id");
            handler = async () => {
                const dbPath = typeof positionals[1] === "string" ? positionals[1] : Service.#hostPaths.configuredDatabasePath();
                const folder = typeof positionals[2] === "string" ? positionals[2] : Service.#hostPaths.shareFolder();
                const provider = values.requiem === true ? await ProviderInstantiate.loadActiveProvider() : undefined;
                if (provider === null) throw new Error("requiem: no active provider - set PLURNK_MODEL; a requiem needs a witness to testify");
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
                const { path, reportPath, workers } = await Digest.requiem({ openEvidence: EvidenceReader.open, dbPath: positionals[1] as string, digestDir: positionals[2] as string, provider: await ProviderInstantiate.loadActiveProvider() });
                process.stdout.write(`requiem: interviewed ${workers} worker(s) -> ${path}, ${reportPath}\n`);
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

await Service.main();

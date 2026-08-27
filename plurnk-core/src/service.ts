#!/usr/bin/env node

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import SqlRite from "@possumtech/sqlrite";
import type { Db } from "./core/Db.ts";
import Daemon from "./server/Daemon.ts";
import DaemonLock from "./server/DaemonLock.ts";
import EnvFlags from "./core/EnvFlags.ts";
import EnvDefaults from "./core/env-defaults.ts";
import HostPaths from "./core/HostPaths.ts";
import LegacyHome from "./core/LegacyHome.ts";
import OperatorConfig from "./core/OperatorConfig.ts";
import ProviderInstantiate from "./core/ProviderInstantiate.ts";
import Meta from "@plurnk/plurnk-meta";
import { parseAliasesFromEnv, resolveActiveRoute, resolveModelSelector } from "@plurnk/plurnk-providers";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import {
    Module as A2aModule,
    OutboundModule as A2aOutboundModule,
    hostedAgentConfiguration,
} from "@plurnk/plurnk-a2a";
import { Module as HooksModule } from "@plurnk/plurnk-hooks";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { formatBuildInfo, getBuildInfo } from "./build-info.ts";
import ServiceTeardown from "./core/ServiceTeardown.ts";
import Paths from "./Paths.ts";
import { startObservability } from "./observe/init.ts";
import FileCreationPolicy from "./core/file-creation-policy.ts";

// The `plurnk-service` executable: launches the daemon (start) or applies the schema baseline.
// Not the user-facing client — that is the separate `plurnk` project.
export default class Service {
    // This file's own directory holds the runtime code + its .sql (src/ in dev, dist/ in a
    // published install); its parent is the package root (migrations/, .env.defaults).
    static #codeDir = dirname(fileURLToPath(import.meta.url));
    static #projectRoot = resolve(Service.#codeDir, "..");
    static #ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    static #hostPaths = new HostPaths();

    // The node_modules holding the service's plugin deps (exec/scheme/mimetype), resolved
    // from this file's REAL location by the shared membership walk. Falls back to CWD.
    static #pluginsNodeModules(): string {
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
        const childSelector = process.env.PLURNK_MODEL_CHILD;
        if (childSelector !== undefined) {
            if (childSelector.length === 0 || resolveModelSelector(childSelector, aliases) === null) {
                const names = aliases.map(({ alias }) => alias).join(", ");
                throw new Error(
                    `PLURNK_MODEL_CHILD=${childSelector} is neither a declared alias nor a provider/model route `
                    + `(declared aliases: ${names.length > 0 ? names : "none"}). Unset it to inherit.`,
                );
            }
        }
        return { aliases, active };
    }

    static #formatModelRoute(route: ProviderSpec | null): string {
        if (route === null) return "not selected";
        const exact = `${route.provider}/${route.model}`;
        return route.alias === undefined ? exact : `${route.alias}=${exact}`;
    }

    static async #ensureOperatorConfig(): Promise<void> {
        await LegacyHome.assertCanonical(Service.#hostPaths);
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
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
        const lock = exclusive ? await DaemonLock.acquire(dbPath) : null;
        try {
            const db = await SqlRite.open({
                path: dbPath,
                dir: [resolve(Service.#projectRoot, "migrations"), Service.#codeDir],
                functions: [
                    resolve(Service.#codeDir, `schemes/cosine${Service.#ext}`),
                    resolve(Service.#codeDir, `core/content_weight${Service.#ext}`),
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
            throw new Error(`open ${dbPath} failed${hint}`, { cause });
        }
    }

    static async #migrate(): Promise<void> {
        const dbPath = Service.#databasePath();
        const db = await Service.#openDb(dbPath, true);
        try { process.stdout.write(`migrated: ${dbPath}\n`); }
        finally { await db.close(); }
    }

    static async #start(): Promise<void> {
        FileCreationPolicy.serviceScope();
        const dbPath = Service.#databasePath();
        const host = Service.#requireEnv("PLURNK_HOST");
        // PLURNK_PORT is THE client surface — the AG-UI+ listener (the agui plugin module binds
        // it at boot via the seam). {§rpc}: production has no daemon-owned listener.
        const port = Number(Service.#requireEnv("PLURNK_PORT"));

        // {§operator-config} — an explicit boot selector must resolve; only an
        // unset selector permits modelless boot for per-request selection.
        const { active: route } = Service.#modelConfiguration();
        // {§startup-listener-admission}: the client-interface module wins the
        // configured address before anything may mutate durable state. It owns
        // the bound socket but serves only 503 until daemon activation.
        const aguiModule = await AguiModule.bind({ host, port });
        let db: Db | null = null;
        let daemon: Daemon | null = null;
        let observability: Awaited<ReturnType<typeof startObservability>> = null;
        const teardown = new ServiceTeardown(
            async () => { await daemon?.stop(); },
            async () => { await observability?.shutdown(); },
            async () => { await db?.close(); },
            async () => { await aguiModule.close(); },
        );
        try {
            // {§startup-admission-order}: after listener ownership, persistence
            // and its exclusive owner are admitted before provider verification
            // can perform external work.
            db = await Service.#openDb(dbPath, true);
            // {§observability-boundary} — config is normalized before any SDK
            // implementation loads; teardown already owns the admitted DB.
            observability = await startObservability();
            const hooksModule = HooksModule.init();
            const provider = route === null ? null : await ProviderInstantiate.loadActiveProvider();
            daemon = new Daemon({ db, provider, nodeModulesPath: Service.#pluginsNodeModules(), skills: { hostPaths: Service.#hostPaths } });
            daemon.registerModule(McpModule.init());
            daemon.registerModule(hooksModule);
            // {§a2a-agents-functionality} — outbound agents are always a Worker
            // family; the hosted inbound listener is the optional exposure.
            daemon.registerModule(A2aOutboundModule.init());
            const a2a = hostedAgentConfiguration();
            if (a2a !== null) daemon.registerModule(A2aModule.init(a2a));
            // {§rpc}: AG-UI owns the already-bound client listener. Daemon
            // activation makes it ready without a close/rebind race.
            daemon.registerModule(aguiModule);
            await daemon.start();
            const aguiAddr = aguiModule.address();
            // {§mimetype-embedding} null means no embedder; an active remote embedder
            // reports unknown capabilities as null fields instead.
            const embedInfo = await daemon.mimetypes.embedderInfo();
            if (embedInfo === null) {
                throw new Error(
                    "default service composition is missing required "
                    + "@plurnk/plurnk-mimetypes-embeddings; reinstall @plurnk/plurnk-service",
                );
            } else if (embedInfo.contextWindow === null) {
                process.stderr.write("plurnk-service: remote embedder active but reports no input context window — set PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW to the endpoint's limit or embedding derivations will refuse\n");
            }
            if (route === null) {
                process.stderr.write(
                    `plurnk-service: no model configured — choose a profile in ${Service.#hostPaths.configFile}; `
                    + "run plurnk-service config defaults for every installed option. Loops fail legibly until then.\n",
                );
            }
            const routeText = route === null ? "no model" : Service.#formatModelRoute(route);
            process.stdout.write(`plurnk-service agui=http://${aguiAddr.host}:${aguiAddr.port} db=${dbPath} ${routeText}\n`);

            const shutdown = (): void => {
                teardown.request((cause) => {
                    process.exitCode = 1;
                    process.stderr.write(
                        ServiceTeardown.diagnostic("plurnk-service shutdown", cause),
                        () => process.exit(1),
                    );
                });
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        } catch (cause) {
            await teardown.fail(cause);
        }
    }

    static async #configStatus(): Promise<void> {
        const { aliases, active } = Service.#modelConfiguration();
        const explicitFiles = Service.#envFileArgs().map(({ path }) => resolve(Service.#hostPaths.expandUserPath(path)));
        const configFile = Service.#configFileArg();
        const lines = [
            `config: ${Service.#hostPaths.configFile} (${existsSync(Service.#hostPaths.configFile) ? "present" : "absent"})`,
            "sources (low -> high):",
            "  package .env.defaults floor",
            `  ${Service.#hostPaths.configFile}${existsSync(Service.#hostPaths.configFile) ? "" : " (absent)"}`,
            `  ${resolve(".env")}${existsSync(".env") ? "" : " (absent)"}`,
            ...(configFile === null ? [] : [`  ${resolve(configFile)}${existsSync(configFile) ? "" : " (absent)"}`]),
            ...explicitFiles.map((path) => `  ${path}${existsSync(path) ? "" : " (absent)"}`),
            "  process environment",
            "  CLI flags",
            `model: ${Service.#formatModelRoute(active)}`,
            `declared aliases: ${aliases.length === 0 ? "none" : aliases.map(({ alias }) => alias).join(", ")}`,
            `database: ${Service.#databasePath()}`,
            "defaults: plurnk-service config defaults",
            "validation: plurnk-service config check",
        ];
        process.stdout.write(`${lines.join("\n")}\n`);
    }

    static async #configCheck(): Promise<void> {
        if (Service.#hostPaths.invalidXdg.length > 0) {
            throw new Error(
                `relative XDG variable(s) are invalid and ignored: ${Service.#hostPaths.invalidXdg.join(", ")}`,
            );
        }
        FileCreationPolicy.serviceScope();
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

    static async #pathsMigrate(): Promise<void> {
        const moves = await LegacyHome.migrate(Service.#hostPaths);
        if (moves.length === 0) {
            process.stdout.write(`paths canonical: no legacy home remains at ${Service.#hostPaths.legacyDir}\n`);
            return;
        }
        process.stdout.write(`paths migrated:\n${moves.map(({ source, destination }) => `  ${source} -> ${destination}`).join("\n")}\n`);
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
        Service.#loadEnv(".env", false);
        Service.#loadEnv(Service.#hostPaths.configFile, false);
        // The assembled floor sits under everything the operator set: this package's
        // .env.defaults + every installed member's, one owner per key (collision = boot crash),
        // applied set-if-unset. The complete owner-labelled catalog is projected only by
        // `config defaults`; there is no generated configuration copy.
        const defaultsFiles = await EnvDefaults.collect(Service.#projectRoot, Service.#pluginsNodeModules());
        EnvDefaults.apply(EnvDefaults.merge(defaultsFiles));

        const flagDescriptors = await EnvFlags.parseEnvDefaults(resolve(Service.#projectRoot, ".env.defaults"));
        const flagOptions: Record<string, { type: "string" }> = {};
        for (const f of flagDescriptors) {
            flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
        }

        const usage = `usage: plurnk-service [options] [start|migrate]
       plurnk-service [options] config [edit|defaults|check]
       plurnk-service paths migrate

${EnvFlags.formatFlagsHelp(flagDescriptors)}

  --env-file=<path>            layer env from <path> (repeatable; later wins; errors if missing)
  --env-file-if-exists=<path>  layer env from <path> if present (repeatable; later wins)
  --config=<path>              layer additional env from <path>
  config defaults             print every installed package's annotated .env.defaults
  config check                validate configuration without contacting a provider
  paths migrate               move a legacy ~/.plurnk into canonical XDG paths
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
                handler = async () => { process.stdout.write(EnvDefaults.renderCatalog(defaultsFiles)); };
            } else {
                await LegacyHome.assertCanonical(Service.#hostPaths);
                if (action === "edit") {
                    await Service.#ensureOperatorConfig();
                    handler = Service.#configEdit;
                } else if (action === "check") {
                    handler = Service.#configCheck;
                } else if (action === null) {
                    handler = Service.#configStatus;
                }
            }
        } else if (command === "paths" && action === "migrate") {
            if (positionals.length > 2) Service.#die(64, `unexpected arguments: ${positionals.slice(2).join(" ")}`);
            name = "paths migrate";
            handler = Service.#pathsMigrate;
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

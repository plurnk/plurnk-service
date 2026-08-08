#!/usr/bin/env node

import { parseArgs } from "node:util";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import SqlRite from "@possumtech/sqlrite";
import type { Db } from "./core/Db.ts";
import Daemon from "./server/Daemon.ts";
import DaemonLock from "./server/DaemonLock.ts";
import EnvFlags from "./core/EnvFlags.ts";
import EnvDefaults from "./core/env-defaults.ts";
import ProviderInstantiate from "./core/ProviderInstantiate.ts";
import Meta, { TEACHING_CORPUS } from "@plurnk/plurnk-meta";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import { Module as HooksModule } from "@plurnk/plurnk-hooks";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { formatBuildInfo, getBuildInfo } from "./build-info.ts";
import ServiceTeardown from "./core/ServiceTeardown.ts";
import { readTeachingSourceSync } from "./core/teaching-corpus.ts";
import { startObservability } from "./observe/init.ts";

// The `plurnk-service` executable: launches the daemon (start) or applies the schema baseline.
// Not the user-facing client — that is the separate `plurnk` project.
export default class Service {
    // This file's own directory holds the runtime code + its .sql (src/ in dev, dist/ in a
    // published install); its parent is the package root (migrations/, requirements.md, .env.defaults).
    static #codeDir = dirname(fileURLToPath(import.meta.url));
    static #projectRoot = resolve(Service.#codeDir, "..");
    static #ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    static #homeDir = resolve(homedir(), ".plurnk");

    // First-run bootstrap — run-time, NOT an install script: seed ~/.plurnk so a global
    // install has a stable home for config + the DB. Idempotent (only acts when absent).
    static #ensureHome(): void {
        // Seed ONCE, on first run (the home is absent). After that the user owns ~/.plurnk —
        // edits and deletions stick, no silent re-seed. The assembled floor is in-memory
        // ({§operator-config-env-defaults}); `~/.plurnk/.env.defaults` is its rendered catalog,
        // machine-owned and regenerated each boot. Wiping the whole dir is a deliberate reset.
        if (existsSync(Service.#homeDir)) return;
        // Read the required seed before mutating the home. A broken installed corpus
        // fails the first-run boundary without leaving an apparently initialized home.
        const shippedPolicy = readTeachingSourceSync(TEACHING_CORPUS.personality);
        mkdirSync(Service.#homeDir, { recursive: true });
        // The first-run model selection lives HERE, as commented peers — an honest surfaced
        // choice (no active default ships, {§operator-config-shipped-defaults}). One uncomment per option; agents read this
        // file as naturally as humans do.
        writeFileSync(resolve(Service.#homeDir, ".env"), [
            "# plurnk config — overrides the shipped defaults (~/.plurnk/.env.defaults is the assembled legend).",
            "#",
            "# Pick a model — uncomment ONE block:",
            "#",
            "# LOCAL — your own llama-server / any OpenAI-compatible endpoint:",
            "# PLURNK_MODEL_local=\"openai/gemma\"",
            "# OPENAI_BASE_URL=http://127.0.0.1:11434",
            "# PLURNK_MODEL=local",
            "#",
            "# CLOUD — bring your own key, any openrouter model:",
            "# PLURNK_MODEL_cloud=\"openrouter/qwen/qwen3-coder\"",
            "# OPENROUTER_API_KEY=\"...\"",
            "# PLURNK_MODEL=cloud",
            "#",
            "# PLURNK.AI - Plurnk-optimized endpoint service - https://plurnk.ai/",
            "# PLURNK_MODEL_plurnk=\"plurnk/plurnk\"",
            "# PLURNK_API_KEY=\"...\"",
            "# PLURNK_MODEL=plurnk",
            "",
        ].join("\n"));
        // Seed the default operating policy rendered as ## Policy. The user owns the seeded file;
        // later edits or deletion persist.
        writeFileSync(resolve(Service.#homeDir, "AGENTS.md"), shippedPolicy);
        process.stderr.write(`plurnk-service: created ${Service.#homeDir} — config in ${resolve(Service.#homeDir, ".env")}\n`);
    }

    // Package-owned reference files are REFRESHED from the installed package on every boot —
    // they carry the installed version's prose, so a seed-once snapshot would silently drift.
    // Safe to clobber because they are package-owned, NOT user config: ~/.plurnk/.env (the
    // user's, seeded once above) is never touched here. The knob legend is the assembled
    // ~/.plurnk/.env.defaults, written by main() after assembly; .env.example is that legend's
    // retired name — a machine-owned stale copy is removed so it can't mislead readers.
    static #syncReferenceFiles(): void {
        if (!existsSync(Service.#homeDir)) return;
        for (const name of ["INSTALL.md"]) {
            const src = resolve(Service.#projectRoot, name);
            if (existsSync(src)) copyFileSync(src, resolve(Service.#homeDir, name));
        }
        rmSync(resolve(Service.#homeDir, ".env.example"), { force: true });
    }

    static #expandHome(p: string): string {
        if (p === "~") return homedir();
        return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
    }

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

    static #requireEnv(name: string): string {
        const value = process.env[name];
        if (value === undefined || value.length === 0) Service.#die(78, `missing required env ${name} (declare it in .env.defaults)`);
        return value;
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
        mkdirSync(dirname(dbPath), { recursive: true });
        const lock = exclusive ? await DaemonLock.acquire(dbPath) : null;
        try {
            const db = await SqlRite.open({
                path: dbPath,
                dir: [resolve(Service.#projectRoot, "migrations"), Service.#codeDir],
                functions: [
                    resolve(Service.#codeDir, `schemes/cosine${Service.#ext}`),
                    resolve(Service.#codeDir, `core/ruler_count${Service.#ext}`),
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
        const dbPath = Service.#expandHome(Service.#requireEnv("PLURNK_SERVICE_DB_PATH"));
        const db = await Service.#openDb(dbPath, true);
        try { process.stdout.write(`migrated: ${dbPath}\n`); }
        finally { await db.close(); }
    }

    static async #start(): Promise<void> {
        const dbPath = Service.#expandHome(Service.#requireEnv("PLURNK_SERVICE_DB_PATH"));
        const host = Service.#requireEnv("PLURNK_HOST");
        // PLURNK_PORT is THE client surface — the AG-UI+ listener (the agui plugin module binds
        // it at boot via the seam). {§rpc}: production has no daemon-owned listener.
        const port = Number(Service.#requireEnv("PLURNK_PORT"));

        const alias = resolveActiveAlias();
        // {§operator-config} — an explicit boot alias must resolve; only an
        // unset selector permits modelless boot for per-request selection.
        const selectedModel = process.env.PLURNK_MODEL ?? "";
        if (alias === null && selectedModel !== "") {
            const declared = parseAliasesFromEnv(process.env).map((a) => a.alias).join(", ");
            throw new Error(
                `PLURNK_MODEL=${selectedModel} names no declared alias (declared: ${declared.length > 0 ? declared : "none"}). `
                + `The knob takes an ALIAS name; for an inline model, declare PLURNK_MODEL_<alias>=${selectedModel} and set PLURNK_MODEL=<alias>.`,
            );
        }
        // {§startup-admission-order}: persistence and its exclusive owner are
        // admitted before provider verification can perform external work.
        const db = await Service.#openDb(dbPath, true);
        let daemon: Daemon | null = null;
        let observability: Awaited<ReturnType<typeof startObservability>> = null;
        const teardown = new ServiceTeardown(
            async () => { await daemon?.stop(); },
            async () => { await observability?.shutdown(); },
            async () => db.close(),
        );
        try {
            // {§observability-boundary} — config is normalized before any SDK
            // implementation loads; teardown already owns the admitted DB.
            observability = await startObservability();
            const hooksModule = HooksModule.init();
            const provider = alias === null ? null : await ProviderInstantiate.loadActiveProvider();
            daemon = new Daemon({ db, provider, nodeModulesPath: Service.#pluginsNodeModules() });
            daemon.registerModule(McpModule.init());
            daemon.registerModule(hooksModule);
            // {§rpc} — the AG-UI plugin module is the client surface; its init runs at boot with the
            // seam handle and binds PLURNK_HOST:PLURNK_PORT. The module owns its knobs' semantics.
            const aguiModule = AguiModule.init({
                host, port,
            });
            let agui: AguiModule | null = null;
            daemon.registerModule({
                start: async (seam) => {
                    agui = await aguiModule.start(seam);
                    return agui;
                },
            });
            await daemon.start(); // {§module-lifecycle}: AG-UI opens the listener; daemon owns no transport
            if (agui === null) throw new Error("AG-UI module did not start");
            const aguiAddr = (agui as AguiModule).address();
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
            if (alias === null) {
                process.stderr.write(`plurnk-service: no model configured — uncomment one of the three options (local / cloud / plurnk.ai) in ${resolve(Service.#homeDir, ".env")}. Loops fail legibly until then.\n`);
            }
            const aliasStr = alias === null ? "no model" : `${alias.alias}=${alias.provider}/${alias.model}`;
            process.stdout.write(`plurnk-service agui=http://${aguiAddr.host}:${aguiAddr.port} db=${dbPath} ${aliasStr}\n`);

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

    static async main(): Promise<void> {
        if (!process.argv.includes("--help") && !process.argv.includes("-h")) { Service.#ensureHome(); Service.#syncReferenceFiles(); }
        // loadEnvFile is set-if-unset, so every service-owned layer loads high→low. Within the
        // repeatable env-file tier, loading last→first preserves Node's later-file-wins order.
        // {§operator-config-precedence}
        for (const { path: envFile, required } of Service.#envFileArgs().toReversed()) Service.#loadEnv(envFile, required);

        const configFlagIndex = process.argv.findIndex((a) => a === "--config" || a.startsWith("--config="));
        const configFile = ((): string | null => {
            if (configFlagIndex === -1) return null;
            const arg = process.argv[configFlagIndex];
            if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
            return process.argv[configFlagIndex + 1] ?? null;
        })();

        if (configFile !== null) Service.#loadEnv(configFile, true);
        Service.#loadEnv(".env", false);
        Service.#loadEnv(resolve(Service.#homeDir, ".env"), false);
        // The assembled floor sits under everything the operator set: this package's
        // .env.defaults + every installed member's, one owner per key (collision = boot crash),
        // applied set-if-unset. The catalog renders to ~/.plurnk/.env.defaults — the operator's
        // legend, machine-owned, never read back as config.
        const defaultsFiles = await EnvDefaults.collect(Service.#projectRoot, Service.#pluginsNodeModules());
        EnvDefaults.apply(EnvDefaults.merge(defaultsFiles));
        if (existsSync(Service.#homeDir)) writeFileSync(resolve(Service.#homeDir, ".env.defaults"), EnvDefaults.renderCatalog(defaultsFiles));

        const flagDescriptors = await EnvFlags.parseEnvDefaults(resolve(Service.#projectRoot, ".env.defaults"));
        const flagOptions: Record<string, { type: "string" }> = {};
        for (const f of flagDescriptors) {
            flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
        }

        const usage = `usage: plurnk-service [options] [migrate]

${EnvFlags.formatFlagsHelp(flagDescriptors)}

  --env-file=<path>            layer env from <path> (repeatable; later wins; errors if missing)
  --env-file-if-exists=<path>  layer env from <path> if present (repeatable; later wins)
  --config=<path>              layer additional env from <path>
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

        const dispatch: Record<string, () => Promise<void>> = { migrate: Service.#migrate, start: Service.#start };
        const subcommand = typeof positionals[0] === "string" ? positionals[0] : "start";
        const handler = dispatch[subcommand];
        if (handler === undefined) Service.#die(64, `unknown subcommand: ${subcommand}\n\n${usage}`);
        if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);

        process.stderr.write(`plurnk-service: ${formatBuildInfo(buildInfo)}\n`);
        try { await handler(); }
        catch (cause) {
            process.stderr.write(ServiceTeardown.diagnostic(subcommand, cause));
            process.exit(1);
        }
    }
}

await Service.main();

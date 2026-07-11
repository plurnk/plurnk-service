#!/usr/bin/env node

import Paths from "./Paths.ts";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import SqlRite from "@possumtech/sqlrite";
import type { Db } from "./core/Db.ts";
import Daemon from "./server/Daemon.ts";
import EnvFlags from "./core/EnvFlags.ts";
import ProviderInstantiate from "./core/ProviderInstantiate.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import { Module as AguiModule } from "@plurnk/plurnk-agui";

// The `plurnk-service` executable: launches the daemon (start) or runs migrations.
// Not the user-facing client — that is the separate `plurnk` project.
export default class Service {
    // This file's own directory holds the runtime code + its .sql (src/ in dev, dist/ in a
    // published install); its parent is the package root (migrations/, requirements.md, .env.example).
    static #codeDir = dirname(fileURLToPath(import.meta.url));
    static #projectRoot = resolve(Service.#codeDir, "..");
    static #ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    static #homeDir = resolve(homedir(), ".plurnk");

    // First-run bootstrap — run-time, NOT an install script: seed ~/.plurnk so a global
    // install has a stable home for config + the DB. Idempotent (only acts when absent).
    static #ensureHome(): void {
        // Seed ONCE, on first run (the home is absent). After that the user owns ~/.plurnk —
        // edits and deletions stick, no silent re-seed. `~/.plurnk/.env.example` is the cascade
        // FLOOR (the visible legend); the node_modules copy is the seed + CLI-flag source only.
        // Wiping the whole dir is a deliberate reset. A deleted floor stays deleted; a missing
        // required knob then surfaces as a clear `missing PLURNK_X` error, not a crash.
        if (existsSync(Service.#homeDir)) return;
        mkdirSync(Service.#homeDir, { recursive: true });
        // The first-run model selection lives HERE, as commented peers — an honest surfaced
        // choice (no active default ships; #307). One uncomment per option; agents read this
        // file as naturally as humans do.
        writeFileSync(resolve(Service.#homeDir, ".env"), [
            "# plurnk config — overrides the shipped defaults (~/.plurnk/.env.example is the legend).",
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
        // Seed the default operating policy → ~/.plurnk/AGENTS.md, foisted as ## Plurnk Service Policy
        // (readSystemPolicy). A new install opens with a sane disposition, not a blank policy; the user
        // owns + edits it after — a deleted policy stays deleted, like the .env floor.
        const shippedPolicy = Paths.personality; // @plurnk/plurnk-docs owns the default policy
        if (existsSync(shippedPolicy)) copyFileSync(shippedPolicy, resolve(Service.#homeDir, "AGENTS.md"));
        process.stderr.write(`plurnk-service: created ${Service.#homeDir} — config in ${resolve(Service.#homeDir, ".env")}\n`);
    }

    // Package-owned reference files (the legend + the config guide) are REFRESHED from the
    // installed package on every boot — they carry the installed version's knobs and prose, so
    // a seed-once snapshot would silently drift from the floor the daemon runs (the pre-fix bug).
    // Safe to clobber because they are package-owned, NOT user config: ~/.plurnk/.env (the user's,
    // seeded once above) is never touched here. The .env.example legend carries a loud overwrite
    // warning at its head so nobody edits the wrong file.
    static #syncReferenceFiles(): void {
        if (!existsSync(Service.#homeDir)) return;
        for (const name of [".env.example", "INSTALL.md"]) {
            const src = resolve(Service.#projectRoot, name);
            if (existsSync(src)) copyFileSync(src, resolve(Service.#homeDir, name));
        }
    }

    static #expandHome(p: string): string {
        if (p === "~") return homedir();
        return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
    }

    // The node_modules holding the service's plugin deps (exec/scheme/mimetype), resolved
    // package-relative so a global install finds them regardless of run-CWD. Falls back to CWD.
    static #pluginsNodeModules(): string {
        try {
            const execs = createRequire(import.meta.url).resolve("@plurnk/plurnk-execs/package.json");
            return resolve(dirname(execs), "..", "..");
        } catch {
            return resolve(process.cwd(), "node_modules");
        }
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

    // node-style env-file flags: --env-file=<path> (required) / --env-file-if-exists=<path>
    // (skip if missing), repeatable, in command-line order. node only loads pre-script files;
    // a published `plurnk-service --env-file=…` needs this post-script loader.
    static #envFileArgs(): Array<{ path: string; required: boolean }> {
        return process.argv.flatMap((a): Array<{ path: string; required: boolean }> => {
            if (a.startsWith("--env-file-if-exists=")) return [{ path: a.slice(a.indexOf("=") + 1), required: false }];
            if (a.startsWith("--env-file=")) return [{ path: a.slice(a.indexOf("=") + 1), required: true }];
            return [];
        });
    }

    static #requireEnv(name: string): string {
        const value = process.env[name];
        if (value === undefined || value.length === 0) Service.#die(78, `missing required env ${name} (declare it in .env.example)`);
        return value;
    }

    static #sqliteKnob(name: string): number | undefined {
        const raw = process.env[name];
        if (raw === undefined || raw.trim() === "") return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n)) Service.#die(78, `${name} must be an integer, got ${JSON.stringify(raw)}`);
        return n;
    }

    static async #openDb(dbPath: string): Promise<Db> {
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
        try {
            const db = await SqlRite.open({
                path: dbPath,
                dir: [resolve(Service.#projectRoot, "migrations"), Service.#codeDir],
                functions: [resolve(Service.#codeDir, `schemes/cosine${Service.#ext}`)],
                ...tuning,
            });
            return db as unknown as Db;
        } catch (cause) {
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
        const db = await Service.#openDb(dbPath);
        try { process.stdout.write(`migrated: ${dbPath}\n`); }
        finally { await db.close(); }
    }

    static async #start(): Promise<void> {
        const dbPath = Service.#expandHome(Service.#requireEnv("PLURNK_SERVICE_DB_PATH"));
        const host = Service.#requireEnv("PLURNK_HOST");
        // PLURNK_PORT is THE client surface — the AG-UI+ listener (the agui daughter module binds
        // it at boot via the seam). Production is single-listener (#357): no daemon WS port.
        const port = Number(Service.#requireEnv("PLURNK_PORT"));

        const db = await Service.#openDb(dbPath);
        const alias = resolveActiveAlias();
        const provider = alias === null ? null : await ProviderInstantiate.loadActiveProvider();
        const daemon = new Daemon({ db, provider, nodeModulesPath: Service.#pluginsNodeModules() });
        // AG-UI daughter module (#355) — THE client surface, always on: its init runs at boot with the
        // seam handle and binds PLURNK_HOST:PLURNK_PORT. The module owns its knobs' semantics.
        const aguiInit = AguiModule.init({
            host, port,
            ...(process.env.PLURNK_AGUI_TOKEN !== undefined && process.env.PLURNK_AGUI_TOKEN.length > 0 ? { token: process.env.PLURNK_AGUI_TOKEN } : {}),
            ...(process.env.PLURNK_AGUI_MAX_TURNS !== undefined && process.env.PLURNK_AGUI_MAX_TURNS.length > 0 ? { maxTurns: Number(process.env.PLURNK_AGUI_MAX_TURNS) } : {}),
        });
        // Capture the module so the banner reports the BOUND address, not the configured one —
        // with PLURNK_PORT=0 the configured value is 0 and banner parsers get garbage.
        let agui: Awaited<ReturnType<typeof aguiInit>> | null = null;
        daemon.registerModule(async (seam) => { agui = await aguiInit(seam); });
        await daemon.start({ host, port: null }); // listenerless boot — the agui module opens the one listener
        const aguiAddr = (agui as Awaited<ReturnType<typeof aguiInit>> | null)?.address() ?? { host, port };
        // mimetypes#50 recontract: null ⇔ NO embedder (a remote embedder with an incomplete
        // self-report returns info with the unknowns explicitly null — say which case this is).
        const embedInfo = await daemon.mimetypes.embedderInfo();
        if (embedInfo === null) {
            process.stderr.write("plurnk-service: embedder inactive — semantic ~query falls back to FTS keyword ranking. Install @plurnk/plurnk-mimetypes-embeddings for vector search, or see README.md#semantic-search\n");
        } else if (embedInfo.maxTokens === null) {
            process.stderr.write("plurnk-service: remote embedder active but reports no token window — set PLURNK_MIMETYPES_EMBED_MAX_TOKENS to the endpoint's limit or embedding derivations will refuse\n");
        }
        // §tokenomics-window-partition coupling (F7): per-request numeric reasoning budgets are
        // IGNORED by llama-server — when thinking is on, only the box's --reasoning-budget launch
        // flag clamps it, and it must equal PLURNK_SERVICE_REASONING. Unverifiable from here, so
        // say it loudly rather than let the reserve be fiction.
        const thinking = process.env.PLURNK_PROVIDERS_THINKING ?? "off";
        if (thinking !== "off") {
            process.stderr.write(`plurnk-service: native thinking is ${thinking} — llama-server ignores per-request numeric budgets; ensure the serving box launches with --reasoning-budget ${process.env.PLURNK_PROVIDERS_THINKING_CAPACITY ?? "?"} or the capacity is not enforced.\n`);
        }
        if (alias === null) {
            process.stderr.write(`plurnk-service: no model configured — uncomment one of the three options (local / cloud / plurnk.ai) in ${resolve(Service.#homeDir, ".env")}. Loops fail legibly until then.\n`);
        }
        const aliasStr = alias === null ? "no model" : `${alias.alias}=${alias.provider}/${alias.model}`;
        process.stdout.write(`plurnk-service agui=http://${aguiAddr.host}:${aguiAddr.port} db=${dbPath} ${aliasStr}\n`);

        const shutdown = async (): Promise<void> => { await daemon.stop(); await db.close(); process.exit(0); };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }

    static async main(): Promise<void> {
        if (!process.argv.includes("--help") && !process.argv.includes("-h")) { Service.#ensureHome(); Service.#syncReferenceFiles(); }
        // Env cascade — first write wins (loadEnvFile is set-if-unset), so load highest first.
        // Precedence high→low: CLI --flags > shell env > --env-file/--config > ./.env >
        // ~/.plurnk/.env > ~/.plurnk/.env.example (the legend) > package .env.example (the floor).
        for (const { path: envFile, required } of Service.#envFileArgs()) Service.#loadEnv(envFile, required);

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
        Service.#loadEnv(resolve(Service.#homeDir, ".env.example"), false);   // the visible legend (seed-once, user-ownable)
        // The PACKAGE template is the TRUE floor, under the home legend: shipped defaults must
        // evolve with the installed version — a seed-once home floor left every upgrade's new
        // knobs (including fail-hard REQUIRED vars) unreachable on existing installs.
        Service.#loadEnv(resolve(Service.#projectRoot, ".env.example"), false);

        const flagDescriptors = await EnvFlags.parseEnvExample(resolve(Service.#projectRoot, ".env.example"));
        const flagOptions: Record<string, { type: "string" }> = {};
        for (const f of flagDescriptors) {
            flagOptions[f.flagName.replace(/^--/, "")] = { type: "string" };
        }

        const usage = `usage: plurnk-service [options] [migrate]

${EnvFlags.formatFlagsHelp(flagDescriptors)}

  --env-file=<path>            layer env from <path> (repeatable; errors if missing)
  --env-file-if-exists=<path>  layer env from <path> if present (repeatable)
  --config=<path>              layer additional env from <path>
  -h, --help                   show this help
`;

        const { positionals, values } = parseArgs({
            allowPositionals: true,
            strict: false,
            options: { help: { type: "boolean", short: "h" }, config: { type: "string" }, ...flagOptions },
        });

        for (const f of flagDescriptors) {
            const key = f.flagName.replace(/^--/, "");
            const v = values[key];
            if (typeof v === "string") process.env[f.envName] = v;
        }

        if (values.help) { process.stdout.write(usage); process.exit(0); }

        const dispatch: Record<string, () => Promise<void>> = { migrate: Service.#migrate, start: Service.#start };
        const subcommand = typeof positionals[0] === "string" ? positionals[0] : "start";
        const handler = dispatch[subcommand];
        if (handler === undefined) Service.#die(64, `unknown subcommand: ${subcommand}\n\n${usage}`);
        if (positionals.length > 1) Service.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);

        try { await handler(); }
        catch (cause) {
            process.stderr.write(`${subcommand}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            if (cause instanceof Error && cause.cause) process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
            process.exit(1);
        }
    }
}

await Service.main();

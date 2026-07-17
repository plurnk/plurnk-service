#!/usr/bin/env node

import Paths from "./Paths.ts";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import SqlRite from "@possumtech/sqlrite";
import type { Db } from "./core/Db.ts";
import Daemon from "./server/Daemon.ts";
import EnvFlags from "./core/EnvFlags.ts";
import EnvDefaults from "./core/env-defaults.ts";
import ProviderInstantiate from "./core/ProviderInstantiate.ts";
import Meta from "@plurnk/plurnk-meta";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";
import { Module as AguiModule } from "@plurnk/plurnk-agui";

// The `plurnk-service` executable: launches the daemon (start) or runs migrations.
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
        // (§operator-config-env-defaults); `~/.plurnk/.env.defaults` is its rendered catalog,
        // machine-owned and regenerated each boot. Wiping the whole dir is a deliberate reset.
        if (existsSync(Service.#homeDir)) return;
        mkdirSync(Service.#homeDir, { recursive: true });
        // The first-run model selection lives HERE, as commented peers — an honest surfaced
        // choice (no active default ships; #307). One uncomment per option; agents read this
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
        // Seed the default operating policy → ~/.plurnk/AGENTS.md, foisted as ## Plurnk Service Policy
        // (readSystemPolicy). A new install opens with a sane disposition, not a blank policy; the user
        // owns + edits it after — a deleted policy stays deleted, like the .env floor.
        const shippedPolicy = Paths.personality; // the docs corpus ships the default policy
        if (existsSync(shippedPolicy)) copyFileSync(shippedPolicy, resolve(Service.#homeDir, "AGENTS.md"));
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

    // node-style env-file flags: --env-file=<path> (required) / --env-file-if-exists=<path>
    // (skip if missing), repeatable, in command-line order. node only loads pre-script files;
    // a published `plurnk-service --env-file=…` needs this post-script loader.
    // PRECEDENCE CAUTION (#501): this post-script cascade is FIRST-wins (highest-priority file
    // first); node's own pre-script parsing of the same flags is LAST-wins. The same flag
    // obeys opposite precedence depending on argv position relative to the script path.
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
        // #501 (owner ruling, gates 1.0.6) — SET-but-unresolvable is the silent-absence class, never
        // a modelless boot: PLURNK_MODEL=plurnk/jennifer (a provider/model PATH where an ALIAS name
        // belongs) resolved to null and the daemon booted modelless behind a warning claiming the
        // knob was unset. Fail hard naming the violated contract; UNSET stays the legal modelless
        // boot (clients may supply per-request models).
        const selectedModel = process.env.PLURNK_MODEL ?? "";
        if (alias === null && selectedModel !== "") {
            const declared = parseAliasesFromEnv(process.env).map((a) => a.alias).join(", ");
            throw new Error(
                `PLURNK_MODEL=${selectedModel} names no declared alias (declared: ${declared.length > 0 ? declared : "none"}). `
                + `The knob takes an ALIAS name; for an inline model, declare PLURNK_MODEL_<alias>=${selectedModel} and set PLURNK_MODEL=<alias>.`,
            );
        }
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
        await daemon.start(); // the daemon owns no transport (#364) — the agui module opens the one listener
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
        // IGNORED by llama-server — when reasoning is on, only the box's --reasoning-budget launch
        // flag clamps it, and it must equal the alias's resolved reasoning reserve. Unverifiable here, so
        // say it loudly rather than let the reserve be fiction. (#472 — reads the post-#399 knob
        // names; the shed pre-#399 knob names made this advisory dead code that could never fire.)
        const reasoning = process.env.PLURNK_PROVIDERS_REASONING ?? "off";
        if (reasoning !== "off") {
            process.stderr.write(`plurnk-service: reasoning is ${reasoning} — llama-server ignores per-request numeric budgets; ensure the serving box launches with --reasoning-budget ${process.env.PLURNK_PROVIDERS_REASONING_BUDGET ?? "?"} or the budget is not enforced.\n`);
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
        // ~/.plurnk/.env > the assembled .env.defaults floor (§operator-config-env-defaults:
        // this package's file + every installed member's, uniqueness-checked).
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

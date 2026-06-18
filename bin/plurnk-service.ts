#!/usr/bin/env node

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import SqlRite from "@possumtech/sqlrite";
import type { Db } from "../src/core/Db.ts";
import Daemon from "../src/server/Daemon.ts";
import EnvFlags from "../src/core/EnvFlags.ts";
import ProviderInstantiate from "../src/core/ProviderInstantiate.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";

export default class Cli {
    static #projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    static #die(code: number, message: string): never {
        process.stderr.write(`${message}\n`);
        process.exit(code);
    }

    static #loadEnv(path: string, required: boolean): void {
        if (existsSync(path)) {
            try { process.loadEnvFile(path); }
            catch (cause) { Cli.#die(64, `failed to load ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        } else if (required) {
            Cli.#die(64, `${path} does not exist`);
        }
    }

    // node-style env-file flags: --env-file=<path> (required) / --env-file-if-exists=<path>
    // (skip if missing), repeatable, in command-line order. They layer extra files ABOVE
    // the .env cascade but BELOW shell env (loadEnvFile is set-if-unset) and the --<knob>
    // CLI flags (assigned last). The `=` form only — node's canonical syntax (so it never
    // leaks a positional). NB: node validates these paths from the full argv (and exits on
    // a missing *required* one), but only LOADS pre-script files — the post-script loading
    // a published `plurnk-service --env-file=…` needs is this.
    static #envFileArgs(): Array<{ path: string; required: boolean }> {
        return process.argv.flatMap((a): Array<{ path: string; required: boolean }> => {
            if (a.startsWith("--env-file-if-exists=")) return [{ path: a.slice(a.indexOf("=") + 1), required: false }];
            if (a.startsWith("--env-file=")) return [{ path: a.slice(a.indexOf("=") + 1), required: true }];
            return [];
        });
    }

    // The .env cascade always populates these from .env.example, so absence is
    // a broken config, not a runtime branch — fail hard rather than `?? ""`.
    static #requireEnv(name: string): string {
        const value = process.env[name];
        if (value === undefined || value.length === 0) Cli.#die(78, `missing required env ${name} (declare it in .env.example)`);
        return value;
    }

    // Optional integer sqlite tuning knob — undefined when unset (so it never clobbers
    // sqlrite's default by spreading an explicit `undefined`); fail-hard on a non-integer.
    static #sqliteKnob(name: string): number | undefined {
        const raw = process.env[name];
        if (raw === undefined || raw.trim() === "") return undefined;
        const n = Number(raw);
        if (!Number.isInteger(n)) Cli.#die(78, `${name} must be an integer, got ${JSON.stringify(raw)}`);
        return n;
    }

    static async #openDb(dbPath: string): Promise<Db> {
        // Curated sqlite tuning (sqlrite 5.2.0, #7) — pass through ONLY the knobs the
        // operator set, so an unset one keeps sqlrite's default (e.g. busy_timeout=5000).
        const tuning: Record<string, number> = {};
        for (const [env, opt] of [
            ["PLURNK_SQLITE_TIMEOUT", "timeout"],
            ["PLURNK_SQLITE_CACHE_SIZE", "cacheSize"],
            ["PLURNK_SQLITE_MMAP_SIZE", "mmapSize"],
            ["PLURNK_SQLITE_MAX_PAGE_COUNT", "maxPageCount"],
        ] as const) {
            const v = Cli.#sqliteKnob(env);
            if (v !== undefined) tuning[opt] = v;
        }
        const db = await SqlRite.open({
            path: dbPath,
            dir: [resolve(Cli.#projectRoot, "migrations"), resolve(Cli.#projectRoot, "src")],
            functions: [resolve(Cli.#projectRoot, "src/schemes/cosine.ts")],
            ...tuning,
        });
        return db as unknown as Db;
    }

    static async #migrate(): Promise<void> {
        const dbPath = Cli.#requireEnv("PLURNK_DB_PATH");
        const db = await Cli.#openDb(dbPath);
        try { process.stdout.write(`migrated: ${dbPath}\n`); }
        finally { await db.close(); }
    }

    static async #start(): Promise<void> {
        const dbPath = Cli.#requireEnv("PLURNK_DB_PATH");
        const host = Cli.#requireEnv("PLURNK_HOST");
        const port = Number(Cli.#requireEnv("PLURNK_PORT"));

        const db = await Cli.#openDb(dbPath);
        const alias = resolveActiveAlias();
        const provider = alias === null ? null : await ProviderInstantiate.loadActiveProvider();
        const daemon = new Daemon({ db, provider });
        const addr = await daemon.start({ host, port });
        const aliasStr = alias === null ? "no model" : `${alias.alias}=${alias.provider}/${alias.model}`;
        process.stdout.write(`plurnk-service ws://${addr.host}:${addr.port} db=${dbPath} ${aliasStr}\n`);

        const shutdown = async (): Promise<void> => { await daemon.stop(); await db.close(); process.exit(0); };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }

    static async main(): Promise<void> {
        // Env cascade, highest precedence loads FIRST (loadEnvFile is set-if-unset,
        // first write wins): --env-file(s) < --config < .env < .env.example, all of them
        // OUTRANKED by pre-set shell env, then by the --<knob> CLI flags (assigned last,
        // below). So --env-file overrides the .env files but never a shell var or a CLI
        // arg — node-idiomatic layering.
        for (const { path: envFile, required } of Cli.#envFileArgs()) Cli.#loadEnv(envFile, required);

        const configFlagIndex = process.argv.findIndex((a) => a === "--config" || a.startsWith("--config="));
        const configFile = ((): string | null => {
            if (configFlagIndex === -1) return null;
            const arg = process.argv[configFlagIndex];
            if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
            return process.argv[configFlagIndex + 1] ?? null;
        })();

        if (configFile !== null) Cli.#loadEnv(configFile, true);
        Cli.#loadEnv(".env", false);
        Cli.#loadEnv(resolve(Cli.#projectRoot, ".env.example"), false);

        const flagDescriptors = await EnvFlags.parseEnvExample(resolve(Cli.#projectRoot, ".env.example"));
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

        const dispatch: Record<string, () => Promise<void>> = { migrate: Cli.#migrate, start: Cli.#start };
        const subcommand = typeof positionals[0] === "string" ? positionals[0] : "start";
        const handler = dispatch[subcommand];
        if (handler === undefined) Cli.#die(64, `unknown subcommand: ${subcommand}\n\n${usage}`);
        if (positionals.length > 1) Cli.#die(64, `unexpected arguments: ${positionals.slice(1).join(" ")}`);

        try { await handler(); }
        catch (cause) {
            process.stderr.write(`${subcommand}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            if (cause instanceof Error && cause.cause) process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
            process.exit(1);
        }
    }
}

await Cli.main();

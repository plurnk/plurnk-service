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
            Cli.#die(64, `--config: ${path} does not exist`);
        }
    }

    // The .env cascade always populates these from .env.example, so absence is
    // a broken config, not a runtime branch — fail hard rather than `?? ""`.
    static #requireEnv(name: string): string {
        const value = process.env[name];
        if (value === undefined || value.length === 0) Cli.#die(78, `missing required env ${name} (declare it in .env.example)`);
        return value;
    }

    static async #openDb(dbPath: string): Promise<Db> {
        const db = await SqlRite.open({
            path: dbPath,
            dir: [resolve(Cli.#projectRoot, "migrations"), resolve(Cli.#projectRoot, "src")],
            functions: [resolve(Cli.#projectRoot, "src/schemes/cosine.ts")],
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
        // Env cascade: .env.example (shipped defaults) < .env (project) <
        // .env.<config> (--config) < shell. process.loadEnvFile is set-if-unset,
        // so loading in low→high precedence order yields the right effective env
        // (highest precedence loads FIRST — first write wins).
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

  --config=<path>  layer additional env from <path>
  -h, --help       show this help
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

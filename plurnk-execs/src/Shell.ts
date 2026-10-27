// {§executor-subprocess} The shell `sh` runs: the environment's `$SHELL` when it names an executable file, else
// the system shell. One resolution per process serves both the declaration's summary and the spawn.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import SpawnAccounts from "./SpawnAccount.ts";

export interface ShellChoice {
    // The path spawned, as the environment names it.
    readonly path: string;
    // The program that path runs, as its resolved file names it.
    readonly program: string;
    // The version its `--version` reports, when it reports one.
    readonly version: string | null;
}

export default class Shell {
    static readonly SYSTEM = "/bin/sh";
    static #current: ShellChoice | null = null;

    static resolve(env: NodeJS.ProcessEnv = process.env): ShellChoice {
        const declared = env.SHELL;
        const path = declared !== undefined && isAbsolute(declared) && Shell.#executable(declared) ? declared : Shell.SYSTEM;
        return { path, program: Shell.#program(path), version: Shell.#version(path, env) };
    }

    // Resolved on first use and held for the process, so what the summary names is what runs.
    static current(): ShellChoice {
        return Shell.#current ??= Shell.resolve();
    }

    static summary({ path, program, version }: ShellChoice): string {
        return `Run shell commands and scripts with ${program}${version === null ? "" : ` ${version}`} (${path}).`;
    }

    static #executable(path: string): boolean {
        try {
            if (!statSync(path).isFile()) return false;
            accessSync(path, constants.X_OK);
            return true;
        } catch { return false; }
    }

    static #program(path: string): string {
        try { return basename(realpathSync(path)); }
        catch { return basename(path); }
    }

    // The first dotted number on the first line; a shell without `--version` (dash) reports none.
    static #version(path: string, env: NodeJS.ProcessEnv): string | null {
        const probe = spawnSync(path, ["--version"], {
            encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"], ...SpawnAccounts.options(env), // {§executor-policy}
        });
        if (probe.status !== 0) return null;
        return /\d+(?:\.\d+)+/u.exec(probe.stdout.split("\n")[0] ?? "")?.[0] ?? null;
    }
}

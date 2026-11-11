import { errnoCode } from "@plurnk/plurnk-contracts";
import { SpawnAccounts } from "@plurnk/plurnk-execs";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import HostPaths from "../core/HostPaths.ts";

// {§exec-target-routing} — the one directory a standalone execution source is written to for
// its run. Empty derives the XDG runtime directory, else the platform temporary directory.
export default class ExecScratch {
    static readonly KNOB = "PLURNK_SERVICE_EXEC_SCRATCH";

    static directory(env: NodeJS.ProcessEnv = process.env, hostPaths?: HostPaths): string {
        const paths = hostPaths ?? new HostPaths({ env });
        const configured = env[ExecScratch.KNOB];
        if (configured === undefined || configured.length === 0) return paths.runtimeDir ?? tmpdir();
        const expanded = paths.expandUserPath(configured);
        if (!isAbsolute(expanded)) throw new ConfigurationError(ExecScratch.KNOB, `${ExecScratch.KNOB} must be an absolute directory path.`);
        return resolve(expanded);
    }

    readonly #env: NodeJS.ProcessEnv;
    readonly #directory: string;

    constructor(env: NodeJS.ProcessEnv = process.env, hostPaths?: HostPaths) {
        this.#env = env;
        this.#directory = ExecScratch.directory(env, hostPaths);
    }

    get directory(): string {
        return this.#directory;
    }

    async #missingDirectories(): Promise<string[]> {
        const missing: string[] = [];
        let current = this.#directory;
        while (true) {
            try {
                await fs.stat(current);
                break;
            } catch (cause) {
                if (errnoCode(cause) !== "ENOENT") break;
                missing.unshift(current);
                const parent = dirname(current);
                if (parent === current) break;
                current = parent;
            }
        }
        return missing;
    }

    // Creates the directory on first use (0700, or 0710 for spawn-account traversal when running as root)
    // and probes it for writing: the failure's code when it cannot be used, null when it can.
    async unavailable(): Promise<string | null> {
        try {
            const missing = await this.#missingDirectories();
            await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
            if (missing.length > 0 && process.geteuid?.() === 0) {
                const account = SpawnAccounts.configured(this.#env);
                if (account !== null && (account.uid !== 0 || account.gid !== 0)) {
                    for (const created of missing) {
                        await fs.chown(created, 0, account.gid);
                        await fs.chmod(created, 0o710);
                    }
                }
            }
            await fs.access(this.#directory, constants.W_OK);
            return null;
        } catch (cause) {
            return cause instanceof Error && "code" in cause ? String(cause.code) : String(cause);
        }
    }

    path(extension: string): string {
        return join(this.#directory, `plurnk-exec-${crypto.randomUUID()}${extension}`);
    }

    // {§exec-target-routing} — materialize an exclusive 0600 script and grant read ownership to a
    // configured non-root PLURNK_EXECS_SPAWN_USER when the daemon runs as root.
    async stage(extension: string, content: string): Promise<string> {
        const tempPath = this.path(extension);
        await fs.writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        if (process.geteuid?.() === 0) {
            const account = SpawnAccounts.configured(this.#env);
            if (account !== null && (account.uid !== 0 || account.gid !== 0)) {
                await fs.chown(tempPath, account.uid, account.gid);
            }
        }
        return tempPath;
    }
}

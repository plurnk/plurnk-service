import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import HostPaths from "../core/HostPaths.ts";

// {§exec-scratch-directory} — the one directory a standalone execution source is written to for
// its run. Empty derives the XDG runtime directory, else the platform temporary directory.
export default class ExecScratch {
    static readonly KNOB = "PLURNK_SERVICE_EXEC_SCRATCH";

    static directory(env: NodeJS.ProcessEnv = process.env): string {
        const paths = new HostPaths({ env });
        const configured = env[ExecScratch.KNOB];
        if (configured === undefined || configured.length === 0) return paths.runtimeDir ?? tmpdir();
        const expanded = paths.expandUserPath(configured);
        if (!isAbsolute(expanded)) throw new RangeError(`${ExecScratch.KNOB} must be an absolute directory path.`);
        return resolve(expanded);
    }

    readonly #directory: string;

    constructor(env: NodeJS.ProcessEnv = process.env) {
        this.#directory = ExecScratch.directory(env);
    }

    get directory(): string {
        return this.#directory;
    }

    // Creates the directory on first use (0700) and probes it for writing: the failure's code
    // when it cannot be used, null when it can.
    async unavailable(): Promise<string | null> {
        try {
            await mkdir(this.#directory, { recursive: true, mode: 0o700 });
            await access(this.#directory, constants.W_OK);
            return null;
        } catch (cause) {
            return cause instanceof Error && "code" in cause ? String(cause.code) : String(cause);
        }
    }

    path(extension: string): string {
        return join(this.#directory, `plurnk-exec-${crypto.randomUUID()}${extension}`);
    }
}

// {§daemon-launch} — the service's own launcher: spawn the daemon executable, await its readiness
// line ({§startup-readiness-line}), hand back the address it published and a stop that is
// SIGTERM-and-wait. It touches no filesystem state of its own: what a launcher keeps or removes
// after stop is that launcher's policy, never this helper's.
import { spawn, type ChildProcess } from "node:child_process";

export interface LaunchOptions {
    // The daemon's argv, executable first — the installed `plurnk-service start`, a pinned
    // runtime's entry, or the source entry under its own conditions.
    readonly command: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd?: string;
    // {§state-root} — roots everything the daemon writes; absent means the daemon's own layout.
    readonly stateRoot?: string;
    readonly host?: string;
    readonly port?: number;
    // How long readiness may take; the caller states it, the helper holds no number of its own.
    readonly readyTimeoutMs: number;
    // How long a SIGTERM may take before SIGKILL.
    readonly stopGraceMs: number;
    readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export type LaunchFailureKind = "spawn" | "exited" | "timeout";

export class LaunchError extends Error {
    readonly kind: LaunchFailureKind;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;

    constructor(kind: LaunchFailureKind, message: string, detail: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; cause?: unknown }) {
        super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
        this.name = "LaunchError";
        this.kind = kind;
        this.code = detail.code;
        this.signal = detail.signal;
        this.stdout = detail.stdout;
        this.stderr = detail.stderr;
    }
}

export interface LaunchedDaemon {
    readonly url: string;
    readonly host: string;
    readonly port: number;
    readonly dbPath: string;
    readonly route: string;
    readonly child: ChildProcess;
    stdout(): string;
    stderr(): string;
    // SIGTERM, wait up to the grace, SIGKILL; resolves with how the process ended. Idempotent.
    stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

// {§startup-readiness-line} — the one line the daemon prints when it is ready.
export const READINESS_LINE = /^plurnk-service agui=(http:\/\/([^:\s]+):(\d+)) db=(\S+) (.*)$/mu;

export default class Launch {
    static async start(options: LaunchOptions): Promise<LaunchedDaemon> {
        const [executable, ...args] = options.command;
        if (executable === undefined) throw new TypeError("Launch.start: command needs an executable");
        const env: NodeJS.ProcessEnv = { ...options.env };
        if (options.stateRoot !== undefined) env.PLURNK_SERVICE_STATE_ROOT = options.stateRoot;
        if (options.host !== undefined) env.PLURNK_HOST = options.host;
        if (options.port !== undefined) env.PLURNK_PORT = String(options.port);
        const child = spawn(executable, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => { stdout += chunk; options.onOutput?.("stdout", chunk); });
        child.stderr!.on("data", (chunk: string) => { stderr += chunk; options.onOutput?.("stderr", chunk); });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => {
            child.once("exit", (code, signal) => accept({ code, signal }));
        });
        let stopping: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
        const stop = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
            stopping ??= (async () => {
                // A spawn that never produced a process has nothing to stop and never emits exit.
                if (child.pid === undefined) return { code: null, signal: null };
                if (child.exitCode !== null || child.signalCode !== null) return exited;
                child.kill("SIGTERM");
                const graceful = await Promise.race([
                    exited.then(() => true),
                    new Promise<boolean>((accept) => setTimeout(() => accept(false), options.stopGraceMs).unref()),
                ]);
                if (!graceful && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
                return exited;
            })();
            return stopping;
        };

        const ready = await new Promise<RegExpExecArray>((accept, reject) => {
            const timer = setTimeout(() => reject(new LaunchError("timeout", `the daemon did not publish its readiness line within ${options.readyTimeoutMs} ms`, { code: null, signal: null, stdout, stderr })), options.readyTimeoutMs);
            const check = (): void => {
                const match = READINESS_LINE.exec(stdout);
                if (match === null) return;
                clearTimeout(timer);
                accept(match);
            };
            child.stdout!.on("data", check);
            child.once("error", (cause) => {
                clearTimeout(timer);
                reject(new LaunchError("spawn", `the daemon could not be spawned: ${cause.message}`, { code: null, signal: null, stdout, stderr, cause }));
            });
            void exited.then(({ code, signal }) => {
                clearTimeout(timer);
                reject(new LaunchError("exited", `the daemon exited before readiness (code ${code}, signal ${signal})`, { code, signal, stdout, stderr }));
            });
            check();
        }).catch(async (error: unknown) => {
            // A failed start is stopped and awaited; nothing on disk is touched.
            await stop();
            if (error instanceof LaunchError) {
                throw new LaunchError(error.kind, error.message, { code: error.code, signal: error.signal, stdout, stderr, cause: error.cause });
            }
            throw error;
        });
        return {
            url: ready[1]!,
            host: ready[2]!,
            port: Number(ready[3]),
            dbPath: ready[4]!,
            route: ready[5]!,
            child,
            stdout: () => stdout,
            stderr: () => stderr,
            stop,
        };
    }
}

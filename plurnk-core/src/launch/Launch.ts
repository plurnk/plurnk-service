// {§daemon-launch} — the service's own launcher: spawn the daemon executable, await its readiness
// line ({§startup-readiness-line}), hand back the address it published and a stop that is
// SIGTERM-and-wait. It touches no filesystem state of its own beyond the caller's log file: what a
// launcher keeps or removes after stop is that launcher's policy, never this helper's.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

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
    // private (the default): the launcher's child, both streams piped to it. shared: its own
    // process group, both streams appended to `logFile`, released after readiness so the launcher
    // may exit while the daemon survives; until readiness the launcher owns it either way.
    readonly lifetime?: "private" | "shared";
    readonly logFile?: string;
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
    // What the daemon wrote up to readiness (a shared daemon's log is not read further).
    stdout(): string;
    stderr(): string;
    // SIGTERM, wait up to the grace, SIGKILL; resolves with how the process ended. Idempotent.
    stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

type Ended = { code: number | null; signal: NodeJS.Signals | null };

// {§startup-readiness-line} — the one line the daemon prints when it is ready: a URL, then the
// database path and the route as JSON strings, so a path or route with spaces parses exactly.
export const READINESS_LINE = /^plurnk-service agui=(\S+) db=("(?:[^"\\]|\\.)*") route=("(?:[^"\\]|\\.)*")$/mu;

const LOG_POLL_MS = 50;

export default class Launch {
    static async start(options: LaunchOptions): Promise<LaunchedDaemon> {
        const [executable, ...args] = options.command;
        if (executable === undefined) throw new TypeError("Launch.start: command needs an executable");
        const shared = options.lifetime === "shared";
        if (shared && options.logFile === undefined) throw new TypeError("Launch.start: a shared daemon needs a logFile for its output");
        const env: NodeJS.ProcessEnv = { ...options.env };
        if (options.stateRoot !== undefined) env.PLURNK_SERVICE_STATE_ROOT = options.stateRoot;
        if (options.host !== undefined) env.PLURNK_HOST = options.host;
        if (options.port !== undefined) env.PLURNK_PORT = String(options.port);

        let stdout = "";
        let stderr = "";
        // A shared daemon's output goes to its log from the first byte; the launcher reads that
        // file only until readiness, from where it stood at spawn, and retains nothing after.
        const logStart = shared ? Launch.#sizeOf(options.logFile!) : 0;
        const logFd = shared ? openSync(options.logFile!, "a") : undefined;
        const child = spawn(executable, args, {
            cwd: options.cwd,
            env,
            detached: shared,
            stdio: logFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", logFd, logFd],
        });
        if (logFd !== undefined) closeSync(logFd);
        if (!shared) {
            child.stdout!.setEncoding("utf8");
            child.stderr!.setEncoding("utf8");
            child.stdout!.on("data", (chunk: string) => { stdout += chunk; options.onOutput?.("stdout", chunk); });
            child.stderr!.on("data", (chunk: string) => { stderr += chunk; options.onOutput?.("stderr", chunk); });
        }
        const exited = new Promise<Ended>((accept) => {
            child.once("exit", (code, signal) => accept({ code, signal }));
        });
        let stopping: Promise<Ended> | undefined;
        const stop = (): Promise<Ended> => {
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
            let settled = false;
            const settle = (outcome: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (poll !== undefined) clearInterval(poll);
                outcome();
            };
            const timer = setTimeout(() => settle(() => reject(new LaunchError("timeout", `the daemon did not publish its readiness line within ${options.readyTimeoutMs} ms`, { code: null, signal: null, stdout, stderr }))), options.readyTimeoutMs);
            const check = (): void => {
                const match = READINESS_LINE.exec(stdout);
                if (match !== null) settle(() => accept(match));
            };
            let reading = false;
            const poll = shared ? setInterval(() => {
                if (reading) return;
                reading = true;
                void Launch.#readFrom(options.logFile!, logStart + Buffer.byteLength(stdout)).then((chunk) => {
                    reading = false;
                    if (chunk.length === 0) return;
                    stdout += chunk;
                    options.onOutput?.("stdout", chunk);
                    check();
                }, (cause: unknown) => settle(() => reject(cause)));
            }, LOG_POLL_MS) : undefined;
            if (!shared) child.stdout!.on("data", check);
            child.once("error", (cause) => settle(() => reject(new LaunchError("spawn", `the daemon could not be spawned: ${cause.message}`, { code: null, signal: null, stdout, stderr, cause }))));
            void exited.then(({ code, signal }) => {
                // The log may still hold the exit's last words; one final read before judging.
                const finish = (): void => settle(() => reject(new LaunchError("exited", `the daemon exited before readiness (code ${code}, signal ${signal})`, { code, signal, stdout, stderr })));
                if (!shared) { finish(); return; }
                void Launch.#readFrom(options.logFile!, logStart + Buffer.byteLength(stdout)).then((chunk) => { stdout += chunk; finish(); }, finish);
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
        // Released: the launcher's event loop no longer waits on a shared daemon, which is in its
        // own process group and answers to nothing here but an explicit stop().
        if (shared) child.unref();
        const url = new URL(ready[1]!);
        return {
            url: ready[1]!,
            host: url.hostname,
            port: Number(url.port),
            dbPath: JSON.parse(ready[2]!) as string,
            route: JSON.parse(ready[3]!) as string,
            child,
            stdout: () => stdout,
            stderr: () => stderr,
            stop,
        };
    }

    static #sizeOf(path: string): number {
        try { return statSync(path).size; } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
            throw cause;
        }
    }

    static async #readFrom(path: string, offset: number): Promise<string> {
        const handle = await open(path, "r");
        try {
            const { size } = await handle.stat();
            if (size <= offset) return "";
            const buffer = Buffer.alloc(size - offset);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            return buffer.subarray(0, bytesRead).toString("utf8");
        } finally { await handle.close(); }
    }
}

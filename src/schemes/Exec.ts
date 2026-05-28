import { spawn } from "node:child_process";
import type { ExecStatement, FindStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import { readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { ReadResult, ShowHideResult } from "./_entry-ops.ts";
import { readEntry, writeEntry, deleteEntry } from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import { findSessionEntries } from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import {
    appendToChannel, setChannelState,
    openSubscription, closeSubscription,
} from "../core/ChannelWrite.ts";

type ExecResult = { status: number; body?: string; attrs?: object; error?: string };

interface ExecAttrs {
    runtime: string;        // "" (default shell), "sh", "bash", "node", "python", etc.
    cwd: string | null;     // working directory, or null = daemon's cwd
    command: string;        // body of the EXEC op
    pathname: string;       // auto-generated: r-<uuid8>; entry lives at exec://<pathname>
}

interface SpawnOutcome {
    exitCode: number;
    aborted: boolean;
}

// Per plurnk.md, EXEC's target slot is `cwd`. ParsedPath there means a
// bare local path or file:// URL — both decode to a filesystem directory.
// Anything else is rejected at proposal time.
const cwdFromTarget = (target: ExecStatement["target"]): string | null => {
    if (target === null) return null;
    if (target.kind === "local") return target.raw;
    if (target.kind === "url" && (target.scheme === null || target.scheme === "file")) {
        return target.pathname;
    }
    return null;
};

const runtimeToSpawnArgs = (runtime: string, command: string): { cmd: string; args: string[]; useShell: boolean } => {
    // plurnk.md: "EXEC may include an optional runtime tag ("sh", "node", etc.)."
    // Map common runtimes to their invocation. Default = shell.
    if (runtime === "" || runtime === "sh" || runtime === "bash") {
        return { cmd: command, args: [], useShell: true };
    }
    if (runtime === "node") return { cmd: "node", args: ["-e", command], useShell: false };
    if (runtime === "python" || runtime === "python3") return { cmd: "python3", args: ["-c", command], useShell: false };
    // Unknown runtime: fall through to shell with the runtime as the first arg
    // (treat as `<runtime> -c <command>` style). Conservative.
    return { cmd: runtime, args: ["-c", command], useShell: false };
};

const streamShellCommand = async (
    runtime: string,
    command: string,
    cwd: string | null,
    db: Db,
    streamEventNotify: PlurnkSchemeContext["streamEventNotify"],
    entryId: number,
    signal: AbortSignal,
): Promise<SpawnOutcome> => {
    const { cmd, args, useShell } = runtimeToSpawnArgs(runtime, command);
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(cmd, args, {
            shell: useShell,
            signal,
            cwd: cwd ?? undefined,
        });
        const pending: Promise<void>[] = [];
        child.stdout.on("data", (chunk: Buffer) => {
            pending.push(appendToChannel(db, {
                entryId, channel: "stdout", chunk: chunk.toString("utf8"), notify: streamEventNotify,
            }));
        });
        child.stderr.on("data", (chunk: Buffer) => {
            pending.push(appendToChannel(db, {
                entryId, channel: "stderr", chunk: chunk.toString("utf8"), notify: streamEventNotify,
            }));
        });
        child.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "ABORT_ERR") {
                Promise.all(pending).then(() => {
                    resolvePromise({ exitCode: -1, aborted: true });
                }).catch(rejectPromise);
                return;
            }
            rejectPromise(err);
        });
        child.on("close", (code, killedBySignal) => {
            Promise.all(pending).then(() => {
                resolvePromise({
                    exitCode: code ?? -1,
                    aborted: killedBySignal !== null,
                });
            }).catch(rejectPromise);
        });
    });
};

export default class Exec {
    static manifest: SchemeManifest = {
        name: "exec",
        channels: { stdout: "text/plain", stderr: "text/plain" },
        defaultChannel: "stdout",
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
        flags: {
            excludedInAsk: true,
            proposes: true,
        },
    };

    #activeAborts = new Map<number, AbortController>();
    #activeSpawns = new Map<number, Promise<void>>();

    async idle(): Promise<void> {
        await Promise.allSettled([...this.#activeSpawns.values()]);
    }

    // EXEC op handler — the actual model-facing entry point per plurnk.md.
    // `<<EXEC[runtime](cwd):command:EXEC` →
    //   signal=runtime, target=cwd (ParsedPath local/file or null), body=command.
    //
    // Proposes (status=202) with attrs={runtime, cwd, command, pathname}.
    // applyResolution spawns the subprocess; output streams into the
    // auto-generated exec://<pathname> entry's stdout/stderr channels.
    // The model READs that entry on a subsequent turn to see what happened.
    async exec(statement: ExecStatement, ctx: PlurnkSchemeContext): Promise<ExecResult> {
        const command = statement.body ?? "";
        if (command.length === 0) {
            return { status: 400, error: "EXEC requires a command body" };
        }
        if (statement.target !== null) {
            if (statement.target.kind === "url" && statement.target.scheme !== null && statement.target.scheme !== "file") {
                return { status: 400, error: `EXEC cwd must be a local path or file:// URL; got ${statement.target.scheme}://` };
            }
        }

        const runtime = typeof statement.signal === "string" ? statement.signal : "";
        const KNOWN_RUNTIMES = new Set(["", "sh", "bash", "node", "python", "python3"]);
        if (!KNOWN_RUNTIMES.has(runtime)) {
            return { status: 501, error: `\`${runtime}\` executable not configured.` };
        }
        const cwdFromOp = cwdFromTarget(statement.target);
        // Default cwd to the session's project_root so EXEC runs in the
        // same directory File scheme writes to. Without this default, the
        // model creates a file via EDIT (lands in project_root) and then
        // EXECs (runs in daemon cwd) and can't find what it just wrote.
        // Explicit (cwd) in the EXEC statement still wins.
        let cwd: string | null = cwdFromOp;
        if (cwd === null) {
            const sessionRow = await (ctx.db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: ctx.sessionId });
            cwd = sessionRow?.project_root ?? null;
        }
        // Auto-generated pathname so the model can READ exec://<pathname> later.
        // Short random suffix keeps it readable while remaining unique within a session.
        const pathname = `r-${crypto.randomUUID().slice(0, 8)}`;
        const attrs: ExecAttrs = { runtime, cwd, command, pathname };
        // Body shown to client during proposal review — `$ command` is the
        // most-readable summary regardless of runtime.
        const preview = runtime !== "" ? `[${runtime}] ${command}` : `$ ${command}`;
        return { status: 202, body: preview, attrs };
    }

    async applyResolution(
        args: { attrs: object; body?: string },
        ctx: PlurnkSchemeContext,
    ): Promise<{ status: number; outcome?: string; body?: string }> {
        const attrs = args.attrs as Partial<ExecAttrs>;
        const command = attrs.command;
        const pathname = attrs.pathname;
        const runtime = typeof attrs.runtime === "string" ? attrs.runtime : "";
        const cwd = (typeof attrs.cwd === "string" && attrs.cwd.length > 0) ? attrs.cwd : null;
        if (typeof command !== "string" || command.length === 0) {
            return { status: 500, outcome: "missing_command" };
        }
        if (typeof pathname !== "string" || pathname.length === 0) {
            return { status: 500, outcome: "missing_pathname" };
        }

        const seed: EntryData = {
            channels: {
                stdout: { content: "", mimetype: "text/plain", state: "active" },
                stderr: { content: "", mimetype: "text/plain", state: "active" },
            },
            tags: [],
        };
        const { entryId } = await writeEntry(pathname, seed, ctx, "exec");
        if (entryId === null) return { status: 500, outcome: "entry_write_failed" };

        const subscriptionId = await openSubscription(ctx.db, {
            runId: ctx.runId, entryId, scheme: "exec",
            handle: runtime !== "" ? `${runtime}: ${command}` : command,
        });

        const controller = new AbortController();
        if (ctx.signal !== undefined) {
            if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
            else ctx.signal.addEventListener("abort", () => controller.abort(ctx.signal!.reason), { once: true });
        }
        this.#activeAborts.set(subscriptionId, controller);

        const tail = this.#runSpawn({
            runtime, command, cwd, db: ctx.db,
            streamEventNotify: ctx.streamEventNotify,
            wakeRunNotify: ctx.wakeRunNotify,
            sessionId: ctx.sessionId, runId: ctx.runId, pathname,
            entryId, subscriptionId, signal: controller.signal,
        });
        this.#activeSpawns.set(subscriptionId, tail);

        return { status: 200, outcome: "started" };
    }

    async #runSpawn(opts: {
        runtime: string; command: string; cwd: string | null; db: Db;
        streamEventNotify: PlurnkSchemeContext["streamEventNotify"];
        wakeRunNotify: PlurnkSchemeContext["wakeRunNotify"];
        sessionId: number; runId: number; pathname: string;
        entryId: number; subscriptionId: number; signal: AbortSignal;
    }): Promise<void> {
        const { runtime, command, cwd, db, streamEventNotify, wakeRunNotify,
            sessionId, runId, pathname, entryId, subscriptionId, signal } = opts;
        let closeStatus = 500;
        let exitLabel = "spawn_failed";
        let stdoutLength = 0;
        let stderrLength = 0;
        try {
            let outcome: SpawnOutcome;
            try {
                outcome = await streamShellCommand(runtime, command, cwd, db, streamEventNotify, entryId, signal);
            } catch (err) {
                await setChannelState(db, { entryId, channel: "stdout", state: "errored", notify: streamEventNotify });
                await setChannelState(db, { entryId, channel: "stderr", state: "errored", notify: streamEventNotify });
                await closeSubscription(db, { subscriptionId, status: 500 });
                console.error("exec spawn_failed:", err instanceof Error ? err.message : String(err));
                closeStatus = 500;
                exitLabel = "spawn_failed";
                return;
            }
            closeStatus = outcome.aborted ? 499 : outcome.exitCode === 0 ? 200 : 500;
            exitLabel = outcome.aborted ? "aborted" : `exit ${outcome.exitCode}`;
            const terminalState = outcome.exitCode === 0 && !outcome.aborted ? "closed" : "errored";
            await setChannelState(db, { entryId, channel: "stdout", state: terminalState, notify: streamEventNotify });
            await setChannelState(db, { entryId, channel: "stderr", state: terminalState, notify: streamEventNotify });
            await closeSubscription(db, { subscriptionId, status: closeStatus });

            const stdoutMeta = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel: "stdout" });
            const stderrMeta = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel: "stderr" });
            stdoutLength = stdoutMeta?.contentLength ?? 0;
            stderrLength = stderrMeta?.contentLength ?? 0;
        } finally {
            this.#activeAborts.delete(subscriptionId);
            this.#activeSpawns.delete(subscriptionId);

            if (wakeRunNotify !== undefined) {
                wakeRunNotify({
                    sessionId, runId, entryId, subscriptionId, closeStatus,
                    scheme: "exec",
                    summary: `exec://${pathname} completed (${exitLabel}); stdout=${stdoutLength} bytes, stderr=${stderrLength} bytes`,
                });
            }
        }
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return readSessionEntry(statement, ctx, Exec.manifest);
    }

    async show(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return showSessionEntry(statement, ctx, Exec.manifest);
    }

    async hide(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return hideSessionEntry(statement, ctx, Exec.manifest);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return findSessionEntries(statement, ctx, Exec.manifest.name);
    }

    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return readEntry(pathname, ctx, Exec.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        return writeEntry(pathname, entry, ctx, Exec.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        return deleteEntry(pathname, ctx, Exec.manifest.name);
    }
}

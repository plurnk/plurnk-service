import { spawn } from "node:child_process";
import type { EditStatement, FindStatement, HideStatement, ReadStatement, SendStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import { readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { ReadResult, ShowHideResult } from "./_entry-ops.ts";
import { readEntry, writeEntry, deleteEntry } from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import { findSessionEntries } from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";

type EditResult = { status: number; body?: string; attrs?: object; error?: string };
type SendResult = { status: number; error?: string };

interface ExecAttrs {
    command: string;
    pathname: string;
}

const pathnameOf = (target: EditStatement["target"]): string | null => {
    if (target === null) return null;
    return target.kind === "url" ? target.pathname : target.raw;
};

// Spawn the command in a shell and collect stdout/stderr in full. v0
// captures the complete output then writes channels in one shot — the
// model only sees turn-boundary state, so incremental writes during the
// run buy nothing today. E.2 will switch to incremental writes + an
// active subscription row for SEND[499] cancellation.
interface SpawnOutcome {
    stdout: string;
    stderr: string;
    exitCode: number;     // 0 on clean exit; non-zero on failure; -1 on abort
    aborted: boolean;
}

const runShellCommand = async (command: string, signal: AbortSignal | undefined): Promise<SpawnOutcome> => {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, { shell: true, signal });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        child.on("error", (err) => {
            // AbortError fires when the signal aborts mid-run. Treat as a
            // clean cancellation outcome rather than a hard reject so the
            // caller can still record what we captured.
            if ((err as NodeJS.ErrnoException).code === "ABORT_ERR") {
                resolvePromise({
                    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                    stderr: Buffer.concat(stderrChunks).toString("utf8"),
                    exitCode: -1,
                    aborted: true,
                });
                return;
            }
            rejectPromise(err);
        });
        child.on("close", (code, killedBySignal) => {
            resolvePromise({
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8"),
                exitCode: code ?? -1,
                aborted: killedBySignal !== null,
            });
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
            excludedInAsk: true,   // exec is side-effecting; ask mode is read-only
            proposes: true,         // exec runs via proposal lifecycle unless yolo
        },
    };

    // EDIT proposes a subprocess run. The body is the command; the path
    // is the entry coordinate the model will READ later to see results.
    // Engine pauses dispatch on 202; applyResolution actually spawns.
    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        const pathname = pathnameOf(statement.target);
        if (pathname === null || pathname.length === 0) {
            return { status: 400, error: "EDIT requires an exec://<id> target" };
        }
        if (statement.lineMarker !== null) {
            return { status: 501, error: "lineMarker on exec EDIT not supported" };
        }
        const command = statement.body ?? "";
        if (command.length === 0) {
            return { status: 400, error: "EDIT exec://<id> requires a command in the body" };
        }
        const attrs: ExecAttrs = { command, pathname };
        return {
            status: 202,
            body: `$ ${command}`,   // preview shown to client during proposal review
            attrs,
        };
    }

    // applyResolution: post-accept. Spawn, capture, write entry. Returns
    // status=200 whenever the operation completed (clean OR non-zero exit) —
    // the model's signal for "ran but failed" is channel.state=errored and
    // log_entries.outcome=exit_N. Status=500 is reserved for engine-fault
    // errors (missing attrs, write failure). This matches the engine's
    // proposal contract: a >=400 from applyResolution is treated as
    // apply_failed and downgrades the resolution to a reject, which is NOT
    // what "command exited 1" means.
    async applyResolution(
        args: { attrs: object; body?: string },
        ctx: PlurnkSchemeContext,
    ): Promise<{ status: number; outcome?: string; body?: string }> {
        const attrs = args.attrs as Partial<ExecAttrs>;
        const command = attrs.command;
        const pathname = attrs.pathname;
        if (typeof command !== "string" || command.length === 0) {
            return { status: 500, outcome: "missing_command" };
        }
        if (typeof pathname !== "string" || pathname.length === 0) {
            return { status: 500, outcome: "missing_pathname" };
        }

        const outcome = await runShellCommand(command, ctx.signal);
        const terminalState = outcome.exitCode === 0 ? "closed" : "errored";
        const entryData: EntryData = {
            channels: {
                stdout: { content: outcome.stdout, mimetype: "text/plain", state: terminalState },
                stderr: { content: outcome.stderr, mimetype: "text/plain", state: terminalState },
            },
            tags: [],
        };
        await writeEntry(pathname, entryData, ctx, "exec");

        return {
            status: 200,
            outcome: outcome.aborted
                ? "aborted"
                : outcome.exitCode === 0
                    ? "exit_0"
                    : `exit_${outcome.exitCode}`,
        };
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

    // SEND[499] cancel routing lands in E.3 — needs the subscription
    // registry path + AbortController plumbing. Until then, broadcast
    // SEND ops never target a path (engine routes those separately) and
    // path-targeted SEND to an exec entry isn't a defined op for v0.
    async send(_statement: SendStatement, _ctx: PlurnkSchemeContext): Promise<SendResult> {
        return { status: 501, error: "exec scheme does not yet handle SEND (cancel routing pending E.3)" };
    }
}

import { spawn } from "node:child_process";
import type { EditStatement, FindStatement, HideStatement, ReadStatement, SendStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import { readSessionEntry, showSessionEntry, hideSessionEntry } from "./_entry-ops.ts";
import type { ReadResult, ShowHideResult } from "./_entry-ops.ts";
import { readEntry, writeEntry, deleteEntry } from "./_entry-crud.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import { findSessionEntries } from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import { appendToChannel, setChannelState, openSubscription, closeSubscription } from "../core/ChannelWrite.ts";

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

interface SpawnOutcome {
    exitCode: number;     // 0 on clean exit; non-zero on failure; -1 on abort
    aborted: boolean;
}

// Stream stdout/stderr live: each chunk hits the corresponding channel
// via appendToChannel (which fires the daemon's stream/event notifier
// for any WS clients on the session). On close, the channel state
// flips static → closed/errored. ctx.signal aborts the subprocess; the
// child_process spawn binding wires this in for us, and the
// AbortError path ends with the channels at state=errored.
const streamShellCommand = async (
    command: string,
    ctx: PlurnkSchemeContext,
    entryId: number,
): Promise<SpawnOutcome> => {
    const { db, streamEventNotify } = ctx;
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, { shell: true, signal: ctx.signal });
        // Push promise queue so we don't race appends against close. Each
        // `data` event registers an in-flight append; close awaits the
        // whole queue before resolving.
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

    // applyResolution: post-accept. Create the entry with two empty
    // active channels FIRST, open the subscription row, then spawn —
    // chunks arriving from stdout/stderr land via appendToChannel
    // (which also fires stream/event for WS clients). On exit, channels
    // transition active → closed (clean) or → errored (non-zero / aborted)
    // and the subscription row closes.
    //
    // Always returns status=200 for completed runs. Failure mode lives in
    // log_entries.outcome (exit_N / aborted) and channel.state — not in
    // the dispatch status — because the engine's proposal contract treats
    // applyResolution >=400 as "apply_failed reject" which would lose the
    // captured output to the model.
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

        const seed: EntryData = {
            channels: {
                stdout: { content: "", mimetype: "text/plain", state: "active" },
                stderr: { content: "", mimetype: "text/plain", state: "active" },
            },
            tags: [],
        };
        const { entryId } = await writeEntry(pathname, seed, ctx, "exec");
        if (entryId === null) return { status: 500, outcome: "entry_write_failed" };

        // handle = the command — gives forensics a non-empty string. v0
        // doesn't reuse the row across cancellation; the subscription
        // exists for E.3 SEND[499] routing (find_active_subscription).
        const subscriptionId = await openSubscription(ctx.db, {
            runId: ctx.runId, entryId, scheme: "exec", handle: command,
        });

        let outcome: SpawnOutcome;
        try {
            outcome = await streamShellCommand(command, ctx, entryId);
        } catch (err) {
            // Hard spawn failure: subscription closes at 500, both channels
            // flip to errored, applyResolution surfaces a stable shape.
            await setChannelState(ctx.db, { entryId, channel: "stdout", state: "errored", notify: ctx.streamEventNotify });
            await setChannelState(ctx.db, { entryId, channel: "stderr", state: "errored", notify: ctx.streamEventNotify });
            await closeSubscription(ctx.db, { subscriptionId, status: 500 });
            return { status: 500, outcome: "spawn_failed", body: err instanceof Error ? err.message : String(err) };
        }

        const closeStatus = outcome.aborted ? 499 : outcome.exitCode === 0 ? 200 : 500;
        const terminalState = outcome.exitCode === 0 && !outcome.aborted ? "closed" : "errored";
        await setChannelState(ctx.db, { entryId, channel: "stdout", state: terminalState, notify: ctx.streamEventNotify });
        await setChannelState(ctx.db, { entryId, channel: "stderr", state: terminalState, notify: ctx.streamEventNotify });
        await closeSubscription(ctx.db, { subscriptionId, status: closeStatus });

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

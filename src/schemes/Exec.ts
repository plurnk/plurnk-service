import { spawn } from "node:child_process";
import type { EditStatement, FindStatement, HideStatement, ReadStatement, SendStatement, ShowStatement } from "@plurnk/plurnk-grammar";
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
    openSubscription, closeSubscription, findActiveSubscription,
} from "../core/ChannelWrite.ts";

type EditResult = { status: number; body?: string; attrs?: object; error?: string };
type SendResult = { status: number; error?: string };

interface ExecAttrs {
    command: string;
    pathname: string;
}

interface SpawnOutcome {
    exitCode: number;     // 0 on clean exit; non-zero on failure; -1 on abort
    aborted: boolean;
}

const pathnameOf = (target: EditStatement["target"] | SendStatement["target"]): string | null => {
    if (target === null) return null;
    return target.kind === "url" ? target.pathname : target.raw;
};

// Stream stdout/stderr live: each chunk lands in entry_channels via
// appendToChannel (which also fires stream/event for any WS clients on
// the session). The subprocess's AbortSignal is owned per-spawn by Exec
// (#activeAborts), so SEND[499] can route a cancel here even though
// applyResolution already returned.
const streamShellCommand = async (
    command: string,
    db: Db,
    streamEventNotify: PlurnkSchemeContext["streamEventNotify"],
    entryId: number,
    signal: AbortSignal,
): Promise<SpawnOutcome> => {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, { shell: true, signal });
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

    // Per-spawn abort controllers, keyed by subscriptionId. SEND[499]
    // looks up the subscription for an entry, finds its controller
    // here, and fires it.
    #activeAborts = new Map<number, AbortController>();

    // Per-spawn completion promises so the daemon can await all
    // in-flight execs on shutdown (and tests can await individual
    // runs without polling DB state).
    #activeSpawns = new Map<number, Promise<void>>();

    /**
     * Test helper: resolves when every in-flight spawn finalizes its
     * state transitions + subscription close. Production daemon shutdown
     * uses the same surface to drain cleanly.
     */
    async idle(): Promise<void> {
        await Promise.allSettled([...this.#activeSpawns.values()]);
    }

    async edit(statement: EditStatement, _ctx: PlurnkSchemeContext): Promise<EditResult> {
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
        return { status: 202, body: `$ ${command}`, attrs };
    }

    // applyResolution: seed the entry with active channels, open the
    // subscription, kick off the spawn IN BACKGROUND, return 200
    // immediately. SPEC §7.1: streaming scheme "returns immediately and
    // stays alive." The model gets a fast log entry + sees the channels
    // grow on subsequent turn boundaries; SEND[499] can route an abort
    // while applyResolution is long gone.
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

        const subscriptionId = await openSubscription(ctx.db, {
            runId: ctx.runId, entryId, scheme: "exec", handle: command,
        });

        // Spawn's signal is a fresh per-subscription controller, chained
        // to ctx.signal so a run-level abort cascades. SEND[499] aborts
        // the same controller via #activeAborts lookup.
        const controller = new AbortController();
        if (ctx.signal !== undefined) {
            if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
            else ctx.signal.addEventListener("abort", () => controller.abort(ctx.signal!.reason), { once: true });
        }
        this.#activeAborts.set(subscriptionId, controller);

        // Background tail: stream, transition state, close subscription,
        // clean up registry. Awaiting this is the daemon-shutdown + test
        // path; the dispatch path doesn't.
        const tail = this.#runSpawn({
            command, db: ctx.db, streamEventNotify: ctx.streamEventNotify,
            entryId, subscriptionId, signal: controller.signal,
        });
        this.#activeSpawns.set(subscriptionId, tail);

        return { status: 200, outcome: "started" };
    }

    async #runSpawn(opts: {
        command: string; db: Db; streamEventNotify: PlurnkSchemeContext["streamEventNotify"];
        entryId: number; subscriptionId: number; signal: AbortSignal;
    }): Promise<void> {
        const { command, db, streamEventNotify, entryId, subscriptionId, signal } = opts;
        try {
            let outcome: SpawnOutcome;
            try {
                outcome = await streamShellCommand(command, db, streamEventNotify, entryId, signal);
            } catch (err) {
                await setChannelState(db, { entryId, channel: "stdout", state: "errored", notify: streamEventNotify });
                await setChannelState(db, { entryId, channel: "stderr", state: "errored", notify: streamEventNotify });
                await closeSubscription(db, { subscriptionId, status: 500 });
                // Swallow — applyResolution already returned; nothing to
                // raise to. Forensics live in subscription.close_status.
                console.error("exec spawn_failed:", err instanceof Error ? err.message : String(err));
                return;
            }
            const closeStatus = outcome.aborted ? 499 : outcome.exitCode === 0 ? 200 : 500;
            const terminalState = outcome.exitCode === 0 && !outcome.aborted ? "closed" : "errored";
            await setChannelState(db, { entryId, channel: "stdout", state: terminalState, notify: streamEventNotify });
            await setChannelState(db, { entryId, channel: "stderr", state: terminalState, notify: streamEventNotify });
            await closeSubscription(db, { subscriptionId, status: closeStatus });
        } finally {
            this.#activeAborts.delete(subscriptionId);
            this.#activeSpawns.delete(subscriptionId);
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

    // SEND[499]<exec://x> routes to the active subscription's
    // AbortController. The spawn's close handler does the channel
    // transitions + subscription close idempotently — no double-write
    // because closeSubscription's WHERE clause filters on closed_at IS
    // NULL. Other SEND suffixes are not defined for exec at v0.
    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<SendResult> {
        if (statement.suffix !== "499") {
            return { status: 501, error: `exec scheme handles SEND[499] only; got SEND[${statement.suffix}]` };
        }
        const pathname = pathnameOf(statement.target);
        if (pathname === null || pathname.length === 0) {
            return { status: 400, error: "SEND[499] requires an exec://<id> target" };
        }
        const entryRow = await (ctx.db.crud_find_session_entry as PrepMethod).get<{ id: number }>({
            session_id: ctx.sessionId, scheme: "exec", pathname,
        });
        if (entryRow === undefined) return { status: 404, error: "exec entry not found" };
        const sub = await findActiveSubscription(ctx.db, { runId: ctx.runId, entryId: entryRow.id });
        if (sub === null) return { status: 404, error: "no active subscription on exec entry to cancel" };
        const controller = this.#activeAborts.get(sub.id);
        if (controller === undefined) {
            // Subscription is active in the DB but we don't own the
            // AbortController in-process. This happens after a daemon
            // restart while a stale subscription row sits open — there's
            // no live process to abort. Close the row so the model sees
            // a definite outcome.
            await closeSubscription(ctx.db, { subscriptionId: sub.id, status: 499 });
            return { status: 200, error: "subscription was orphaned; closed at 499" };
        }
        controller.abort("SEND[499]");
        return { status: 200 };
    }
}

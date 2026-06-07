import type { ExecStatement, FindStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import { isKnownRuntime, SubprocessExecutor } from "@plurnk/plurnk-execs";
import type { ChannelState } from "@plurnk/plurnk-execs";
import type { PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryFind from "./_entry-find.ts";
import type { ReadResult, ShowHideResult } from "./_entry-ops.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import ChannelWrite from "../core/ChannelWrite.ts";

type ExecResult = { status: number; body?: string; attrs?: object; error?: string };

interface ExecAttrs {
    runtime: string;        // "" (default shell), "sh", "bash", "node", "python", etc.
    cwd: string | null;     // working directory, or null = daemon's cwd
    command: string;        // body of the EXEC op
    pathname: string;       // auto-generated: r-<uuid8>; entry lives at exec://<pathname>
}

// Single SubprocessExecutor instance handles every subprocess runtime
// (`sh`/`bash`/`node`/`python`/`python3`/...). Per the discovery-driven
// model (plurnk-execs#1), specific runtimes will be served by sibling
// executor packages (`plurnk-execs-search` for non-subprocess work,
// dedicated subprocess siblings for runtime-specific configuration).
// Until that registry exists service-side, the universal SubprocessExecutor
// from the framework covers every KNOWN_RUNTIME the resolver handles.
const subprocessExecutor = new SubprocessExecutor({ runtime: "subprocess", glyph: "🐚" });

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

export default class Exec {
    static manifest: SchemeManifest = {
        name: "exec",
        channels: { stdout: "text/stream", stderr: "text/stream" },
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
        if (!isKnownRuntime(runtime)) {
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
        // Pathname is assigned by Engine.#writeLog from the log coordinate
        // (<loop_seq>/<turn_seq>/<sequence>/EXEC), so the exec entry's URI
        // mirrors its log row's URI on the same coordinate. `pathname` is
        // stamped into attrs at log-write time; applyResolution reads it
        // back here.
        const attrs: ExecAttrs = { runtime, cwd, command, pathname: "" };
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

        // Seed channels from the executor's declared topology (Q1 (b)
        // in plurnk-service#174 — executor declares, scheme honors).
        // SubprocessExecutor declares stdout + stderr; future executors
        // may declare different shapes (search → results, etc.).
        const seedChannels: EntryData["channels"] = {};
        for (const [name, decl] of Object.entries(subprocessExecutor.channels)) {
            seedChannels[name] = {
                content: "",
                mimetype: decl.mimetype,
                state: decl.defaultState ?? "active",
            };
        }
        const seed: EntryData = { channels: seedChannels, tags: [] };
        const { entryId } = await EntryCrud.writeEntry(pathname, seed, ctx, "exec");
        if (entryId === null) return { status: 500, outcome: "entry_write_failed" };

        const subscriptionId = await ChannelWrite.openSubscription(ctx.db, {
            runId: ctx.runId, entryId, scheme: "exec",
            handle: runtime !== "" ? `${runtime}: ${command}` : command,
        });

        const controller = new AbortController();
        if (ctx.signal !== undefined) {
            if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
            else ctx.signal.addEventListener("abort", () => controller.abort(ctx.signal!.reason), { once: true });
        }
        this.#activeAborts.set(subscriptionId, controller);

        const tail = this.#runExecutor({
            runtime, command, cwd, ctx, pathname,
            entryId, subscriptionId, signal: controller.signal,
        });
        this.#activeSpawns.set(subscriptionId, tail);

        return { status: 200, outcome: "started" };
    }

    // Bridge the executor's sink-style contract (write/setState/emit)
    // onto plurnk-service's storage primitives (appendToChannel,
    // setChannelState, ctx.pushTelemetry). Per plurnk-service#174 Q3,
    // executor TelemetryEvents flow through the same engine path as
    // grammar parse_errors — emit → buffer → next packet + live notify.
    //
    // write() and setState() callbacks must run in emission order:
    // appendToChannel reads channel state AFTER the append commits, so
    // a setState("closed") that races a prior write() can flip the
    // notify's reported state to "closed" before the chunk event fires
    // as "active." Chain through a single promise queue to serialize.
    async #runExecutor(opts: {
        runtime: string; command: string; cwd: string | null; ctx: PlurnkSchemeContext;
        pathname: string; entryId: number; subscriptionId: number; signal: AbortSignal;
    }): Promise<void> {
        const { runtime, command, cwd, ctx, pathname, entryId, subscriptionId, signal } = opts;
        const db = ctx.db;
        let queue: Promise<void> = Promise.resolve();
        const enqueue = (op: () => Promise<void>): void => {
            queue = queue.then(op, op);
        };
        let closeStatus = 500;
        let exitLabel = "spawn_failed";
        let stdoutLength = 0;
        let stderrLength = 0;
        try {
            const result = await subprocessExecutor.run({
                runtime, command, cwd, signal,
                write: (channel, chunk) => enqueue(() => ChannelWrite.appendToChannel(db, {
                    entryId, channel, chunk, notify: ctx.streamEventNotify,
                })),
                setState: (channel, state: ChannelState) => enqueue(() => ChannelWrite.setChannelState(db, {
                    entryId, channel, state, notify: ctx.streamEventNotify,
                })),
                emit: (event) => {
                    ctx.pushTelemetry?.(event);
                },
            });
            // Drain the queue so the subscription doesn't close before
            // final chunk events / state transitions have committed.
            await queue;

            const exitCode = result.exitCode ?? -1;
            closeStatus = result.status;
            exitLabel = closeStatus === 499 ? "aborted"
                : closeStatus === 500 && exitCode === -1 ? "spawn_failed"
                : `exit ${exitCode}`;
            await ChannelWrite.closeSubscription(db, { subscriptionId, status: closeStatus });

            const stdoutMeta = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel: "stdout" });
            const stderrMeta = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel: "stderr" });
            stdoutLength = stdoutMeta?.contentLength ?? 0;
            stderrLength = stderrMeta?.contentLength ?? 0;
        } finally {
            this.#activeAborts.delete(subscriptionId);
            this.#activeSpawns.delete(subscriptionId);

            if (ctx.wakeRunNotify !== undefined) {
                ctx.wakeRunNotify({
                    sessionId: ctx.sessionId, runId: ctx.runId,
                    entryId, subscriptionId, closeStatus,
                    scheme: "exec",
                    summary: `exec://${pathname} completed (${exitLabel}); stdout=${stdoutLength} bytes, stderr=${stderrLength} bytes`,
                });
            }
        }
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readSessionEntry(statement, ctx, Exec.manifest);
    }

    async show(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return EntryOps.showSessionEntry(statement, ctx, Exec.manifest);
    }

    async hide(statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext): Promise<ShowHideResult> {
        return EntryOps.hideSessionEntry(statement, ctx, Exec.manifest);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findSessionEntries(statement, ctx, Exec.manifest);
    }

    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, Exec.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        return EntryCrud.writeEntry(pathname, entry, ctx, Exec.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        return EntryCrud.deleteEntry(pathname, ctx, Exec.manifest.name);
    }
}

import type { ExecStatement, FindStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { ChannelState } from "@plurnk/plurnk-execs";
import type { Executor } from "../core/ExecutorRegistry.ts";
import EffectPolicy from "./EffectPolicy.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryFind from "./_entry-find.ts";
import type { ReadResult } from "./_entry-ops.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import ChannelWrite, { type StreamCoordinate } from "../core/ChannelWrite.ts";
import ExecEnv from "./exec-env.ts";
import ExecAbort from "./exec-abort.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ExecResult = { status: number; body?: string; attrs?: object; error?: string };

interface ExecAttrs {
    runtime: string;        // "" (default shell), "sh", "bash", "node", "python", etc.
    cwd: string | null;     // working directory, or null = daemon's cwd
    command: string;        // body of the EXEC op
    pathname: string;       // stamped by Engine.#writeLog as /<loop>/<turn>/<seq>; entry persists under the RUNTIME TAG scheme — <runtime>:///<pathname> (e.g. sh:///1/1/2), §exec/#240. exec:// is process-control only.
    inline?: boolean;       // effect=read/pure → auto-run (no human gate); output streams like any exec
    schemeTarget?: { scheme: string; pathname: string; fragment: string | null };  // #201 — a plurnk-scheme target resolved to content at apply-time (empty body → run-as-command; non-empty body → temp-materialize to cwd)
    timeoutSec?: number;    // grammar 0.74.20 — `<T,P>` mark[0]: kill the spawn after T seconds (504). Absent/≤0 = unbounded.
    pollSec?: number;       // grammar 0.74.20 — `<T,P>` mark[1]: while the loop hibernates (202), wake it every P seconds to check this stream. Absent/≤0 = no poll-wake. {§exec-poll}
}

// Executors are discovered + probed at boot into ExecutorRegistry and reach
// the scheme through ctx.executors (plurnk-service#181). Each runtime tag
// resolves to its sibling executor; the scheme itself stays runtime-agnostic.

// Per plurnk.md, EXEC's target slot is `cwd`. ParsedPath there means a
// bare local path or file:/// URL — both decode to a filesystem directory.
// Anything else is rejected at proposal time.
const cwdFromTarget = (target: ExecStatement["target"]): string | null => {
    if (target === null) return null;
    if (target.kind === "local") return target.raw;
    if (target.kind === "url" && (target.scheme === null || target.scheme === "file")) {
        return target.pathname;
    }
    return null;
};

// #201 — a plurnk-scheme target (known/exec/log/…), distinct from file/local
// (which cwdFromTarget handles as a path). Its content is resolved at apply-time;
// executors stay scheme-blind (SPEC §5), so the scheme — not the executor — reads it.
const schemeTargetOf = (target: ExecStatement["target"]): { scheme: string; pathname: string; fragment: string | null } | null => {
    if (target === null || target.kind !== "url") return null;
    if (target.scheme === null || target.scheme === "file") return null;
    return { scheme: target.scheme, pathname: target.pathname, fragment: target.fragment };
};

// EXEC's pathname is <runtime>/<loop_seq>/<turn_seq>/<sequence> (stamped by
// Engine.#writeLog). Exec owns this convention, so it — not the client — turns
// the pathname into the entry's coordinate, mirrored onto stream payloads so
// waterfall clients read fields instead of parsing the URI (#224). The
// coordinate is the trailing three segments (runtime-agnostic); a pathname that
// isn't a numeric triple yields undefined (no coordinate on the wire).
const coordinateFromPathname = (pathname: string): StreamCoordinate | undefined => {
    const seg = pathname.split("/").filter(Boolean);
    if (seg.length < 3) return undefined;
    const [loop_seq, turn_seq, sequence] = seg.slice(-3).map(Number);
    if (![loop_seq, turn_seq, sequence].every(Number.isInteger)) return undefined;
    return { loop_seq, turn_seq, sequence };
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
        example: "<<EXEC[sqlite]:SELECT 22.0 / 7.0:EXEC",
        documentation: "Runs a command in a runtime — `<<EXEC[runtime](cwd):command:EXEC` — output streams into the run's `<runtime>:///<loop>/<turn>/<seq>` entry, channels stdout/stderr. A host-effecting command proposes for review before it runs; a read-only/pure one runs ungated. Either way you never fetch the output: the engine surfaces each turn's new stream bytes to you automatically — folded while the command runs, opened when it finishes.",
        flags: {
            excludedInAsk: true,
        },
    };

    #activeAborts = new Map<number, { runId: number; pathname: string; controller: AbortController; unlink: () => void }>();
    #activeSpawns = new Map<number, Promise<number>>();

    async idle(): Promise<void> {
        await Promise.allSettled([...this.#activeSpawns.values()]);
    }

    // Whether the run has an in-flight spawn (a background exec). The daemon
    // reads this only for loop.cancel's cancelled=true/false answer — the
    // teardown itself rides the run's cancellation scope (the spawn's
    // ctx.signal), so even a spawn registering after the cancel self-aborts.
    hasActiveSpawns(runId: number): boolean {
        for (const { runId: r } of this.#activeAborts.values()) if (r === runId) return true;
        return false;
    }

    // Process-KILL (plurnk-service#203). A running (host/background) exec is
    // addressable by its coordinate pathname; KILL aborts that spawn's controller with
    // the model's signal — KILL[code] → exactly that signal once (KILL[9] = SIGKILL), a
    // bare KILL → the executor's SIGHUP default. The model owns escalation, so there
    // is no auto-escalation here. The full #203 status matrix: 200 killed (in-flight) · 410
    // killed-earlier (a prior abort closed the stream 499) · 304 already-exited (closed
    // with any other terminal status) · 404 unknown (no subscription for that coordinate).
    async kill(pathname: string, signal: number | null, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        for (const entry of this.#activeAborts.values()) {
            if (entry.pathname === pathname) {
                entry.controller.abort(ExecAbort.killReason(signal));
                return { status: 200 };
            }
        }
        // Not running — settle the outcome from the closed subscription's status.
        const terminal = await ChannelWrite.execTerminalStatus(ctx.db, { sessionId: ctx.sessionId, pathname });
        if (terminal === null) return { status: 404, error: `no exec at exec://${pathname}` };
        if (terminal === 499) return { status: 410, error: `exec://${pathname} was killed earlier` };
        return { status: 304 };
    }

    // Registry-routed reap (§run-lifecycle-total-reap): the daemon's cancel iterates
    // the run's open subscriptions and calls this per id, aborting the spawn's
    // controller directly. Idempotent — a no-op if the spawn already finished or this
    // id isn't ours. Distinct from kill (by pathname, the model's KILL op): this is by
    // subscription id, the run-level reap that does not depend on the signal listener.
    // Always a teardown — the bounded housekeeping reap, never the model's bare signal.
    abortSubscription(subscriptionId: number): void {
        this.#activeAborts.get(subscriptionId)?.controller.abort(ExecAbort.teardownReason());
    }

    // EXEC op handler — the actual model-facing entry point per plurnk.md.
    // `<<EXEC[runtime](cwd):command:EXEC` →
    //   signal=runtime, target=cwd (ParsedPath local/file or null), body=command.
    //
    // Proposes (status=202) with attrs={runtime, cwd, command, pathname}.
    // applyResolution spawns the subprocess; output streams into the
    // coordinate-stamped <runtime>:///<pathname> entry's stdout/stderr channels
    // (e.g. sh:///1/1/2, §exec/#240). The model READs that entry on a subsequent turn.
    async exec(statement: ExecStatement, ctx: PlurnkSchemeContext): Promise<ExecResult> {
        const command = statement.body ?? "";
        // #201 — a plurnk-scheme target carries content the scheme resolves at
        // apply-time; an empty body is then legal (the target IS the script).
        const schemeTarget = schemeTargetOf(statement.target);
        if (command.length === 0 && schemeTarget === null) {
            return { status: 400, error: "EXEC requires a command body (or a scheme target to run)" };
        }

        const requested = typeof statement.signal === "string" ? statement.signal : "";
        const runtime = requested === "" ? "sh" : requested; // empty signal = default shell
        if (ctx.executors === undefined) throw new Error("exec dispatched without an executor registry");
        const resolved = ctx.executors.entry(runtime); // registry resolves the runtime tag; unknown/unavailable → 501 — §exec-registry-resolves
        if (resolved === undefined) {
            return { status: 501, error: `\`${runtime}\` is not a configured runtime. available: ${ctx.executors.availableRuntimes().join(", ")}` };
        }
        if (!resolved.available) {
            const why = resolved.detail === undefined ? "" : `: ${resolved.detail}`;
            return { status: 501, error: `\`${runtime}\` is unavailable${why}` };
        }
        const cwdFromOp = cwdFromTarget(statement.target);
        // Effect on the RAW target (pre-cwd-default) decides the lifecycle:
        // host → propose, read/pure → auto-run inline (plurnk-service#182).
        const policy = EffectPolicy.decide(resolved.executor.effect(cwdFromOp));  // pure/read auto-run ungated — §exec-readpure-ungated
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
        // Pathname is assigned by Engine.#writeLog as <runtime>/<loop_seq>/
        // <turn_seq>/<sequence> (executor-domain + coordinate, e.g. sh/1/1/2).
        // `pathname` is stamped into attrs at log-write time; applyResolution
        // reads it back here.
        // grammar 0.74.20 — EXEC repurposes the `<L>` slot as `<timeout, poll>` (seconds): mark[0]
        // caps the spawn's lifetime, mark[1] sets the hibernation poll-wake cadence (§exec-poll).
        const marks = statement.lineMarker?.marks;
        const timeoutSec = typeof marks?.[0] === "number" && marks[0] > 0 ? Math.floor(marks[0]) : undefined;
        const pollSec = typeof marks?.[1] === "number" && marks[1] > 0 ? Math.floor(marks[1]) : undefined;
        const attrs: ExecAttrs = {
            runtime, cwd, command, pathname: "", inline: policy === "auto",
            ...(schemeTarget !== null ? { schemeTarget } : {}),
            ...(timeoutSec !== undefined ? { timeoutSec } : {}),
            ...(pollSec !== undefined ? { pollSec } : {}),
        };
        // Body shown to client during proposal review — `$ command` is the
        // most-readable summary regardless of runtime.
        const preview = runtime !== "" ? `[${runtime}] ${command}` : `$ ${command}`;
        return { status: 202, body: preview, attrs };  // host runtime proposes with 202 — §exec-host-proposes
    }

    async applyResolution(
        args: { attrs: object; body?: string },
        ctx: PlurnkSchemeContext,
    ): Promise<{ status: number; outcome?: string; body?: string }> {
        const attrs = args.attrs as Partial<ExecAttrs>;
        let command = typeof attrs.command === "string" ? attrs.command : "";
        const pathname = attrs.pathname;
        const runtime = (typeof attrs.runtime === "string" && attrs.runtime !== "") ? attrs.runtime : "sh";
        let cwd = (typeof attrs.cwd === "string" && attrs.cwd.length > 0) ? attrs.cwd : null;
        if (typeof pathname !== "string" || pathname.length === 0) {
            return { status: 500, outcome: "missing_pathname" };
        }

        // #201 — resolve a scheme-URI target to content (executors stay scheme-blind).
        // Empty body → the resolved content IS the command (run a stored script).
        // Non-empty body → materialize the content to a temp file whose path becomes
        // the runtime-interpreted cwd (the data source for filters/sqlite/wasm).
        let tempPath: string | null = null;
        if (attrs.schemeTarget !== undefined) {
            const { scheme, pathname: tPath, fragment } = attrs.schemeTarget;
            const read = await EntryCrud.readEntry(tPath, ctx, scheme);
            if (read.entry === null) return { status: 404, outcome: "scheme_target_not_found" };
            const channels = read.entry.channels;
            const channelName = fragment ?? (channels.body !== undefined ? "body" : Object.keys(channels)[0]);
            const content = channelName === undefined ? undefined : channels[channelName]?.content;
            if (content === undefined) return { status: 404, outcome: "scheme_target_channel_not_found" };
            if (command.length === 0) {
                command = content;
            } else {
                tempPath = join(tmpdir(), `plurnk-exec-${ctx.sessionId}-${pathname.replace(/[^a-zA-Z0-9]/g, "-")}`);
                await writeFile(tempPath, content, "utf8");
                cwd = tempPath;
            }
        }
        if (command.length === 0) {
            return { status: 500, outcome: "missing_command" };
        }

        // Resolve the runtime's executor from the boot registry, then seed
        // channels from its declared topology (Q1(b) in plurnk-service#174 —
        // executor declares, scheme honors). Each executor declares its own
        // shape (subprocess → stdout/stderr; search → results; etc.).
        if (ctx.executors === undefined) return { status: 500, outcome: "no_executor_registry" };
        const resolved = ctx.executors.entry(runtime);
        if (resolved === undefined) return { status: 500, outcome: "no_executor" };
        const seedChannels: EntryData["channels"] = {};
        for (const [name, decl] of Object.entries(resolved.executor.channels)) {
            seedChannels[name] = {
                content: "",
                mimetype: decl.mimetype,
                state: decl.defaultState ?? "active",
            };
        }
        const seed: EntryData = { channels: seedChannels, tags: [] };
        // §exec — the stream entry's scheme IS the runtime tag (sh/node), so it addresses by
        // tag authority (sh:///l/t/s). The engine registers each runtime tag → this handler.
        const { entryId } = await EntryCrud.writeEntry(pathname, seed, ctx, runtime);
        if (entryId === null) return { status: 500, outcome: "entry_write_failed" };

        const subscriptionId = await ChannelWrite.openSubscription(ctx.db, {
            runId: ctx.runId, entryId, scheme: runtime,
            handle: runtime !== "" ? `${runtime}: ${command}` : command,
        });

        const controller = new AbortController();
        let unlink = (): void => {};
        if (ctx.signal !== undefined) {
            const parent = ctx.signal;
            // The spawn's kill binds to its loop's cancellation epoch (ctx.signal —
            // captured here, stable for the loop). The parent only aborts on FORCEFUL loop
            // teardown — a 202-graceful loop lets its spawns outlive, never firing this — so
            // the reason is always the bounded housekeeping reap. Attach the listener FIRST,
            // then re-check `aborted`: a listener added to an already-aborted signal never
            // fires, so a check-then-attach order LOSES an abort that lands in the gap (R1's
            // TOCTOU leak). Attach-then-check closes it; controller.abort is idempotent, so a
            // doubled fire is harmless. §run-lifecycle-exec-loop-bound
            const onParentAbort = (): void => controller.abort(ExecAbort.teardownReason());
            parent.addEventListener("abort", onParentAbort, { once: true });
            unlink = (): void => parent.removeEventListener("abort", onParentAbort);
            if (parent.aborted) controller.abort(ExecAbort.teardownReason());
        }
        this.#activeAborts.set(subscriptionId, { runId: ctx.runId, pathname, controller, unlink });

        const tail = this.#runExecutor({
            executor: resolved.executor,
            runtime, command, cwd, ctx, pathname,
            entryId, subscriptionId, signal: controller.signal, controller, tempPath,
            timeoutSec: typeof attrs.timeoutSec === "number" ? attrs.timeoutSec : null,
        });

        // Every exec backgrounds + streams (§exec-stream): no same-turn receipt — the output
        // surfaces as the environment-observation injector's delta on the next turn (folded while
        // it runs, opened when it finishes). Pure/read commands still auto-accept (attrs.inline =
        // no human gate); they just resolve a turn later, uniformly with host streams.
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
        executor: Executor;
        runtime: string; command: string; cwd: string | null; ctx: PlurnkSchemeContext;
        pathname: string; entryId: number; subscriptionId: number; signal: AbortSignal;
        controller: AbortController; timeoutSec: number | null;
        tempPath: string | null;
    }): Promise<number> {
        const { executor, runtime, command, cwd, ctx, pathname, entryId, subscriptionId, signal, controller, timeoutSec, tempPath } = opts;
        const db = ctx.db;
        const coordinate = coordinateFromPathname(pathname);  // #224 — stamped on stream/event + stream/concluded
        // grammar 0.74.20 EXEC `<T>` — kill the spawn after T seconds. unref'd so a pending timer never
        // holds the process open; cleared in finally so a spawn that finishes first leaves no timer.
        let timedOut = false;
        const timeoutTimer = timeoutSec !== null
            ? setTimeout(() => { timedOut = true; controller.abort(ExecAbort.timeoutReason()); }, timeoutSec * 1000)
            : null;
        timeoutTimer?.unref();
        let queue: Promise<void> = Promise.resolve();
        const enqueue = (op: () => Promise<void>): void => {
            queue = queue.then(op, op);
        };
        let closeStatus = 500;
        let exitLabel = "spawn_failed";
        let stdoutLength = 0;
        let stderrLength = 0;
        try {
            const result = await executor.run({
                runtime, command, cwd, signal,
                env: ExecEnv.scoped(),  // SPEC §exec {§exec-env-scoped} — never plurnk's own secrets
                write: (channel, chunk) => enqueue(() => ChannelWrite.appendToChannel(db, {
                    entryId, channel, chunk, notify: ctx.streamEventNotify, coordinate,
                })),
                setState: (channel, state: ChannelState) => enqueue(() => ChannelWrite.setChannelState(db, {
                    entryId, channel, state, notify: ctx.streamEventNotify, coordinate,
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
            // A timeout aborts the spawn → the executor reports 499; restamp it 504 so the model
            // sees "ran out of time" distinct from a deliberate kill/cancel (§exec-timeout).
            if (timedOut && closeStatus === 499) closeStatus = 504;
            exitLabel = closeStatus === 504 ? `timed out after ${timeoutSec}s`
                : closeStatus === 499 ? "aborted"
                : closeStatus === 500 && exitCode === -1 ? "spawn_failed"
                : `exit ${exitCode}`;
            await ChannelWrite.closeSubscription(db, { subscriptionId, status: closeStatus });

            const stdoutMeta = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel: "stdout" });
            const stderrMeta = await (db.channel_meta as PrepMethod).get<{ contentLength: number }>({ entry_id: entryId, channel: "stderr" });
            stdoutLength = stdoutMeta?.contentLength ?? 0;
            stderrLength = stderrMeta?.contentLength ?? 0;
        } finally {
            if (timeoutTimer !== null) clearTimeout(timeoutTimer); // a finished spawn leaves no pending timer
            // #201 — a materialized data-source temp file outlives the spawn it fed;
            // unlink it once the run settles (open-unlink is safe on Linux).
            if (tempPath !== null) await unlink(tempPath).catch(() => {});
            this.#activeAborts.get(subscriptionId)?.unlink();
            this.#activeAborts.delete(subscriptionId);
            this.#activeSpawns.delete(subscriptionId);

            // Every run backgrounds now (§exec-stream) — wake a parked loop on completion so the
            // run resumes to the turn where the stream's terminal delta surfaces.
            if (ctx.wakeRunNotify !== undefined) {
                ctx.wakeRunNotify({
                    sessionId: ctx.sessionId, runId: ctx.runId,
                    entryId, target: `${runtime}://${pathname}`, subscriptionId, closeStatus,
                    scheme: runtime,
                    summary: `${runtime}://${pathname} completed (${exitLabel}); stdout=${stdoutLength} bytes, stderr=${stderrLength} bytes`,
                    ...coordinate,
                });
            }
        }
        return closeStatus;
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readSessionEntry(statement, ctx, Exec.manifest);
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

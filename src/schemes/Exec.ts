import { parsePath } from "@plurnk/plurnk-grammar";
import type { ExecStatement, FindStatement, ReadStatement, TelemetryEvent } from "@plurnk/plurnk-grammar";
import { Policy, type ChannelState } from "@plurnk/plurnk-execs";
import type { Executor } from "../core/ExecutorRegistry.ts";
import SessionSettings from "../core/session-settings.ts";
import EffectPolicy from "./EffectPolicy.ts";
import type { PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import EntryCrud from "./_entry-crud.ts";
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";
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
    cwd: string | null;     // process working directory = the session workspace (project_root), or null (headless). A relative target resolves against it. (execs 0.4.26 §2)
    target: string | null;  // the parsed (target) slot — the executor's DATA SOURCE (jq input file / sqlite db / wasm module); null = no source (subprocess ignores it). (#15)
    command: string;        // body of the EXEC op
    pathname: string;       // stamped by Dispatcher.#writeLog as /<loop>/<turn>/<seq>; entry persists under the RUNTIME TAG scheme — <runtime>:///<pathname> (e.g. sh:///1/1/2), §exec/#240. exec:// is process-control only.
    inline?: boolean;       // effect=read/pure → auto-run (no human gate); output streams like any exec
    schemeTarget?: { scheme: string; pathname: string; fragment: string | null };  // #201 — a plurnk-scheme target resolved to content at apply-time (empty body → run-as-command; non-empty body → temp-materialize to cwd)
    timeoutSec?: number;    // `<T,P>` mark[0] > 0: kill the spawn after T seconds (504). Absent/-1 = unbounded.
    turnScoped?: boolean;   // `<0>`: turn-scoped — reaped at the run's next pre-turn, never surviving into the subsequent turn. {§exec-poll}
    pollSec?: number;       // `<T,P>` mark[1]: while the loop hibernates (202), wake it every P seconds to check this stream. Absent/≤0 = no poll-wake. {§exec-poll}
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
// Dispatcher.#writeLog). Exec owns this convention, so it — not the client — turns
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
        documentation: "Runs a command in a runtime — `<<EXEC[runtime](cwd):command:EXEC` — output streams into the run's `<runtime>:///<loop>/<turn>/<seq>` entry on the runtime's own channels (a subprocess → stdout/stderr; a computational runtime like sqlite/jq → a JSON `results` channel). A host-effecting command proposes for review before it runs; a read-only/pure one runs ungated. Either way you never fetch the output: the engine surfaces each turn's new stream bytes to you automatically — folded while the command runs, opened when it finishes.",
        flags: {
            excludedInAsk: true,
        },
    };

    #activeAborts = new Map<number, { runId: number; pathname: string; runtime: string; controller: AbortController; unlink: () => void }>();
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

    // §exec-hold-until-concluded — does the run hold an in-flight spawn whose RUNTIME is in the
    // operator's hold set? The turn-hold exception (owner ruling): for streams we know and
    // control (the search family — one final JSON digest, seconds-bounded), the engine holds
    // the next packet until conclusion instead of giving the model a turn it can only waste.
    hasActiveHoldSpawns(runId: number, holdSet: ReadonlySet<string>): boolean {
        for (const { runId: r, runtime } of this.#activeAborts.values()) if (r === runId && holdSet.has(runtime)) return true;
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
        let command = statement.body ?? "";
        // #201 — a plurnk-scheme target carries content the scheme resolves at
        // apply-time; an empty body is then legal (the target IS the script).
        const schemeTarget = schemeTargetOf(statement.target);
        if (command.length === 0 && schemeTarget === null) {
            return { status: 400, error: "EXEC requires a command body (or a scheme target to run)" };
        }

        const requested = typeof statement.signal === "string" ? statement.signal : "";
        let runtime = requested === "" ? "sh" : requested; // empty signal = default shell
        if (ctx.executors === undefined) throw new Error("exec dispatched without an executor registry");
        // §exec-runtime-fallthrough (#350, the execs architect's resolution to the go-501 saga):
        // an UNREGISTERED tag falls through to the shell with the tag as the command word —
        // EXEC[go]:test ./... runs as sh: `go test ./...`. Per-tool runtimes (go/cargo/make/npm)
        // never earn tags (owner, execs#21); this automates the principle. The output entry lands
        // under sh:// (it ran on sh), telemetry records what models reach FOR (the promotion
        // signal is data, not guesswork), and a typo'd tag becomes the shell's own clear 127.
        // No new surface: anything expressible as EXEC[foo]:bar was expressible as EXEC[sh]:foo bar.
        let fellThroughFrom: string | null = null;
        if (requested !== "" && ctx.executors.entry(runtime) === undefined && ctx.executors.entry("sh") !== undefined) {
            fellThroughFrom = runtime;
            command = command.length > 0 ? `${runtime} ${command}` : runtime;
            runtime = "sh";
        }
        // #328 — per-session client policy narrows the boot-registered set (subtractive). A tag the
        // session's client layer disables is ABSENT for this session — refused like an unavailable
        // runtime. Checked on the EFFECTIVE runtime: a fall-through rides sh's gate, so a session
        // that disabled sh gets the refusal, never a side door.
        const sessionExecs = (await SessionSettings.read(ctx.db, ctx.sessionId)).execs;
        if (sessionExecs !== null && !Policy.isEnabled(runtime, sessionExecs)) {
            return { status: 501, error: `\`${runtime}\` is disabled for this session by client policy (PLURNK_EXECS_*)` };
        }
        const resolved = ctx.executors.entry(runtime); // registry resolves the runtime tag; unknown/unavailable → 501 — §exec-registry-resolves
        if (resolved === undefined) {
            return { status: 501, error: `\`${runtime}\` is not a configured runtime. available: ${ctx.executors.availableRuntimes().join(", ")}` };
        }
        if (fellThroughFrom !== null) {
            ctx.pushTelemetry?.({ source: "exec:dispatch", kind: "exec_runtime_fallthrough", message: `EXEC[${fellThroughFrom}] fell through to sh`, requested: fellThroughFrom, level: "info" } as never);
        }
        if (!resolved.available) {
            const why = resolved.detail === undefined ? "" : `: ${resolved.detail}`;
            return { status: 501, error: `\`${runtime}\` is unavailable${why}` };
        }
        // The parsed (target) slot — the executor's DATA SOURCE (jq input file / sqlite db / wasm
        // module; ignored by subprocess). execs 0.4.26 (#15) carries it distinct from cwd.
        const target = cwdFromTarget(statement.target);
        // Effect classifies by the target only, never by parsing the command (#289): host → propose,
        // read/pure → auto-run inline (plurnk-service#182).
        const policy = EffectPolicy.decide(resolved.executor.effect(target, command));
        // cwd is ALWAYS the session WORKSPACE (project_root) — the process working directory a relative
        // target resolves against (execs 0.4.26 §2). The old overload (target-as-cwd) is gone: EXEC runs
        // in the same directory the File scheme writes to, and a data-source runtime resolves its target
        // against it (so EXEC[jq](data/x.json) finds the workspace file, not one at the daemon's cwd).
        const sessionRow = await (ctx.db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: ctx.sessionId });
        const cwd: string | null = sessionRow?.project_root ?? null;
        // Pathname is assigned by Dispatcher.#writeLog as <runtime>/<loop_seq>/
        // <turn_seq>/<sequence> (executor-domain + coordinate, e.g. sh/1/1/2).
        // `pathname` is stamped into attrs at log-write time; applyResolution
        // reads it back here.
        // EXEC repurposes the `<L>` slot as `<timeout, poll>` (seconds): mark[0] caps the spawn's
        // lifetime, mark[1] sets the hibernation poll-wake cadence (§exec-poll). N>0 → deadline (504);
        // -1 / absent → unbounded (loop-life bounded); 0 → turn-scoped (reaped at the next pre-turn,
        // never surviving into the subsequent turn).
        const marks = statement.lineMarker?.marks;
        const timeoutSec = typeof marks?.[0] === "number" && marks[0] > 0 ? Math.floor(marks[0]) : undefined;
        const turnScoped = typeof marks?.[0] === "number" && marks[0] === 0;
        const pollSec = typeof marks?.[1] === "number" && marks[1] > 0 ? Math.floor(marks[1]) : undefined;
        const attrs: ExecAttrs = {
            runtime, cwd, command, target, pathname: "", inline: policy === "auto",
            ...(schemeTarget !== null ? { schemeTarget } : {}),
            ...(timeoutSec !== undefined ? { timeoutSec } : {}),
            ...(turnScoped ? { turnScoped: true } : {}),
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
        const cwd = (typeof attrs.cwd === "string" && attrs.cwd.length > 0) ? attrs.cwd : null;
        let target = (typeof attrs.target === "string" && attrs.target.length > 0) ? attrs.target : null;
        if (typeof pathname !== "string" || pathname.length === 0) {
            return { status: 500, outcome: "missing_pathname" };
        }

        // #201 — resolve a scheme-URI target to content (executors stay scheme-blind).
        // Empty body → the resolved content IS the command (run a stored script).
        // Non-empty body → materialize the content to a temp file whose path becomes
        // the runtime's data-source TARGET (the input for filters/sqlite/wasm).
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
                target = tempPath;
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
            pollSeconds: typeof attrs.pollSec === "number" ? attrs.pollSec : null, // §exec-poll — hibernation wake cadence
            turnScoped: attrs.turnScoped === true, // §exec-poll — `<0>` reaped at the next pre-turn
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
            // doubled fire is harmless. §exec-timeout
            const onParentAbort = (): void => controller.abort(ExecAbort.teardownReason());
            parent.addEventListener("abort", onParentAbort, { once: true });
            unlink = (): void => parent.removeEventListener("abort", onParentAbort);
            if (parent.aborted) controller.abort(ExecAbort.teardownReason());
        }
        this.#activeAborts.set(subscriptionId, { runId: ctx.runId, pathname, runtime, controller, unlink });

        const tail = this.#runExecutor({
            executor: resolved.executor,
            runtime, command, cwd, target, ctx, pathname,
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
        runtime: string; command: string; cwd: string | null; target: string | null; ctx: PlurnkSchemeContext;
        pathname: string; entryId: number; subscriptionId: number; signal: AbortSignal;
        controller: AbortController; timeoutSec: number | null;
        tempPath: string | null;
    }): Promise<number> {
        const { executor, runtime, command, cwd, target, ctx, pathname, entryId, subscriptionId, signal, controller, timeoutSec, tempPath } = opts;
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
        // §exec-entry-sink (#340) — the executor's entry() materialization request. The executor
        // owns zero substrate: it hands us (path, content, {tags, mimetype}) and WE create/update
        // the entry (writeEntry upsert; tags UNIONED — writeEntry alone replaces), then narrate ONE
        // EDIT row in the reserved plurnk run's log (the fs-fiction pattern, source = the calling
        // run) — the existing env-delta ambience folds it into every run's next packet. The row is a
        // FULL fiction: tx carries the statement (body = the written content — the journal records
        // the write, replay/fork-complete), rx carries the span (§edit-result-render, the whole
        // content numbered — a wholesale write's span IS the content; no diff, which would be a
        // pathological cost against a rewritten multi-MB page). Rendered folded by default, so no
        // body rides a packet uninvited — the meta line carries the honest OPEN cost.
        // Serialized: parallel entry() calls (allSettled) write in order; a rejection prunes that
        // survivor executor-side without breaking the chain. Lazy narration context: one plurnk-run
        // turn per spawn, not per entry.
        let entryChain: Promise<unknown> = Promise.resolve();
        let narration: { runId: number; loopId: number; turnId: number; seq: number } | null = null;
        const entrySink = (path: string, content: string, opts: { tags: string[]; mimetype: string }): Promise<void> => {
            const op = async (): Promise<void> => {
                const parsed = parsePath(path);
                if (parsed === null || parsed.kind !== "url" || parsed.scheme === null) throw new Error(`entry(): '${path.slice(0, 80)}' is not a URL`);
                const pathname = foldAuthorityIntoPath(parsed.hostname, parsed.pathname);
                const prior = await EntryCrud.readEntry(pathname, ctx, parsed.scheme);
                const tags = [...new Set([...(prior.entry?.tags ?? []), ...opts.tags])];
                const written = await EntryCrud.writeEntry(pathname, { channels: { body: { content, mimetype: opts.mimetype } }, tags }, ctx, parsed.scheme);
                if (narration === null) {
                    const run = await (db.envelope_get_run_by_name as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, name: "plurnk" })
                        ?? await (db.envelope_insert_run as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, name: "plurnk", origin: "plurnk" });
                    if (run === undefined) throw new Error("entry(): plurnk run resolution returned no row");
                    const loop = await (db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ run_id: run.id });
                    if (loop === undefined) throw new Error("entry(): loop insert returned no row");
                    const seqRow = await (db.client_turn_next_sequence as PrepMethod).get<{ next: number }>({ loop_id: loop.id });
                    const turn = await (db.client_turn_insert as PrepMethod).get<{ id: number }>({ loop_id: loop.id, sequence: seqRow?.next ?? 1, packet: "{}" });
                    if (turn === undefined) throw new Error("entry(): turn insert returned no row");
                    narration = { runId: run.id, loopId: loop.id, turnId: turn.id, seq: 1 };
                }
                await (db.engine_insert_log_entry as PrepMethod).get({
                    run_id: narration.runId, loop_id: narration.loopId, turn_id: narration.turnId, sequence: narration.seq++,
                    // signal carries the tags — the SAME slot a model's EDIT[tags] uses, so the
                    // ambient row renders its tags natively everywhere (packet meta line, digest).
                    origin: "plurnk", source: String(ctx.runId), op: "EDIT", suffix: "", signal: JSON.stringify(tags),
                    scheme: parsed.scheme, username: null, password: null, hostname: null, port: null,
                    pathname, params: null, fragment: null, lineMarker: null,
                    tx: JSON.stringify({ op: "EDIT", body: content }), mimetype_tx: "application/json",
                    rx: JSON.stringify({
                        status: written.status, entryId: written.entryId, tags,
                        span: content.split("\n").map((l, n) => `${n + 1}:\t${l}`).join("\n"),
                    }), mimetype_rx: "application/json",
                    status_rx: written.status, tokens: ctx.tokenize?.(content) ?? 0, state: "resolved", outcome: null,
                    attrs: JSON.stringify({ tags }),
                });
            };
            const run = entryChain.then(op, op);
            entryChain = run.then(() => undefined, () => undefined);
            return run;
        };
        try {
            let result: { status: number; exitCode?: number } | null = null;
            try {
                result = await executor.run({
                    runtime, command, cwd, target, signal,
                    entry: entrySink,
                    env: ExecEnv.scoped(),  // SPEC §exec {§exec-env-scoped} — never plurnk's own secrets
                    write: (channel, chunk) => enqueue(() => ChannelWrite.appendToChannel(db, {
                        entryId, channel, chunk, notify: ctx.streamEventNotify, coordinate,
                    })),
                    setState: (channel, state: ChannelState) => enqueue(() => ChannelWrite.setChannelState(db, {
                        entryId, channel, state, notify: ctx.streamEventNotify, coordinate,
                    })),
                    emit: (event) => {
                        // The executor daughter's TelemetryEvent predates grammar's required `level`;
                        // inject a default (forwarding the producer's own severity when it supplies one). #276
                        const level = (event as { level?: TelemetryEvent["level"] }).level ?? "info";
                        ctx.pushTelemetry?.({ ...event, level } as TelemetryEvent);
                    },
                });
                // Drain the queue so the subscription doesn't close before
                // final chunk events / state transitions have committed.
                await queue;
            } catch (cause) {
                // A rejecting driver must still CONCLUDE its stream — uncaught, the subscription sat
                // open forever and the floating spawn promise was an unhandled rejection.
                exitLabel = `driver_crashed: ${cause instanceof Error ? cause.message : String(cause)}`;
            }

            if (result !== null) {
                const exitCode = result.exitCode ?? -1;
                closeStatus = result.status;
                // A timeout aborts the spawn → the executor reports 499; restamp it 504 so the model
                // sees "ran out of time" distinct from a deliberate kill/cancel (§exec-timeout).
                if (timedOut && closeStatus === 499) closeStatus = 504;
                // The service's own abort knowledge outranks a driver's claim: a spawn we reaped
                // (teardown/kill/cancel) did not succeed, whatever status it resolved under abort.
                if (signal.aborted && !timedOut && closeStatus < 400) { closeStatus = 499; exitLabel = "reaped"; }
                else exitLabel = closeStatus === 504 ? `timed out after ${timeoutSec}s`
                    : closeStatus === 499 ? "aborted"
                    : closeStatus === 500 && exitCode === -1 ? "spawn_failed"
                    : `exit ${exitCode}`;
            }
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

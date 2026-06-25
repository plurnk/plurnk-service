// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the WebSocketServer, and the active client connections.
// SPEC §rpc.

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Db, PrepMethod } from "../core/Db.ts";
import ChannelWrite, { type WakeRunPayload } from "../core/ChannelWrite.ts";
import { Paths } from "../index.ts";
import Engine from "../core/Engine.ts";
import ExecutorRegistry from "../core/ExecutorRegistry.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import PluginLoader from "../core/PluginLoader.ts";
import MethodRegistry from "./MethodRegistry.ts";
import type { DrainLoopResult, NotifyTarget, Provider } from "./MethodRegistry.ts";
import ClientConnection from "./ClientConnection.ts";
import LogEntry from "./logEntry.ts";
import Yolo from "./yolo.ts";
import NoProposals from "./noProposals.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";

import PingMethod from "./methods/ping.ts";
import DiscoverMethod from "./methods/discover.ts";
import SessionCreateMethod from "./methods/session_create.ts";
import SessionListMethod from "./methods/session_list.ts";
import SessionAttachMethod from "./methods/session_attach.ts";
import SessionRunsMethod from "./methods/session_runs.ts";
import SessionPromptsMethod from "./methods/session_prompts.ts";
import SessionSetRootMethod from "./methods/session_set_root.ts";
import SessionRenameMethod from "./methods/session_rename.ts";
import SessionConstraintsMethod from "./methods/session_constraints.ts";
import SessionMembersMethod from "./methods/session_members.ts";
import OpEditMethod from "./methods/op_edit.ts";
import OpReadMethod from "./methods/op_read.ts";
import OpFindMethod from "./methods/op_find.ts";
import OpOpenMethod from "./methods/op_open.ts";
import OpFoldMethod from "./methods/op_fold.ts";
import OpCopyMethod from "./methods/op_copy.ts";
import OpMoveMethod from "./methods/op_move.ts";
import OpSendMethod from "./methods/op_send.ts";
import OpExecMethod from "./methods/op_exec.ts";
import OpDispatchMethod from "./methods/op_dispatch.ts";
import OpParseMethod from "./methods/op_parse.ts";
import LoopRunMethod from "./methods/loop_run.ts";
import LoopCancelMethod from "./methods/loop_cancel.ts";
import LoopInjectMethod from "./methods/loop_inject.ts";
import RunForkMethod from "./methods/run_fork.ts";
import EntryReadMethod from "./methods/entry_read.ts";
import LogReadMethod from "./methods/log_read.ts";
import ProvidersListMethod from "./methods/providers_list.ts";
import LoopResolveMethod from "./methods/loop_resolve.ts";

export interface DaemonOptions {
    host?: string;
    port?: number;
}

export interface DaemonAddress {
    host: string;
    port: number;
}

export default class Daemon {
    #db: Db;
    #engine: Engine;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #provider: Provider | null;
    #registry: MethodRegistry;
    #nodeModulesPath: string;
    #discoveryCwd: string;
    #wss: WebSocketServer | null = null;
    #connections = new Set<ClientConnection>();

    // Run-level drain registry. At most one drain per run. The stored object
    // is the drain's identity handle: start/exit compare it by reference so a
    // drain exiting never clobbers a successor that raced in, and a loop
    // enqueued during teardown is never stranded. A drain is a pure queue
    // consumer (claim → run → exit on empty queue); streams live independently
    // (subscriptions + Exec.idle), and a concluding stream routes through
    // inject() like any other loop source.
    #activeDrains = new Map<number, { controller: AbortController; promise: Promise<unknown> }>();
    // Per-run cancellation scope. Loops AND the streams they spawn (execs)
    // share this signal, so loop.cancel / shutdown abort it once and every
    // in-flight subscription tears down — even a spawn that registers AFTER the
    // cancel self-aborts against the already-aborted signal (no race). Outlives
    // any single (ephemeral) drain; replaced with a fresh controller once
    // aborted so a later loop.run isn't born cancelled.
    #runAborts = new Map<number, AbortController>();
    // grammar 0.74.20 EXEC `<T,P>` — per-run hibernation poll-wake timer. When a loop parks at
    // SEND[202] with a polled stream, a timer fires every P seconds to resume it (§exec-poll). One
    // per run (the tightest cadence); cleared/replaced on each park and on cancel.
    #pollTimers = new Map<number, ReturnType<typeof setTimeout>>();
    // Per-run drain-transition lock — see #withDrainLock (R4 / §run-lifecycle-single-drain).
    #drainLocks = new Map<number, Promise<unknown>>();

    constructor({
        db, schemes, mimetypes, provider, nodeModulesPath,
    }: {
        db: Db;
        schemes?: SchemeRegistry;
        mimetypes?: Mimetypes;
        provider?: Provider | null;
        nodeModulesPath?: string;
    }) {
        this.#db = db;
        this.#schemes = schemes ?? new SchemeRegistry();
        this.#provider = provider ?? null;
        // Plugin discovery resolves from the SERVICE's node_modules (its exec/scheme/mimetype
        // deps), NOT process.cwd() — else a globally-installed daemon started from a project dir
        // finds no plugins. The bin passes the package-relative path; cwd default holds for
        // in-repo tests. discover() takes a cwd and joins node_modules, so derive the parent.
        this.#nodeModulesPath = nodeModulesPath ?? resolve(process.cwd(), "node_modules");
        this.#discoveryCwd = dirname(this.#nodeModulesPath);
        // Mimetypes owns discovery + detection; we inject the tokenize fn (from the provider's
        // countTokens) and default to text/markdown.
        this.#mimetypes = mimetypes ?? new Mimetypes({
            defaultMimetype: "text/markdown",
            discoverOptions: { cwd: this.#discoveryCwd },
        });
        this.#engine = new Engine({
            db, schemes: this.#schemes, mimetypes: this.#mimetypes,
            // Same provider-backed source as the Mimetypes tokenize lambda
            // above; sync here because countTokens is sync (§provider-surface) and the
            // write helpers store the count inline. Divisor tripwire only
            // until a provider is resolved.
            tokenize: (text) => this.#provider?.countTokens(text) ?? Math.ceil(text.length / 4),
            streamEventNotify: (sessionId, event) => this.notifyStreamEvent(sessionId, event),
            wakeRunNotify: (payload) => { void this.#handleWakeRun(payload); },
            // run:// loop-start primitive — spawn/fork/irc deliver through
            // Daemon.inject (active sister → fold; idle → enqueue + drain). The
            // daemon owns provider + the law-file system prompt; the run scheme
            // handler carries neither. Fire-and-forget: the returned drain runs
            // independently (the sister is its own run). §machine-processes
            injectRun: async ({ sessionId, runId, prompt }) => {
                if (this.#provider === null) throw new Error("injectRun: no provider configured");
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const { action, loopId } = await this.inject({ sessionId, runId, prompt, provider: this.#provider, systemPrompt });
                return { action, loopId };
            },
            // run:// KILL (terminate) — abort any run's in-flight work by id. One
            // abort, one scope (Daemon.cancelDrain): the active loop closes 499,
            // background streams tear down. Whoever holds the address may end it.
            cancelRun: (runId) => this.cancelDrain(runId, "killed via run:// KILL"),
            telemetryEventNotify: (sessionId, payload) => this.notifyTelemetryEvent(sessionId, payload),
        });
        this.#registry = new MethodRegistry();
        this.#registerBuiltins();
        this.#registerNotifications();
        // Wire proposal-pending events to the loop/proposal WS notification.
        // Sessionid scopes the broadcast to clients on the same session.
        this.#engine.onProposalPending((event) => {
            this.#broadcast({ sessionId: event.sessionId }, null, "loop/proposal", {
                logEntryId: event.logEntryId,
                loopId: event.loopId,
                turnId: event.turnId,
                op: event.op,
                target: event.target,
                body: event.body,
                attrs: event.attrs,
                // event.flags is carried for discoverability — a client in
                // server-YOLO mode (event.flags.yolo=true) knows to skip
                // rendering review UI because the entry will resolve in-
                // process before any human can react.
                flags: event.flags,
            });
        });
        // In-tree YOLO listener — auto-accepts proposals when the loop's
        // persisted flags.yolo === true. Skips client roundtrip entirely.
        Yolo.attachYolo(this.#engine, this.#db);
        // Inverse of YOLO: auto-REJECT proposals in-process when the loop's
        // persisted flags.noProposals === true (client has no review channel).
        // The model sees an ordinary 400, never the orchestration reason.
        NoProposals.attachNoProposals(this.#engine, this.#db);
    }

    get registry(): MethodRegistry { return this.#registry; }
    get engine(): Engine { return this.#engine; }
    get provider(): Provider | null { return this.#provider; }
    get schemes(): SchemeRegistry { return this.#schemes; }
    get mimetypes(): Mimetypes { return this.#mimetypes; }

    async start({ host = "127.0.0.1", port = 3044 }: DaemonOptions = {}): Promise<DaemonAddress> {
        if (this.#wss !== null) throw new Error("daemon already started");

        await this.#discoverAndLoadPlugins();
        // Mimetypes owns its own discovery scan over @plurnk/plurnk-mimetypes-*
        // packages; pre-warm it so first index render doesn't pay the cost.
        await this.#mimetypes.ready();

        // Discover + probe the installed executor siblings, then hand the
        // registry to the engine for exec dispatch (plurnk-service#181). The
        // shell is the default runtime, so its executor must boot usable.
        const executors = await ExecutorRegistry.build({ defaultRuntime: "sh", cwd: this.#discoveryCwd });
        this.#engine.setExecutors(executors);
        // §exec — mint a scheme per runtime tag so exec output entries address by tag
        // authority (sh:///l/t/s). The "exec" scheme stays for the EXEC op dispatch.
        this.#schemes.registerRuntimeSchemes(executors);
        // Discover external @plurnk/plurnk-schemes-* siblings + register them
        // (agnostic, by plurnk.kind:"scheme"). They light up http://, etc. with
        // no further engine change — #run wraps their ctx in SchemeCtxImpl (#195).
        await this.#schemes.discoverExternal(this.#discoveryCwd);

        return new Promise<DaemonAddress>((resolve, reject) => {
            const wss = new WebSocketServer({ host, port });

            wss.on("listening", () => {
                this.#wss = wss;
                wss.on("connection", (ws: WebSocket) => this.#onConnection(ws));
                const addr = wss.address();
                if (addr === null || typeof addr === "string") {
                    reject(new Error("WebSocketServer.address() returned unexpected value"));
                    return;
                }
                resolve({ host: addr.address, port: addr.port });
            });

            wss.on("error", (err) => {
                if (this.#wss === null) reject(err);
            });
        });
    }

    async stop(): Promise<void> {
        if (this.#wss === null) return;

        for (const conn of this.#connections) conn.close();
        this.#connections.clear();

        await new Promise<void>((resolve, reject) => {
            this.#wss?.close((err) => {
                if (err !== undefined) reject(err);
                else resolve();
            });
        });

        this.#wss = null;

        // Drain order: (1) abort in-flight loops via #activeDrains so
        // strike paths don't keep going, (2) await each drain's promise
        // to completion, (3) drain streaming schemes' background work
        // (exec spawn cleanup, channel writes). Only THEN close the DB
        // upstream — drain queries hit the DB right up until they exit.
        // Abort every run's cancellation scope — stops in-flight loops AND the
        // streams (background execs) linked to them, so idle() doesn't block on
        // a long-running command. Covers runs whose drain already exited but
        // whose exec is still in flight.
        for (const scope of this.#runAborts.values()) { if (!scope.signal.aborted) scope.abort("daemon_stopping"); }
        for (const t of this.#pollTimers.values()) clearTimeout(t); // drop pending hibernation poll-wakes
        this.#pollTimers.clear();
        const drainPromises = [...this.#activeDrains.values()].map((d) => d.promise);
        await Promise.allSettled(drainPromises);
        await this.#drainStreamingSchemes();
    }

    // Per-scheme idle awaits for clean shutdown. New streaming schemes
    // (SSE, WS) add themselves here as they land.
    async #drainStreamingSchemes(): Promise<void> {
        const exec = this.#schemes.get("exec") as { idle?: () => Promise<void> } | undefined;
        if (exec?.idle !== undefined) await exec.idle();
    }

    #registerBuiltins(): void {
        PingMethod.register(this.#registry);
        DiscoverMethod.register(this.#registry);
        SessionCreateMethod.register(this.#registry);
        SessionListMethod.register(this.#registry);
        SessionAttachMethod.register(this.#registry);
        SessionRunsMethod.register(this.#registry);
        SessionPromptsMethod.register(this.#registry);
        SessionSetRootMethod.register(this.#registry);
        SessionRenameMethod.register(this.#registry);
        SessionConstraintsMethod.register(this.#registry);
        SessionMembersMethod.register(this.#registry);
        OpEditMethod.register(this.#registry);
        OpReadMethod.register(this.#registry);
        OpFindMethod.register(this.#registry);
        OpOpenMethod.register(this.#registry);
        OpFoldMethod.register(this.#registry);
        OpCopyMethod.register(this.#registry);
        OpMoveMethod.register(this.#registry);
        OpSendMethod.register(this.#registry);
        OpExecMethod.register(this.#registry);
        OpDispatchMethod.register(this.#registry);
        OpParseMethod.register(this.#registry);
        LoopRunMethod.register(this.#registry);
        LoopCancelMethod.register(this.#registry);
        LoopInjectMethod.register(this.#registry);
        RunForkMethod.register(this.#registry);
        LoopResolveMethod.register(this.#registry);
        EntryReadMethod.register(this.#registry);
        LogReadMethod.register(this.#registry);
        ProvidersListMethod.register(this.#registry);
    }

    #registerNotifications(): void {
        // §notifications-log-entry-notify
        this.#registry.registerNotification("log/entry", {
            description: "A new log_entries row was written; scoped to the connection's attached session.",
            params: { entry: "LogEntry — wire-shape log_entries row" },
        });
        this.#registry.registerNotification("loop/proposal", {
            description: "A side-effecting action emitted a proposal (status=202, state='proposed'); dispatch is paused awaiting client resolution via loop.resolve. Scoped to the connection's attached session.",
            params: {
                logEntryId: "number — the log_entries.id awaiting resolution",
                loopId: "number",
                turnId: "number",
                op: "string — the operation (EDIT, EXEC, etc.)",
                target: "{scheme, pathname} — the resource being acted on",
                body: "string — preview body (udiff for file edits, command summary for exec)",
                attrs: "object — scheme-specific payload (patch, command args, etc.); opaque to engine",
                flags: "{yolo, mode, noWeb, noInteraction, noProposals} — loop's persisted flags. flags.yolo=true means server-side YOLO is active and the engine will auto-accept in-process; clients can skip review UI for those entries.",
            },
        });
        this.#registry.registerNotification("loop/terminated", {
            description: "A loop has reached a terminal status; scoped to the connection's attached session.",
            params: {
                loopId: "number",
                finalStatus: "number — terminal status code (200, 499, etc.)",
                hitMaxTurns: "boolean",
                usage: "{promptTokens, completionTokens, costPico, contextTokens, meta} — summed per-loop totals (#197); contextTokens is the last turn's prompt tokens (#263); meta is the latest turn's OPAQUE provider→client metadata blob (e.g. balancePico), passed through unenforced — the field contract is the provider↔client's, not the service's (#252)",
            },
        });
        // §notifications-stream-event-on-channel-change
        this.#registry.registerNotification("stream/event", {
            description: "A channel's content grew or its state transitioned. Scoped to the entry's session. Metadata-only; clients fetch new content via entry.read or op.read.",
            params: {
                entryId: "number — the entry whose channel changed",
                target: "string — the entry's URI (scheme://pathname); clients route on this without an entryId→URI lookup",
                channel: "string — the channel name",
                state: "string — current state (static, active, closed, errored)",
                contentLength: "number — current length of the channel's content",
                loop_seq: "number? — the entry's loop coordinate (#224); present for coordinate-bearing streams (exec), so clients read it instead of parsing the URI",
                turn_seq: "number? — the entry's turn coordinate",
                sequence: "number? — the entry's sequence coordinate",
            },
        });
        // §notifications-telemetry-event §telemetry-telemetry-event-notify
        this.#registry.registerNotification("telemetry/event", {
            description: "A TelemetryEvent (per @plurnk/plurnk-grammar 0.17.0) was pushed to the loop's telemetry buffer. Same envelope the model sees on the next packet's telemetry.errors[], delivered live for client-side surfacing (debug panel, loop-degrading toasts, session timeline). Sources include `grammar` (parse errors), `engine:rail` (strike, cycle, sudden_death, no_ops, max_commands_exceeded), `scheme:<name>` (action failures, future), and `provider:<vendor>` (provider issues, future). Scoped to the loop's session.",
            params: {
                loopId: "number — the loop that produced the event",
                event: "TelemetryEvent — { source, kind, message?, position?, ...kind-specific }",
            },
        });
        // §notifications-stream-concluded
        this.#registry.registerNotification("stream/concluded", {
            description: "A streaming-scheme subscription closed (the underlying connection / subprocess finished, errored, or was cancelled). Scoped to the entry's session. wakeAction describes whether the daemon opened a fresh loop to surface the conclusion to the model.",
            params: {
                entryId: "number",
                target: "string — the entry's URI (scheme://pathname)",
                subscriptionId: "number",
                scheme: "string — the scheme that owned the subscription (e.g. 'exec')",
                closeStatus: "number — 200 (clean) / 500 (error) / 499 (aborted)",
                summary: "string — one-liner the model gets as a wake prompt",
                wakeAction: "string — 'no-op-active-loop' | 'opened-loop' | 'skipped-aborted' | 'skipped-no-provider'",
                wakeLoopId: "number? — the loop that was opened (only when wakeAction='opened-loop')",
                loop_seq: "number? — the entry's loop coordinate (#224); present for coordinate-bearing streams (exec), so clients read it instead of parsing the URI",
                turn_seq: "number? — the entry's turn coordinate",
                sequence: "number? — the entry's sequence coordinate",
            },
        });
    }

    /**
     * Emit a stream/event notification scoped to the session containing the
     * entry. ChannelWrite helpers (src/core/ChannelWrite.ts) invoke this when
     * they update channel content or state. SPEC §notifications.
     */
    notifyStreamEvent(sessionId: number, event: { entryId: number; channel: string; state: string; contentLength: number }): void {
        this.#broadcast({ sessionId }, null, "stream/event", event);
    }

    /**
     * Emit a telemetry/event notification scoped to the session containing
     * the loop. Engine.#pushTelemetry invokes this for every TelemetryEvent
     * (parse_error, strike, cycle, sudden_death, no_ops, max_commands_exceeded,
     * action_failure) the moment it lands in the loop's telemetry buffer.
     * SPEC §telemetry.
     */
    notifyTelemetryEvent(sessionId: number, payload: { loopId: number; event: object }): void {
        this.#broadcast({ sessionId }, null, "telemetry/event", payload);
    }

    /**
     * Inject a prompt into a run. Two paths:
     *   - Active drain: writes a plurnk:///prompt/<loop>/<next-turn> entry
     *     via Engine.inject. Current loop sees the new prompt at its next
     *     turn. Returns immediately with {action: "injected_next_turn"}.
     *   - No active drain: enqueues a fresh loop with the prompt at
     *     status=100, starts a drain. Returns the drain promise so the
     *     caller can await full completion.
     *
     * Rummy parallel: AgentLoop.inject(). Unified surface — both `loop.run`
     * and wake-on-completion go through this method. §actor-boundary-passive-wake
     */
    async inject(args: {
        sessionId: number; runId: number; prompt: string;
        provider: Provider; systemPrompt: string;
        maxTurns?: number; flags?: { yolo?: boolean }; openPaths?: string[];
    }): Promise<{
        action: "injected_next_turn" | "enqueued_new_loop";
        loopId: number;
        turnSeq?: number;
        firstLoopPromise?: Promise<DrainLoopResult>;
        drainPromise?: Promise<unknown>;
    }> {
        const { sessionId, runId, prompt } = args;
        // Active loop (status=102)? Fold the wake/prompt into its next turn.
        // engine.inject returns null when no loop is currently executing, so
        // we enqueue a fresh loop below and ensure a drain claims it.
        if (this.#activeDrains.has(runId)) {
            const result = await this.#engine.inject(runId, prompt);
            if (result !== null) {
                return { action: "injected_next_turn", loopId: result.loopId, turnSeq: result.turnSeq };
            }
        }

        // Enqueue a fresh loop. Persist flags on the row.
        const seqRow = await (this.#db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ run_id: runId });
        if (seqRow === undefined) throw new Error("inject: next-sequence query returned no row");
        const loopRow = await (this.#db.drain_enqueue_loop as PrepMethod).get<{ id: number }>({
            run_id: runId, sequence: seqRow.next, prompt,
        });
        if (loopRow === undefined) throw new Error("inject: loop enqueue returned no row");
        const loopId = loopRow.id;

        if (args.flags !== undefined) {
            const merged = { ...DEFAULT_LOOP_FLAGS, ...args.flags };
            await (this.#db.engine_set_loop_flags as PrepMethod).run({
                loop_id: loopId, flags: JSON.stringify(merged),
            });
        }
        // #260 — persist client-passed @file paths before the drain claims the loop, so turn 0 foists them.
        if (args.openPaths !== undefined && args.openPaths.length > 0) {
            await (this.#db.engine_set_loop_open_paths as PrepMethod).run({
                loop_id: loopId, open_paths: JSON.stringify(args.openPaths),
            });
        }

        // Guarantee a drain claims the loop we just enqueued. #ensureDrain runs its
        // check-and-start UNDER the per-run drain lock (§run-lifecycle-single-drain),
        // serialized against a draining sibling's teardown relinquish so the two can't
        // both register a drain (R4). A live drain re-claims the loop in its own
        // iteration or its lock-held exit re-claim, so it's never stranded.
        // firstLoopPromise is present only when THIS call started the drain — loop.run
        // keys its fast-path response on that.
        const started = await this.#ensureDrain({
            sessionId, runId, provider: args.provider,
            systemPrompt: args.systemPrompt,
            maxTurns: args.maxTurns ?? Number(process.env.PLURNK_MAX_TURNS ?? "50"),
        });
        return { action: "enqueued_new_loop", loopId, ...(started ?? {}) };
    }

    /**
     * Start a drain for the given run. The drain claims queued loops via
     * drain_claim_next_loop (atomic 100→102 flip), executes each via
     * Engine.runLoop, and re-checks. Stream-aware: when the queue is empty
     * but the run has active subscriptions, the drain parks on a
     * #drainPokes signal — wake-on-completion → inject() wakes it. Drain
     * exits when queue is empty AND no active subscriptions remain.
     *
     * Returns both `firstLoopPromise` (resolves once the first loop the
     * drain processes completes — used by loop.run to give the caller a
     * fast response containing their loop's result) and `drainPromise`
     * (resolves only when the whole drain finishes, queue+subs settled).
     */
    #startDrain(opts: {
        sessionId: number; runId: number; provider: Provider;
        systemPrompt: string; maxTurns: number;
    }): {
        firstLoopPromise: Promise<DrainLoopResult>;
        drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
    } {
        const { sessionId, runId, provider, systemPrompt, maxTurns } = opts;
        // The drain runs under the run's cancellation scope (shared with the
        // execs its loops spawn), so loop.cancel/shutdown abort it as a unit.
        const controller = this.#runSignal(runId);
        const handle: { controller: AbortController; promise: Promise<unknown> } = {
            controller, promise: Promise.resolve(),
        };

        let resolveFirst: (v: DrainLoopResult) => void = () => {};
        let rejectFirst: (e: unknown) => void = () => {};
        const firstLoopPromise = new Promise<DrainLoopResult>((res, rej) => {
            resolveFirst = res; rejectFirst = rej;
        });
        let firstSettled = false;

        const claim = () => (this.#db.drain_claim_next_loop as PrepMethod).get<{
            id: number; sequence: number; prompt: string;
        }>({ run_id: runId });

        const drainPromise = (async () => {
            let loopsDrained = 0;
            let lastResult: DrainLoopResult | null = null;
            let currentLoopId: number | null = null; // the loop being drained — for the #204 abort→499 resolution below
            try {
                while (true) {
                    controller.signal.throwIfAborted();
                    let loopRow = await claim();
                    if (loopRow === undefined) {
                        // Queue empty → teardown UNDER the per-run drain lock (R4 / I1),
                        // serialized against #ensureDrain so a concurrent inject can't
                        // start a 2nd drain in the gap. Re-claim while holding the lock;
                        // relinquish the registry slot only if it's empty too. A loop
                        // that raced in is returned and run — we stay registered, so
                        // there's no transient delete for #ensureDrain to catch.
                        loopRow = await this.#withDrainLock(runId, async () => {
                            const claimed = await claim();
                            if (claimed === undefined && this.#activeDrains.get(runId) === handle) {
                                this.#activeDrains.delete(runId);
                            }
                            return claimed;
                        });
                        if (loopRow === undefined) break;
                    }
                    currentLoopId = loopRow.id;
                    const onDispatch = (logEntryId: number): void => {
                        void (async () => {
                            const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                            this.#broadcast({ sessionId }, null, "log/entry", { entry });
                        })();
                    };
                    const result = await this.#engine.runLoop({
                        provider, sessionId, runId, loopId: loopRow.id, maxTurns,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: loopRow.prompt },
                        ],
                        origin: "model",
                        onDispatch,
                        signal: controller.signal,
                    });
                    if (result.finalStatus === 202) {
                        // The loop SLEPT (SEND[202]) — suspended, not terminated. Leave it at 202
                        // (resumable); no loop/terminated, no orphan-reconcile. A stream conclusion
                        // (#handleWakeRun) re-queues it; and if it holds a polled stream, a poll timer
                        // wakes it every P to inspect (§exec-poll). §run-lifecycle-wake-liveness.
                        void this.#schedulePollWake(sessionId, runId, provider, systemPrompt);
                        continue;
                    }
                    const usage = await this.#engine.loopUsage(loopRow.id);
                    this.#broadcast({ sessionId }, null, "loop/terminated", {
                        loopId: loopRow.id,
                        finalStatus: result.finalStatus,
                        hitMaxTurns: result.hitMaxTurns,
                        turnIds: result.turnIds,
                        usage,
                    });
                    loopsDrained++;
                    const loopResult: DrainLoopResult = {
                        loopId: loopRow.id,
                        turnIds: result.turnIds,
                        finalStatus: result.finalStatus,
                        hitMaxTurns: result.hitMaxTurns,
                        usage,
                    };
                    lastResult = loopResult;
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst(loopResult);
                    }
                    // A next-turn prompt this loop ended before consuming (a
                    // wake conclusion or a loop.run-while-active) is promoted to
                    // a fresh queued loop so it's never silently dropped.
                    await this.#reconcileOrphanedWake(runId, loopRow.id);
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // #204 / Model 3 — loop.cancel / shutdown aborted the live drain. A cancellation
                    // is the loop's TERMINAL state (499), delivered via loop/terminated (loop.run no
                    // longer blocks to return it). A genuine error rejects firstLoopPromise.
                    const usage = currentLoopId === null
                        ? { promptTokens: 0, completionTokens: 0, costPico: 0, contextTokens: 0, meta: {} }
                        : await this.#engine.loopUsage(currentLoopId);
                    if (currentLoopId !== null) {
                        this.#broadcast({ sessionId }, null, "loop/terminated", {
                            loopId: currentLoopId, finalStatus: 499, hitMaxTurns: false, turnIds: [], usage,
                        });
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst({ loopId: currentLoopId ?? 0, turnIds: [], finalStatus: 499, hitMaxTurns: false, usage });
                    }
                } else {
                    // #265 — a genuine (non-abort) loop error must still reach the client. loop.run only
                    // acked finalStatus:100, so loop/terminated is the sole outcome channel; the rejection
                    // alone reaches no one (firstLoopPromise/drainPromise are .catch()'d). Broadcast 500
                    // (failed) — distinct from an abort's 499 — for every error, not just the pre-first one.
                    if (currentLoopId !== null) {
                        const usage = await this.#engine.loopUsage(currentLoopId);
                        this.#broadcast({ sessionId }, null, "loop/terminated", {
                            loopId: currentLoopId, finalStatus: 500, hitMaxTurns: false, turnIds: [], usage,
                        });
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        rejectFirst(err);
                    }
                }
                throw err;
            } finally {
                if (!firstSettled) {
                    firstSettled = true;
                    rejectFirst(new Error("drain exited without producing a result"));
                }
                if (this.#activeDrains.get(runId) === handle) this.#activeDrains.delete(runId);
            }
            return { loopsDrained, lastResult };
        })();

        handle.promise = drainPromise;
        this.#activeDrains.set(runId, handle);
        // Swallow unhandled rejections (drain aborts with no awaiter); the
        // error already surfaced via firstLoopPromise or was logged inside.
        drainPromise.catch(() => {});
        firstLoopPromise.catch(() => {});
        return { firstLoopPromise, drainPromise };
    }

    // Per-run drain-transition lock (R4 / §run-lifecycle-single-drain). #ensureDrain's
    // start and a drain's teardown relinquish both run under it, serialized, so the two
    // can't interleave and register two drains for one run. The critical section is the
    // registry decision only (never a loop's work) — a sub-ms hop at drain boundaries.
    // A promise-chain mutex: each caller awaits the prior holder; the tail self-prunes
    // when idle so the Map stays bounded to runs mid-transition.
    #withDrainLock<T>(runId: number, fn: () => Promise<T>): Promise<T> {
        const prev = this.#drainLocks.get(runId) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        const tail = run.catch(() => {});
        this.#drainLocks.set(runId, tail);
        void tail.then(() => { if (this.#drainLocks.get(runId) === tail) this.#drainLocks.delete(runId); });
        return run;
    }

    // The drain guarantee, serialized per run via #withDrainLock so it can't race a
    // sibling drain's teardown relinquish into a double-drain (R4). A live drain
    // (registered, NOT aborting) will claim the just-enqueued loop in its own iteration
    // or its lock-held exit re-claim → return null. A registered-but-ABORTING drain is
    // in teardown and won't claim, so we don't defer to it — start fresh, or the loop
    // strands on a cancel/resume race (I6 no-lost-loop). Otherwise start one.
    #ensureDrain(opts: {
        sessionId: number; runId: number; provider: Provider;
        systemPrompt: string; maxTurns: number;
    }): Promise<{
        firstLoopPromise: Promise<DrainLoopResult>;
        drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
    } | null> {
        return this.#withDrainLock(opts.runId, async () => {
            const existing = this.#activeDrains.get(opts.runId);
            if (existing !== undefined && !existing.controller.signal.aborted) return null;
            return this.#startDrain(opts);
        });
    }

    // After a loop terminates, promote any next-turn prompt it never consumed —
    // an injected wake (stream conclusion) or a loop.run-while-active prompt
    // that landed on a turn the loop didn't reach — into a fresh queued loop.
    // The drain claims it on its next iteration, so a conclusion or client
    // prompt is never silently dropped. Inherits the ended loop's flags.
    async #reconcileOrphanedWake(runId: number, endedLoopId: number): Promise<void> {
        const prefix = `/prompt/${endedLoopId}/`;
        const orphan = await (this.#db.drain_orphaned_prompt_for_loop as PrepMethod).get<{
            body: string; flags: string | null;
        }>({ loop_id: endedLoopId, pattern: `${prefix}%`, prefix_len: prefix.length });
        if (orphan === undefined) return;
        const seqRow = await (this.#db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ run_id: runId });
        if (seqRow === undefined) throw new Error("reconcileOrphanedWake: next-sequence query returned no row");
        const fresh = await (this.#db.drain_enqueue_loop as PrepMethod).get<{ id: number }>({
            run_id: runId, sequence: seqRow.next, prompt: orphan.body,
        });
        if (fresh === undefined) throw new Error("reconcileOrphanedWake: enqueue returned no row");
        if (orphan.flags !== null) {
            await (this.#db.engine_set_loop_flags as PrepMethod).run({ loop_id: fresh.id, flags: orphan.flags });
        }
    }

    // The run's cancellation scope — lazily created, and replaced once aborted
    // so a later loop.run gets a live signal. The drain and the execs its loops
    // spawn all run under it.
    #runSignal(runId: number): AbortController {
        const existing = this.#runAborts.get(runId);
        if (existing !== undefined && !existing.signal.aborted) return existing;
        const fresh = new AbortController();
        this.#runAborts.set(runId, fresh);
        return fresh;
    }

    /**
     * Cancel the run's in-flight work (loop.cancel). One abort, one scope: the
     * run signal stops the running loop's turn generation AND tears down every
     * stream linked to it — a background exec that outlived its loop, or even a
     * spawn that registers after this abort (it self-aborts against the aborted
     * signal). Returns cancelled iff there was work. Queued loops stay enqueued.
     */
    cancelDrain(runId: number, reason: string = "user_cancelled"): boolean {
        const hadWork = this.#activeDrains.has(runId) || this.#runHasActiveStreams(runId);
        // A cancel is deliberate — kill any pending hibernation poll-wake so it can't resurrect the run.
        const pollTimer = this.#pollTimers.get(runId);
        if (pollTimer !== undefined) { clearTimeout(pollTimer); this.#pollTimers.delete(runId); }
        // Stop the active drain's turn-generation (its loop closes 499). The run
        // signal is the optimization path — the fast, listener-driven reap.
        const scope = this.#runAborts.get(runId);
        if (scope !== undefined && !scope.signal.aborted) scope.abort(reason);
        // Total reap by the REGISTRY (§run-lifecycle-total-reap): the durable source
        // of truth. Every open subscription the run holds, aborted via its owning
        // scheme — independent of the signal-listener timing, so an exec mid-spawn
        // (registry row written before it is killable) is reaped too. A late spawn
        // (registering after this) self-aborts against its captured, now-aborted
        // epoch (§run-lifecycle-exec-loop-bound). Idempotent; fire-and-forget (the
        // abort is sync, the registry read async; the 499 conclusion surfaces async).
        void this.#reapRunStreams(runId).catch((err: unknown) => {
            console.error(`reapRunStreams(${runId}) failed:`, err);
        });
        return hadWork;
    }

    // Does the run have an in-flight stream (a background exec)? Used only for
    // loop.cancel's cancelled=true/false answer; the teardown itself rides the
    // run signal. Duck-typed like #drainStreamingSchemes.
    #runHasActiveStreams(runId: number): boolean {
        const exec = this.#schemes.get("exec") as { hasActiveSpawns?: (runId: number) => boolean } | undefined;
        return exec?.hasActiveSpawns?.(runId) ?? false;
    }

    // The registry-routed reap (§run-lifecycle-total-reap): every open subscription
    // the run holds, aborted via its owning scheme. The durable answer to "reap
    // everything" — the in-process AbortSignal listener is the optimization, this is
    // the source of truth: an exec mid-spawn (registry row written before it is
    // killable) or a background exec from any past loop is caught regardless of
    // listener timing. Idempotent — a stream the signal already reaped is a no-op.
    async #reapRunStreams(runId: number): Promise<void> {
        const open = await ChannelWrite.findOpenSubscriptionsForRun(this.#db, runId);
        for (const { id, scheme } of open) {
            const handler = this.#schemes.get(scheme) as { abortSubscription?: (subscriptionId: number) => void } | undefined;
            handler?.abortSubscription?.(id);
        }
    }

    /**
     * Wake-on-completion handler. Streaming schemes call this when a
     * subscription closes. If the run has an active loop, the channel
     * transition will surface at that loop's next turn boundary — no new
     * loop needed. Otherwise we open a fresh loop with the synthetic
     * summary as the user prompt so the model gets a chance to react.
     *
     * Skipped on closeStatus=499 (aborted): the model already knows about
     * its own SEND[499], and a forcefully-cancelled loop's spawn-abort
     * shouldn't resurrect into a wake loop (defeats the cancel).
     *
     * Rummy parallel: plugins/stream/stream.js stream/completed wake:true.
     */
    async #handleWakeRun(payload: WakeRunPayload): Promise<void> {
        // Aborted streams don't wake — the abort was deliberate.
        if (payload.closeStatus === 499) {
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "skipped-aborted",
            });
            return;
        }

        // No resurrection (§run-lifecycle-no-resurrection): a non-499 completion whose
        // run was CANCELLED (idle + its scope aborted) must not start a fresh drain —
        // the cancel was deliberate. The deliverable is already in the channel/log and
        // surfaces as a `collect` environment delta (§env-delta) if the run is read or
        // resumed; we just don't inject a turn. (An active run folds the wake into its
        // next turn via inject below; a resumed run is active, never aborted, so it is
        // unaffected.)
        const scope = this.#runAborts.get(payload.runId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(payload.runId)) {
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "skipped-cancelled",
            });
            return;
        }

        if (this.#provider === null) {
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "skipped-no-provider",
            });
            return;
        }

        try {
            const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");

            // A slept (202) loop means the run PARKED (SEND[202]) → RESUME it IN PLACE: re-queue
            // it (202→100) so the drain re-claims and CONTINUES it (seq>1 → no re-foist). Checked
            // FIRST: the slept status is the run's true disposition regardless of a draining
            // sibling mid-teardown (the #ensureDrain lock serializes the re-claim). No fresh loop,
            // no summary-as-prompt — the resumed loop reads the concluded stream's own state from
            // the manifest. §run-lifecycle-wake-liveness.
            const slept = await (this.#db.drain_find_slept_loop as PrepMethod).get<{ id: number }>({ run_id: payload.runId });
            if (slept !== undefined) {
                await (this.#db.drain_resume_slept_loop as PrepMethod).run({ loop_id: slept.id });
                const started = await this.#ensureDrain({
                    sessionId: payload.sessionId, runId: payload.runId, provider: this.#provider,
                    systemPrompt, maxTurns: Number(process.env.PLURNK_MAX_TURNS ?? "50"),
                });
                this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                    ...payload, wakeAction: "resumed-loop", wakeLoopId: slept.id,
                });
                started?.drainPromise?.catch((err: unknown) => {
                    console.error("wake resume drain failed:", err instanceof Error ? err.message : String(err));
                });
                return;
            }

            // No slept loop. A live loop surfaces the concluded stream ambiently via the
            // environment-observation injector (§exec-stream) on its next turn — there is no prompt
            // to inject and NO task to overwrite. The obsolete "automated environment update"
            // synthesis (which clobbered the model's actual goal) is retired; just tell the client.
            if (this.#activeDrains.has(payload.runId)) {
                this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                    ...payload, wakeAction: "no-op-active-loop",
                });
                return;
            }

            // No slept loop, no active drain — nothing to resume (e.g. a SEND[200]-done run whose
            // streams were swept). Surface the conclusion without opening a loop.
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "no-loop",
            });
        } catch (err) {
            console.error("wake-on-completion setup failed:", err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * grammar 0.74.20 EXEC `<T,P>` — schedule a hibernation poll-wake. Called when a loop parks at
     * SEND[202]; if the run holds an open polled stream, arm a timer for its tightest cadence P that
     * resumes the slept loop so the model inspects progress. While the loop is ACTIVE there is no
     * poll work — ambient folded stream deltas already surface progress (§exec-stream); the wake
     * matters only across hibernation. A wake-edge-less 202 (no polled stream) gets no timer. §exec-poll
     */
    async #schedulePollWake(sessionId: number, runId: number, provider: Provider, systemPrompt: string): Promise<void> {
        const existing = this.#pollTimers.get(runId);
        if (existing !== undefined) { clearTimeout(existing); this.#pollTimers.delete(runId); }
        const row = await (this.#db.drain_run_min_poll as PrepMethod).get<{ poll_seconds: number | null }>({ run_id: runId });
        const pollSec = row?.poll_seconds ?? null;
        if (pollSec === null || pollSec <= 0) return; // no polled stream → the 202 just sleeps (woken only by conclusion)
        const timer = setTimeout(() => {
            this.#pollTimers.delete(runId);
            void this.#pollWake(sessionId, runId, provider, systemPrompt);
        }, pollSec * 1000);
        timer.unref();
        this.#pollTimers.set(runId, timer);
    }

    /** The poll cadence elapsed while the loop hibernated → resume the slept loop in place to inspect
     *  its polled stream — the same 202→100 resume #handleWakeRun uses, minus a wake payload. A no-op if
     *  the run was cancelled or already resumed/concluded (no slept loop). §exec-poll */
    async #pollWake(sessionId: number, runId: number, provider: Provider, systemPrompt: string): Promise<void> {
        const scope = this.#runAborts.get(runId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(runId)) return; // cancelled — no resurrection
        const slept = await (this.#db.drain_find_slept_loop as PrepMethod).get<{ id: number }>({ run_id: runId });
        if (slept === undefined) return; // already active/concluded — nothing to wake
        await (this.#db.drain_resume_slept_loop as PrepMethod).run({ loop_id: slept.id });
        const started = await this.#ensureDrain({
            sessionId, runId, provider, systemPrompt,
            maxTurns: Number(process.env.PLURNK_MAX_TURNS ?? "50"),
        });
        started?.drainPromise?.catch((err: unknown) => {
            console.error("poll-wake resume drain failed:", err instanceof Error ? err.message : String(err));
        });
    }

    #onConnection(ws: WebSocket): void {
        const conn = new ClientConnection({
            ws,
            registry: this.#registry,
            db: this.#db,
            engine: this.#engine,
            provider: this.#provider,
            daemon: this,
            broadcast: (target, from, method, params) => this.#broadcast(target, from, method, params),
        });
        this.#connections.add(conn);
        ws.on("close", () => {
            conn.close();
            this.#connections.delete(conn);
        });
    }

    async #discoverAndLoadPlugins(): Promise<void> {
        // Scheme discovery only. Providers are config-driven (wired via the
        // bin script). Mimetypes self-discovers — Mimetypes.ready() in start()
        // scans @plurnk/plurnk-mimetypes-* packages via the framework's own
        // discover().
        const plugins = await PluginLoader.discoverPlugins(this.#nodeModulesPath);
        for (const plugin of plugins) {
            if (plugin.manifest.kind !== "scheme") continue;
            const instance = await PluginLoader.loadPlugin(plugin);
            this.#schemes.register(plugin.manifest.name, instance as object);
        }
    }

    #broadcast(target: NotifyTarget, from: ClientConnection | null, method: string, params?: unknown): void {
        if (target === "this") {
            from?.sendNotification(method, params);
            return;
        }
        if (target === "all") {
            for (const conn of this.#connections) {
                conn.sendNotification(method, params);
            }
            return;
        }
        const sessionId = target.sessionId;
        // Stamp the scope onto the envelope (#191, §notifications-envelope-carries-sessionid). A notification is broadcast
        // to exactly one session but carried nothing identifying it, so a
        // multi-session client (one connection, many sessions) couldn't route it
        // — "scoped by connection" only holds for one-connection-per-session.
        // Additive: single-session clients ignore the field. runId, where it
        // exists, is already in `params` at the call sites that have it.
        const scoped = params !== null && typeof params === "object"
            ? { ...params, sessionId }
            : { sessionId };
        for (const conn of this.#connections) {
            if (conn.session?.sessionId === sessionId) {
                conn.sendNotification(method, scoped);
            }
        }
    }
}

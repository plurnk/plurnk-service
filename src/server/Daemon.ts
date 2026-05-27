// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the WebSocketServer, and the active client connections.
// SPEC §13.

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { WakeRunPayload } from "../core/ChannelWrite.ts";
import { PATHS } from "../index.ts";
import Engine from "../core/Engine.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { discoverPlugins, loadPlugin } from "../core/PluginLoader.ts";
import MethodRegistry from "./MethodRegistry.ts";
import type { DrainLoopResult, NotifyTarget, Provider } from "./MethodRegistry.ts";
import ClientConnection from "./ClientConnection.ts";
import { fetchLogEntry } from "./logEntry.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";

import { register as registerPing } from "./methods/ping.ts";
import { register as registerDiscover } from "./methods/discover.ts";
import { register as registerSessionCreate } from "./methods/session_create.ts";
import { register as registerSessionList } from "./methods/session_list.ts";
import { register as registerSessionAttach } from "./methods/session_attach.ts";
import { register as registerSessionRuns } from "./methods/session_runs.ts";
import { register as registerSessionSetRoot } from "./methods/session_set_root.ts";
import { register as registerSessionSetPersona } from "./methods/session_set_persona.ts";
import { register as registerOpEdit } from "./methods/op_edit.ts";
import { register as registerOpRead } from "./methods/op_read.ts";
import { register as registerOpFind } from "./methods/op_find.ts";
import { register as registerOpShow } from "./methods/op_show.ts";
import { register as registerOpHide } from "./methods/op_hide.ts";
import { register as registerOpCopy } from "./methods/op_copy.ts";
import { register as registerOpMove } from "./methods/op_move.ts";
import { register as registerOpSend } from "./methods/op_send.ts";
import { register as registerOpExec } from "./methods/op_exec.ts";
import { register as registerOpDispatch } from "./methods/op_dispatch.ts";
import { register as registerOpParse } from "./methods/op_parse.ts";
import { register as registerLoopRun } from "./methods/loop_run.ts";
import { register as registerLoopCancel } from "./methods/loop_cancel.ts";
import { register as registerEntryRead } from "./methods/entry_read.ts";
import { register as registerLogRead } from "./methods/log_read.ts";
import { register as registerProvidersList } from "./methods/providers_list.ts";
import { register as registerLoopResolve } from "./methods/loop_resolve.ts";
import { attachYolo } from "./yolo.ts";

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
    #wss: WebSocketServer | null = null;
    #connections = new Set<ClientConnection>();

    // Run-level drain registry (rummy AgentLoop parallel). At most one
    // drain per run; concurrent loop.run calls inject into the active
    // drain instead of starting parallel runLoops.
    #activeDrains = new Map<number, { controller: AbortController; promise: Promise<unknown> }>();
    // Wake/event signals for drains parked on "queue empty, active subs in
    // flight." A wake-on-completion → engine.inject can resolve the pending
    // promise so the drain re-checks the queue without polling.
    #drainPokes = new Map<number, () => void>();

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
        // Mimetypes owns discovery, detection, handler instantiation, and
        // budget-truncated preview rendering. plurnk-service stays mimetype-
        // illiterate — we just inject the tokenize function (sourced from the
        // active provider's countTokens) and configure text/markdown as the
        // default mimetype (LLM output is overwhelmingly markdown; the
        // text-markdown handler is a hard dep so the default actually
        // resolves at runtime).
        this.#mimetypes = mimetypes ?? new Mimetypes({
            tokenize: async (text) => this.#provider?.countTokens(text) ?? Math.ceil(text.length / 4),
            defaultMimetype: "text/markdown",
        });
        this.#engine = new Engine({
            db, schemes: this.#schemes, mimetypes: this.#mimetypes,
            streamEventNotify: (sessionId, event) => this.notifyStreamEvent(sessionId, event),
            wakeRunNotify: (payload) => { void this.#handleWakeRun(payload); },
        });
        this.#nodeModulesPath = nodeModulesPath ?? resolve(process.cwd(), "node_modules");
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
        attachYolo(this.#engine, this.#db);
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
        for (const drain of this.#activeDrains.values()) drain.controller.abort("daemon_stopping");
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
        registerPing(this.#registry);
        registerDiscover(this.#registry);
        registerSessionCreate(this.#registry);
        registerSessionList(this.#registry);
        registerSessionAttach(this.#registry);
        registerSessionRuns(this.#registry);
        registerSessionSetRoot(this.#registry);
        registerSessionSetPersona(this.#registry);
        registerOpEdit(this.#registry);
        registerOpRead(this.#registry);
        registerOpFind(this.#registry);
        registerOpShow(this.#registry);
        registerOpHide(this.#registry);
        registerOpCopy(this.#registry);
        registerOpMove(this.#registry);
        registerOpSend(this.#registry);
        registerOpExec(this.#registry);
        registerOpDispatch(this.#registry);
        registerOpParse(this.#registry);
        registerLoopRun(this.#registry);
        registerLoopCancel(this.#registry);
        registerLoopResolve(this.#registry);
        registerEntryRead(this.#registry);
        registerLogRead(this.#registry);
        registerProvidersList(this.#registry);
    }

    #registerNotifications(): void {
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
            },
        });
        this.#registry.registerNotification("stream/event", {
            description: "A channel's content grew or its state transitioned. Scoped to the entry's session. Metadata-only; clients fetch new content via entry.read or op.read.",
            params: {
                entryId: "number — the entry whose channel changed",
                channel: "string — the channel name",
                state: "string — current state (static, active, closed, errored)",
                contentLength: "number — current length of the channel's content",
            },
        });
        this.#registry.registerNotification("stream/concluded", {
            description: "A streaming-scheme subscription closed (the underlying connection / subprocess finished, errored, or was cancelled). Scoped to the entry's session. wakeAction describes whether the daemon opened a fresh loop to surface the conclusion to the model.",
            params: {
                entryId: "number",
                subscriptionId: "number",
                scheme: "string — the scheme that owned the subscription (e.g. 'exec')",
                closeStatus: "number — 200 (clean) / 500 (error) / 499 (aborted)",
                summary: "string — one-liner the model gets as a wake prompt",
                wakeAction: "string — 'no-op-active-loop' | 'opened-loop' | 'skipped-aborted' | 'skipped-no-provider'",
                wakeLoopId: "number? — the loop that was opened (only when wakeAction='opened-loop')",
            },
        });
    }

    /**
     * Emit a stream/event notification scoped to the session containing the
     * entry. ChannelWrite helpers (src/core/ChannelWrite.ts) invoke this when
     * they update channel content or state. SPEC §13.6.
     */
    notifyStreamEvent(sessionId: number, event: { entryId: number; channel: string; state: string; contentLength: number }): void {
        this.#broadcast({ sessionId }, null, "stream/event", event);
    }

    /**
     * Inject a prompt into a run. Two paths:
     *   - Active drain: writes a plurnk://prompt/<loop>/<next-turn> entry
     *     via Engine.inject. Current loop sees the new prompt at its next
     *     turn. Returns immediately with {action: "injected_next_turn"}.
     *   - No active drain: enqueues a fresh loop with the prompt at
     *     status=100, starts a drain. Returns the drain promise so the
     *     caller can await full completion.
     *
     * Rummy parallel: AgentLoop.inject(). Unified surface — both `loop.run`
     * and wake-on-completion go through this method.
     */
    async inject(args: {
        sessionId: number; runId: number; prompt: string;
        provider: Provider; persona: string; systemPrompt: string;
        maxTurns?: number; flags?: { yolo?: boolean }; personaOverride?: string | null;
    }): Promise<{
        action: "injected_next_turn" | "enqueued_new_loop";
        loopId: number;
        turnSeq?: number;
        firstLoopPromise?: Promise<DrainLoopResult>;
        drainPromise?: Promise<unknown>;
    }> {
        const { sessionId, runId, prompt } = args;
        // Wake any drain parked on "queue empty + active subs" so it
        // re-checks the queue immediately regardless of which branch we
        // take. The poke fires before we return; if we enqueue a new
        // loop, the drain we start below claims it on its first iteration.
        this.#pokeDrain(runId);

        const drainActive = this.#activeDrains.has(runId);
        if (drainActive) {
            const result = await this.#engine.inject(runId, prompt);
            if (result !== null) {
                return { action: "injected_next_turn", loopId: result.loopId, turnSeq: result.turnSeq };
            }
            // Race: #activeDrains exists but drain hasn't yet claimed a
            // loop (status=102). Fall through to the enqueue path — but
            // we must NOT start a parallel drain. The existing drain
            // will claim this loop on a subsequent iteration.
        }

        // Enqueue a fresh loop. Persist flags + persona override on the row.
        const seqRow = await (this.#db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ run_id: runId });
        if (seqRow === undefined) throw new Error("inject: next-sequence query returned no row");
        const loopRow = await (this.#db.drain_enqueue_loop as PrepMethod).get<{ id: number }>({
            run_id: runId, sequence: seqRow.next, prompt, persona: args.personaOverride ?? null,
        });
        if (loopRow === undefined) throw new Error("inject: loop enqueue returned no row");
        const loopId = loopRow.id;

        if (args.flags !== undefined) {
            const merged = { ...DEFAULT_LOOP_FLAGS, ...args.flags };
            await (this.#db.engine_set_loop_flags as PrepMethod).run({
                loop_id: loopId, flags: JSON.stringify(merged),
            });
        }

        // Existing drain will pick this loop up — don't start a parallel one.
        if (drainActive) {
            // Poke the existing drain in case it's parked.
            this.#pokeDrain(runId);
            return { action: "enqueued_new_loop", loopId };
        }

        const { firstLoopPromise, drainPromise } = this.#startDrain({
            sessionId, runId, provider: args.provider,
            systemPrompt: args.systemPrompt, personaDefault: args.persona,
            maxTurns: args.maxTurns ?? Number(process.env.PLURNK_MAX_TURNS ?? "50"),
        });
        return { action: "enqueued_new_loop", loopId, firstLoopPromise, drainPromise };
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
        systemPrompt: string; personaDefault: string; maxTurns: number;
    }): {
        firstLoopPromise: Promise<DrainLoopResult>;
        drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
    } {
        const { sessionId, runId, provider, systemPrompt, personaDefault, maxTurns } = opts;
        const controller = new AbortController();

        let resolveFirst: (v: DrainLoopResult) => void = () => {};
        let rejectFirst: (e: unknown) => void = () => {};
        const firstLoopPromise = new Promise<DrainLoopResult>((res, rej) => {
            resolveFirst = res; rejectFirst = rej;
        });
        let firstSettled = false;

        const drainPromise = (async () => {
            let loopsDrained = 0;
            let lastResult: DrainLoopResult | null = null;
            try {
                while (true) {
                    controller.signal.throwIfAborted();
                    const loopRow = await (this.#db.drain_claim_next_loop as PrepMethod).get<{
                        id: number; sequence: number; prompt: string; persona: string | null;
                    }>({ run_id: runId });
                    if (loopRow !== undefined) {
                        const onDispatch = (logEntryId: number): void => {
                            void (async () => {
                                const entry = await fetchLogEntry(this.#db, logEntryId);
                                this.#broadcast({ sessionId }, null, "log/entry", { entry });
                            })();
                        };
                        const result = await this.#engine.runLoop({
                            provider, sessionId, runId, loopId: loopRow.id, maxTurns,
                            messages: [
                                { role: "system", content: systemPrompt },
                                { role: "user", content: loopRow.prompt },
                            ],
                            persona: personaDefault,
                            origin: "model",
                            onDispatch,
                            signal: controller.signal,
                        });
                        this.#broadcast({ sessionId }, null, "loop/terminated", {
                            loopId: loopRow.id,
                            finalStatus: result.finalStatus,
                            hitMaxTurns: result.hitMaxTurns,
                        });
                        loopsDrained++;
                        const loopResult: DrainLoopResult = {
                            loopId: loopRow.id,
                            turnIds: result.turnIds,
                            finalStatus: result.finalStatus,
                            hitMaxTurns: result.hitMaxTurns,
                        };
                        lastResult = loopResult;
                        if (!firstSettled) {
                            firstSettled = true;
                            resolveFirst(loopResult);
                        }
                        continue;
                    }
                    // Queue empty. Stream-aware: don't exit while subs are open.
                    const subRow = await (this.#db.drain_count_active_subs_for_run as PrepMethod).get<{ n: number }>({ run_id: runId });
                    if ((subRow?.n ?? 0) === 0) break;
                    await this.#awaitDrainPoke(runId, controller.signal);
                }
            } catch (err) {
                if (!firstSettled) {
                    firstSettled = true;
                    rejectFirst(err);
                }
                throw err;
            } finally {
                if (!firstSettled) {
                    firstSettled = true;
                    rejectFirst(new Error("drain exited without producing a result"));
                }
                this.#activeDrains.delete(runId);
                this.#drainPokes.delete(runId);
            }
            return { loopsDrained, lastResult };
        })();

        this.#activeDrains.set(runId, { controller, promise: drainPromise });
        // Attach a swallowing handler so unhandled rejections (e.g. when
        // the drain aborts and no caller awaited drainPromise) don't
        // crash the process. The error already surfaced via firstLoopPromise
        // if relevant, or was already logged inside the drain body.
        drainPromise.catch(() => {});
        // firstLoopPromise also needs a handler in case nobody awaits it
        // (e.g. wake-on-completion enqueue path doesn't always read it).
        firstLoopPromise.catch(() => {});
        return { firstLoopPromise, drainPromise };
    }

    #pokeDrain(runId: number): void {
        const poke = this.#drainPokes.get(runId);
        if (poke !== undefined) {
            this.#drainPokes.delete(runId);
            poke();
        }
    }

    #awaitDrainPoke(runId: number, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (signal.aborted) { reject(new Error("drain aborted")); return; }
            const onAbort = (): void => {
                this.#drainPokes.delete(runId);
                reject(new Error("drain aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            this.#drainPokes.set(runId, () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            });
        });
    }

    /**
     * Cancel the active drain for a run. Fires the drain's AbortController;
     * the engine's per-loop loopAbort cascades from the runLoop signal arg,
     * so in-flight scheme operations (exec spawns, future SSE/WS) tear
     * down. Queued loops in the run remain enqueued — call again if you
     * want them cleared, or rely on subsequent loop.run to resume.
     */
    cancelDrain(runId: number, reason: string = "user_cancelled"): boolean {
        const drain = this.#activeDrains.get(runId);
        if (drain === undefined) return false;
        drain.controller.abort(reason);
        return true;
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
        // Every subscription close pokes the run's drain (if any) so a
        // parked stream-aware drain re-checks active subs count. This
        // happens regardless of whether we go on to inject a new loop,
        // so the 499-skipped / no-provider paths still wake the drain
        // out of its "queue empty, waiting for streams" state.
        this.#pokeDrain(payload.runId);

        // Aborted streams don't wake — the abort was deliberate.
        if (payload.closeStatus === 499) {
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "skipped-aborted",
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
            const systemPrompt = await readFile(PATHS.instructionsSystem, "utf8");
            const personaText = await readFile(PATHS.defaultPersona, "utf8");

            // Unified path: this.inject decides whether to write a prompt
            // entry for an active drain's next turn (no-op-active-loop) or
            // enqueue a fresh loop + drain (opened-loop). The summary
            // string becomes the user prompt either way.
            const result = await this.inject({
                sessionId: payload.sessionId,
                runId: payload.runId,
                prompt: payload.summary,
                provider: this.#provider,
                persona: personaText,
                systemPrompt,
            });

            if (result.action === "injected_next_turn") {
                this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                    ...payload, wakeAction: "no-op-active-loop", wakeLoopId: result.loopId,
                });
                return;
            }

            // enqueued_new_loop: drain runs in background; broadcast that
            // the wake opened a loop, then await the drain so background
            // failures bubble to the catch block below.
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "opened-loop", wakeLoopId: result.loopId,
            });
            // Drain runs in background; loop/terminated broadcasts come
            // from #startDrain as each loop finishes. Don't await — the
            // wake-notify path should return quickly.
            result.drainPromise?.catch((err: unknown) => {
                console.error("wake-on-completion drain failed:", err instanceof Error ? err.message : String(err));
            });
        } catch (err) {
            console.error("wake-on-completion setup failed:", err instanceof Error ? err.message : String(err));
        }
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
        const plugins = await discoverPlugins(this.#nodeModulesPath);
        for (const plugin of plugins) {
            if (plugin.manifest.kind !== "scheme") continue;
            const instance = await loadPlugin(plugin);
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
        for (const conn of this.#connections) {
            if (conn.session?.sessionId === sessionId) {
                conn.sendNotification(method, params);
            }
        }
    }
}

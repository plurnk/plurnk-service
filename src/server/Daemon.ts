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
import type { NotifyTarget, Provider } from "./MethodRegistry.ts";
import ClientConnection from "./ClientConnection.ts";

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

        // Drain streaming-scheme in-flight work before the caller closes
        // the DB. Without this, background spawns finish their channel
        // writes against a closed connection and throw. Each streaming
        // scheme that owns async work exposes its own idle() surface.
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

        const hasActive = await this.#engine.hasActiveLoopForRun(payload.runId);
        if (hasActive) {
            // The active loop will pick up the channel transition at its
            // next turn boundary. No new loop required.
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "no-op-active-loop",
            });
            return;
        }

        if (this.#provider === null) {
            // No model to drive a wake loop. Forensics-only: broadcast and
            // bail. Operator should configure PLURNK_MODEL.
            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "skipped-no-provider",
            });
            return;
        }

        try {
            const systemPrompt = await readFile(PATHS.instructionsSystem, "utf8");
            const personaText = await readFile(PATHS.defaultPersona, "utf8");
            const seqRow = await (this.#db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ run_id: payload.runId });
            if (seqRow === undefined) throw new Error("wake: next-sequence query returned no row");
            const loopRow = await (this.#db.loop_run_insert_loop as PrepMethod).get<{ id: number }>({
                run_id: payload.runId, sequence: seqRow.next, prompt: payload.summary, persona: null,
            });
            if (loopRow === undefined) throw new Error("wake: loop insert returned no row");
            const wakeLoopId = loopRow.id;

            this.#broadcast({ sessionId: payload.sessionId }, null, "stream/concluded", {
                ...payload, wakeAction: "opened-loop", wakeLoopId,
            });

            // Drive the wake loop in the background. Errors are logged but
            // don't propagate — the wake is best-effort.
            const provider = this.#provider;
            void this.#engine.runLoop({
                provider,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: payload.summary },
                ],
                persona: personaText,
                sessionId: payload.sessionId,
                runId: payload.runId,
                loopId: wakeLoopId,
                origin: "system",
            }).then((result) => {
                this.#broadcast({ sessionId: payload.sessionId }, null, "loop/terminated", {
                    loopId: wakeLoopId,
                    finalStatus: result.finalStatus,
                    hitMaxTurns: result.hitMaxTurns,
                });
            }).catch((err) => {
                console.error("wake-on-completion loop failed:", err instanceof Error ? err.message : String(err));
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

// The in-process transport module (plurnk-agui#2) — what the daemon's boot plug-point
// activates: registerModule(aguiModule(opts)) hands this the CoreSeam handle; it opens
// the AG-UI+ HTTP/SSE listener and owns the client interface from there.
//
// This is the SINGLE-INTERFACE surface (AG-UI+), not the legacy bridge dialect:
//   POST /  — the only endpoint. A run streams SSE. HITL is terminate-resume: a
//   stopped-world emits a request_approval/request_user_input TOOL_CALL and the run
//   FINISHES (the loop stays paused in-engine); the resume arrives as the next run's
//   tool-result message → resolveProposal → the continued loop streams there.
//   Reads ride STATE_SNAPSHOT on RUN_STARTED; no /plurnk/rpc, no /resolve.
// An AG-UI threadId IS a plurnk session (`<prefix>-<threadId>`); the envelope's
// modelRunId binds the thread (no lazy inference — createSession returns it).

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import Portal from "./Portal.ts";
import { stateSnapshot, parseAction, actionResult, type ActionRequest, type ActionOutcome } from "./AguiPlus.ts";
import type { DaemonSeam, ClientEnvelope, PlurnkStatement } from "./DaemonSeam.ts";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import { authorize as mcpAuthorize, poll as mcpPoll } from "@plurnk/plurnk-execs-mcp";
import type { AguiEvent, RunAgentInput } from "./types.ts";

export interface ModuleOptions {
    host: string;
    port: number;                 // 0 = ephemeral
    token?: string;               // empty/undefined = local trust (loopback bind is the boundary)
    maxTurns?: number;
}

export default class Module {
    #seam: DaemonSeam;
    #opts: ModuleOptions;
    #portal: Portal;
    #http: HttpServer;
    #threads = new Map<string, ClientEnvelope>(); // threadId → envelope

    // The control plane vs the world. A RUN lives in a world (a conversation, or an action
    // that reads/writes a session's log); a control-plane action (list/create/attach/discover/
    // auth) does NOT — so it must not bind or forge a session (operator ruling 2026-07-10:
    // "every run/thread requires a world, not everything"). Only these kinds bind a session.
    static #WORLD_SCOPED = Object.freeze(new Set([
        "session.runs", "log.read", "loop.inject", "loop.cancel", "session.prompts", "session.rename",
        "session.constrain", "session.unconstrain", "session.constraints", "entry.read",
        "op.exec", "op.parse", "session.members", "op.look", "run.fork",
    ]));

    constructor(seam: DaemonSeam, opts: ModuleOptions) {
        this.#seam = seam;
        this.#opts = opts;
        this.#portal = new Portal(seam);
        this.#http = createServer((req, res) => { void this.#route(req, res); });
    }

    // The boot-plug-point init: `daemon.registerModule(Module.init(opts))`.
    static init(opts: ModuleOptions): (seam: DaemonSeam) => Promise<Module> {
        return async (seam) => {
            const m = new Module(seam, opts);
            await m.listen();
            return m;
        };
    }

    async listen(): Promise<{ host: string; port: number }> {
        this.#portal.start();
        await new Promise<void>((resolve) => this.#http.listen(this.#opts.port, this.#opts.host, resolve));
        const addr = this.#http.address();
        if (addr === null || typeof addr === "string") throw new Error("plurnk-agui: listener bound no TCP address");
        return { host: this.#opts.host, port: addr.port };
    }

    address(): { host: string; port: number } {
        const addr = this.#http.address();
        if (addr === null || typeof addr === "string") throw new Error("plurnk-agui: not listening");
        return { host: this.#opts.host, port: addr.port };
    }

    async close(): Promise<void> {
        this.#portal.stop();
        await new Promise<void>((resolve, reject) => this.#http.close((e) => (e ? reject(e) : resolve())));
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            res.setHeader("access-control-allow-origin", "*");
            res.setHeader("access-control-allow-headers", "content-type, authorization");
            if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
            // The perimeter (§governance): bearer check before any body read.
            const token = this.#opts.token ?? "";
            if (token.length > 0 && req.headers.authorization !== `Bearer ${token}`) {
                res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bearer token required" }));
                return;
            }
            if (req.method === "POST" && (req.url === "/" || req.url === "/agui")) return await this.#run(req, res);
            res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "POST / (AG-UI run) is the interface" }));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: message }));
        }
    }

    // THE PLURNK PARADIGM (operator ruling 2026-07-10): the name IS the identity,
    // verbatim. The SESSION is the WORLD (service SPEC, machine-processes) — selected by name via
    // `forwardedProps.plurnk.session`; attach it if it exists, create it with EXACTLY that
    // name if it doesn't. No prefixes, no forged names, no dual lookup. The session is
    // REQUIRED: a run has no existence without a world, so its absence is a contract
    // violation the client must fix — never a workspace forged from the threadId.
    // The threadId is the CONVERSATION over that world; today it binds the session's model
    // run (ensureModelRun) — distinct second conversations gate on plurnk-service#366.
    async #envelope(threadId: string, forwarded?: Record<string, unknown>): Promise<{ env: ClientEnvelope; reattached: boolean }> {
        const workspace = forwarded?.session;
        if (typeof workspace !== "string" || workspace.length === 0) throw new Error("forwardedProps.plurnk.session (a session name) is required");
        const cached = this.#threads.get(threadId);
        if (cached !== undefined) return { env: cached, reattached: true };
        const known = (await this.#seam.listSessions()).find((s) => s.name === workspace);
        let env: ClientEnvelope;
        let reattached = false;
        if (known !== undefined) {
            env = await this.#seam.attachSession({ sessionId: known.id });
            reattached = true;
        } else {
            const opts = forwarded ?? {};
            env = await this.#seam.createSession({
                name: workspace,
                ...(typeof opts.projectRoot === "string" ? { projectRoot: opts.projectRoot } : {}),
                ...(Array.isArray(opts.constraints) ? { constraints: opts.constraints as Array<{ effect: string; glob: string }> } : {}),
                ...(typeof opts.settings === "object" && opts.settings !== null ? { settings: JSON.stringify(opts.settings) } : {}),
            });
        }
        this.#threads.set(threadId, env);
        return { env, reattached };
    }

    async #run(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const input = JSON.parse(await Module.#body(req)) as RunAgentInput;
        if (typeof input.threadId !== "string" || input.threadId.length === 0) throw new Error("RunAgentInput.threadId required");
        const forwarded = (input.forwardedProps as { plurnk?: Record<string, unknown> } | undefined)?.plurnk;

        // Control plane FIRST: a management action that doesn't live in a world (and an
        // unknown kind, which is no run at all) answers without binding — or forging — a
        // session. Only world-scoped actions and conversations reach #envelope below.
        const early = parseAction(input.forwardedProps);
        if (early !== null && !Module.#WORLD_SCOPED.has(early.kind)) return await this.#controlRun(early, input, res);

        const { env, reattached } = await this.#envelope(input.threadId, forwarded);
        const sessionId = env.sessionId;
        // Run-split (service SPEC, machine-processes): loops drive in the session's MODEL run — the
        // client run is connection scratch. ensureModelRun creates it on first use, so
        // it also BINDS the render (no lazy first-row adoption needed).
        const runId = await this.#seam.ensureModelRun(sessionId);

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        let finished = false;
        let pausedOnProposal = false;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            this.#portal.closeRun(sessionId, boundRun);
            res.end();
        };
        const emit = (events: AguiEvent[]): void => {
            for (const e of events) {
                res.write(`data: ${JSON.stringify(e)}\n\n`);
                // Terminate-resume, the terminate half: a proposal tool-call ENDS this
                // run (the loop stays paused in-engine awaiting the resume run).
                if (e.type === "TOOL_CALL_END" && (e as { toolCallId: string }).toolCallId.startsWith("prop:")) pausedOnProposal = true;
                if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") finish();
            }
            if (pausedOnProposal && !finished) {
                res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId })}\n\n`);
                finish();
            }
        };

        const boundRun = this.#portal.openThread({ sessionId, runId, threadId: input.threadId, emit, modelRunId: runId, inputRunId: input.runId });
        emit([
            { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
            stateSnapshot({ providers: this.#seam.listProviders().aliases, session: { id: sessionId, name: env.sessionName, projectRoot: env.projectRoot } }),
        ]);
        if (finished) return;

        // §3 — a management ACTION run (forwardedProps.plurnk.action): execute via the
        // seam; the outcome rides the session's CURRENT thread binding (Portal.finishRun),
        // never this closure — a proposal-gated action (op.exec → 202) terminates THIS
        // run and completes after the resume run rebinds the stream.
        const action = parseAction(input.forwardedProps);
        if (action !== null) {
            const finishAction = (outcome: ActionOutcome): void => {
                const events = [actionResult(action.kind, outcome)];
                // Plain action (stream still open): answer on OUR OWN stream — concurrent
                // actions share a session, and the session binding is whoever bound last
                // (results would cross streams). Only a proposal-pause (this stream already
                // terminated) hands off to the session binding, which the resume run rebinds.
                if (!finished) {
                    emit([...events, { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId }]);
                    return;
                }
                this.#portal.finishRun(sessionId, events);
            };
            void this.#action(action, env)
                // One queue barrier: a dispatch's channel notifies are enqueued but not yet
                // delivered when its promise resolves — drain them so Portal's stream
                // bookkeeping arms BEFORE the finish decision (then stream/concluded,
                // not a timer, releases any deferral).
                .then(async (outcome) => { await new Promise((r) => setImmediate(r)); finishAction(outcome); })
                .catch((err: unknown) => finishAction({ ok: false, error: err instanceof Error ? err.message : String(err) }));
            req.on("close", finish);
            return;
        }

        // Terminate-resume, the resume half: a tool-result message resolves the paused
        // proposal; the continued loop streams on THIS run. No new loop is driven.
        const toolResult = [...(input.messages ?? [])].reverse().find((m) => m.role === "tool") as { toolCallId?: string; content?: string } | undefined;
        if (toolResult !== undefined && this.#portal.resolve(toolResult)) {
            req.on("close", finish); // client hangup on a resume just detaches; the loop already runs
            return;
        }

        const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
        if (lastUser?.content === undefined || lastUser.content.length === 0) throw new Error("RunAgentInput.messages must carry a user message or a tool result");

        if (reattached) {
            const history = await this.#seam.readLog({ sessionId, runId, limit: 1000 }).catch(() => null);
            if (history !== null) emit([...this.#threadRouterReplay(sessionId, history)]);
        }
        await this.#portal.run({
            sessionId, runId, prompt: lastUser.content,
            ...(typeof forwarded?.maxTurns === "number" ? { maxTurns: forwarded.maxTurns } : this.#opts.maxTurns !== undefined ? { maxTurns: this.#opts.maxTurns } : {}),
            ...(typeof forwarded?.flags === "object" && forwarded.flags !== null ? { flags: forwarded.flags as { yolo?: boolean } } : {}),
        });
        // A dropped SSE on a LIVE run cancels the loop (hangup is the abort). A run we
        // finished ourselves — terminal event or proposal-terminate — leaves the engine
        // alone (the paused loop is exactly what the resume run needs).
        req.on("close", () => {
            if (finished) return;
            this.#seam.cancelDrain(runId);
            finish();
        });
    }

    // A control-plane run: no world bound. Open the SSE, run the worldless verb, answer on
    // our own stream. No Portal thread, no model run — nothing to forge (operator ruling:
    // session-plane actions must not spin an ephemeral session).
    async #controlRun(action: ActionRequest, input: RunAgentInput, res: ServerResponse): Promise<void> {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        const emit = (e: AguiEvent): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
        emit({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
        const outcome = await this.#action(action, null).catch((err: unknown): ActionOutcome => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        emit(actionResult(action.kind, outcome));
        emit({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
        res.end();
    }

    // The capability manifest a client probes (`discover`) to detect a daemon older than
    // itself. The methods ARE the action surface; the notifications are the daemon-shape
    // events the client un-projects. Built from the real surface — never a hand-kept list.
    #capabilities(): { methods: Record<string, true>; notifications: Record<string, true> } {
        const methods: Record<string, true> = {};
        for (const k of ["ping", "discover", "providers.list", "session.list", "session.create", "session.attach", "auth.authorize", "auth.authorize.poll", ...Module.#WORLD_SCOPED]) methods[k] = true;
        const notifications: Record<string, true> = {};
        for (const n of ["log/entry", "loop/terminated", "loop/proposal", "telemetry/event", "stream/event", "stream/concluded"]) notifications[n] = true;
        return { methods, notifications };
    }

    // The action executor — the verb surface. The control plane runs worldless; everything
    // below the guard operates within a bound session. An unknown kind is an honest error,
    // never a silent pass-through. loop.inject rides here too (§4): the seam's unified
    // runLoop folds a prompt into the active drain; the steered effect streams on the SSE.
    async #action(a: ActionRequest, env: ClientEnvelope | null): Promise<ActionOutcome> {
        const p = a.params;
        try {
            // The control plane — worldless verbs (no bound session; #WORLD_SCOPED gates this).
            switch (a.kind) {
                case "ping": return { ok: true, result: {} };
                case "discover": return { ok: true, result: this.#capabilities() };
                case "providers.list": return { ok: true, result: this.#seam.listProviders() };
                case "session.list": return { ok: true, result: { sessions: await this.#seam.listSessions() } };
                case "session.create": {
                    // The name IS the identity: an explicit name creates/attaches EXACTLY
                    // that session; no name = the daemon names it and the real name binds.
                    if (typeof p.name === "string" && p.name.length > 0) {
                        // The name IS the world here — feed it as the session so #envelope
                        // creates/attaches exactly it (p carries no `session` of its own).
                        const { env: created } = await this.#envelope(p.name, { ...p, session: p.name });
                        return { ok: true, result: { id: created.sessionId, name: created.sessionName, runId: created.runId } };
                    }
                    const created = await this.#seam.createSession({
                        ...(typeof p.projectRoot === "string" ? { projectRoot: p.projectRoot } : {}),
                        ...(Array.isArray(p.constraints) ? { constraints: p.constraints as Array<{ effect: string; glob: string }> } : {}),
                        ...(typeof p.settings === "object" && p.settings !== null ? { settings: JSON.stringify(p.settings) } : {}),
                    });
                    this.#threads.set(created.sessionName, created);
                    return { ok: true, result: { id: created.sessionId, name: created.sessionName, runId: created.runId } };
                }
                case "session.attach": {
                    // A REAL attach: rebind the thread map to the chosen session and hand
                    // back its envelope — the picker does what it says (the unwired kind +
                    // a nil-masking fallback produced the 2026-07-10 front-door disaster).
                    if (typeof p.id !== "number") return { ok: false, error: "session.attach requires id" };
                    const att = await this.#seam.attachSession({ sessionId: p.id, ...(typeof p.runId === "number" ? { runId: p.runId } : {}) });
                    this.#threads.set(att.sessionName, att);
                    return { ok: true, result: { id: att.sessionId, name: att.sessionName, runId: att.runId, modelRunId: att.modelRunId } };
                }
                case "auth.authorize": {
                    // Stateless relay to the execs-mcp driver (settled: no auth seam — the
                    // driver owns its mechanics; the bearer overlays its own config registry).
                    if (typeof p.target !== "string" || p.target.length === 0) return { ok: false, error: "auth.authorize requires target" };
                    return { ok: true, result: await mcpAuthorize(p.target) };
                }
                case "auth.authorize.poll": {
                    if (typeof p.target !== "string" || p.target.length === 0) return { ok: false, error: "auth.authorize.poll requires target" };
                    return { ok: true, result: await mcpPoll(p.target, { device: p.device as never }) };
                }
            }
            // Below this line lives IN a world. An unknown kind is no run at all; a
            // world-scoped kind with no bound session is a routing bug — both surface plainly.
            if (!Module.#WORLD_SCOPED.has(a.kind)) return { ok: false, error: `unknown action '${a.kind}'` };
            if (env === null) throw new Error(`action '${a.kind}' operates within a session, but none is bound`);
            switch (a.kind) {
                case "session.runs": return { ok: true, result: { runs: await this.#seam.listRuns(typeof p.id === "number" ? p.id : env.sessionId) } };
                case "log.read": {
                    // Default run: the conversation (model run); p.runId pins another.
                    const readRun = typeof p.runId === "number" ? p.runId : await this.#seam.ensureModelRun(env.sessionId);
                    const entries = await this.#seam.readLog({ sessionId: env.sessionId, runId: readRun, ...(typeof p.limit === "number" ? { limit: p.limit } : {}), ...(typeof p.sinceId === "number" ? { sinceId: p.sinceId } : {}), ...(typeof p.loopId === "number" ? { loopId: p.loopId } : {}), ...(typeof p.turnId === "number" ? { turnId: p.turnId } : {}), ...(typeof p.loopSeq === "number" ? { loopSeq: p.loopSeq } : {}), ...(typeof p.turnSeq === "number" ? { turnSeq: p.turnSeq } : {}), ...(typeof p.sequence === "number" ? { sequence: p.sequence } : {}) });
                    return { ok: true, result: { entries } };
                }
                case "loop.inject": {
                    if (typeof p.prompt !== "string" || p.prompt.length === 0) return { ok: false, error: "loop.inject requires prompt" };
                    const ack = await this.#seam.runLoop({ sessionId: env.sessionId, runId: await this.#seam.ensureModelRun(env.sessionId), prompt: p.prompt });
                    return { ok: true, result: ack };
                }
                // The stop button (TUI /stop + Ctrl-C, nvim :PlurnkStop): abort the model
                // run's active drain. Mirrors the SSE-hangup abort, addressable as a verb.
                case "loop.cancel": return { ok: true, result: { cancelled: this.#seam.cancelDrain(await this.#seam.ensureModelRun(env.sessionId)) } };
                case "session.prompts": return { ok: true, result: { prompts: await this.#seam.listPrompts(env.sessionId, typeof p.limit === "number" ? p.limit : undefined) } };
                case "session.rename": {
                    if (typeof p.name !== "string" || p.name.length === 0) return { ok: false, error: "session.rename requires name" };
                    return { ok: true, result: await this.#seam.renameSession(env.sessionId, p.name) };
                }
                case "session.constrain": {
                    if (typeof p.effect !== "string" || typeof p.glob !== "string") return { ok: false, error: "session.constrain requires effect + glob" };
                    return { ok: true, result: await this.#seam.constrain(env.sessionId, p.effect, p.glob) };
                }
                case "session.unconstrain": {
                    if (typeof p.effect !== "string" || typeof p.glob !== "string") return { ok: false, error: "session.unconstrain requires effect + glob" };
                    return { ok: true, result: await this.#seam.unconstrain(env.sessionId, p.effect, p.glob) };
                }
                case "session.constraints": return { ok: true, result: { constraints: await this.#seam.listConstraints(env.sessionId) } };
                case "entry.read": {
                    if (typeof p.target !== "string") return { ok: false, error: "entry.read requires target" };
                    return { ok: true, result: await this.#seam.readEntry({ sessionId: env.sessionId, target: p.target, ...(typeof p.channel === "string" ? { channel: p.channel } : {}), ...(typeof p.offset === "number" ? { offset: p.offset } : {}) }) };
                }
                case "op.exec": {
                    // EXEC constructed structurally (no DSL text): the model-facing shape,
                    // proposal-gated by the engine like any client op.
                    if (typeof p.command !== "string" || p.command.length === 0) return { ok: false, error: "op.exec requires command" };
                    const statement = { op: "EXEC", suffix: "", signal: null, target: null, lineMarker: null, body: p.command, position: { line: 1, col: 1 } } as unknown as PlurnkStatement;
                    // Client ops journal as client-origin turns in the CLIENT run (run-split:
                    // only LOOPS live in the model run).
                    return { ok: true, result: await this.#seam.dispatchAsClient({ sessionId: env.sessionId, runId: env.runId, statement }) };
                }
                case "op.parse": {
                    // Raw DSL parsed at the module's edge (the grammar is a family-internal
                    // runtime dep, operator-approved) → each statement dispatched; parse
                    // failures return as 400 results, mirroring the legacy op.parse.
                    if (typeof p.text !== "string" || p.text.length === 0) return { ok: false, error: "op.parse requires text" };
                    const parsed = PlurnkParser.parseClient(p.text);
                    const results: Array<Record<string, unknown>> = [];
                    const runId = env.runId; // client ops ride the client run
                    for (const item of parsed.items) {
                        if (item.kind === "error") { results.push({ status: 400, error: String(item.error.message ?? item.error) }); continue; }
                        if (item.kind !== "statement") continue; // interstitial text isn't dispatchable
                        results.push(await this.#seam.dispatchAsClient({ sessionId: env.sessionId, runId, statement: item.statement as unknown as PlurnkStatement }));
                    }
                    return { ok: true, result: { results } };
                }
                case "session.members": return { ok: true, result: await this.#seam.listMembers(env.sessionId) };
                case "op.look": {
                    // Parse at the edge; LOOK is the wire spelling of the read-projection —
                    // rewrite to READ (Engine.look enforces READ-only).
                    if (typeof p.text !== "string" || p.text.length === 0) return { ok: false, error: "op.look requires text" };
                    const parsed = PlurnkParser.parseClient(p.text);
                    const item = parsed.items.find((i) => i.kind === "statement");
                    if (item === undefined || item.kind !== "statement") return { ok: false, error: "op.look: no statement parsed" };
                    const statement = { ...(item.statement as unknown as Record<string, unknown>), op: "READ" } as unknown as PlurnkStatement;
                    return { ok: true, result: await this.#seam.look({ sessionId: env.sessionId, runId: env.runId, statement }) };
                }
                case "run.fork": return { ok: true, result: await this.#seam.forkRun({ sessionId: env.sessionId, runId: await this.#seam.ensureModelRun(env.sessionId), ...(typeof p.name === "string" ? { name: p.name } : {}) }) };
                default: return { ok: false, error: `unknown action '${a.kind}'` };
            }
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    #threadRouterReplay(sessionId: number, entries: Array<Record<string, unknown>>): AguiEvent[] {
        // Replay via the thread's own router (MESSAGES_SNAPSHOT of the model SENDs).
        const messages: Array<{ id: string; role: string; content: string }> = [];
        for (const e of entries) {
            if (e.op === "SEND" && e.origin === "model") {
                const tx = e.tx as { body?: unknown } | null | undefined;
                const body = tx !== null && typeof tx === "object" && typeof tx.body === "string" ? tx.body : "";
                if (body.length > 0) messages.push({ id: String(e.coordinate ?? e.id), role: "assistant", content: body });
            }
        }
        return [{ type: "MESSAGES_SNAPSHOT", messages }];
    }

    static #body(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", (c: Buffer) => { data += c.toString(); });
            req.on("end", () => resolve(data));
            req.on("error", reject);
        });
    }
}

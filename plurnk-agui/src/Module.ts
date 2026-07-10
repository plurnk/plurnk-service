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
import type { DaemonSeam, ClientEnvelope } from "./DaemonSeam.ts";
import type { AguiEvent, RunAgentInput } from "./types.ts";

export interface ModuleOptions {
    host: string;
    port: number;                 // 0 = ephemeral
    sessionPrefix: string;        // `<prefix>-<threadId>` names the session
    token?: string;               // empty/undefined = local trust (loopback bind is the boundary)
    maxTurns?: number;
}

export default class Module {
    #seam: DaemonSeam;
    #opts: ModuleOptions;
    #portal: Portal;
    #http: HttpServer;
    #threads = new Map<string, ClientEnvelope>(); // threadId → envelope

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

    // threadId → envelope: reattach by name, else create (session options ride the
    // first run's forwardedProps.plurnk, as before).
    async #envelope(threadId: string, forwarded?: Record<string, unknown>): Promise<{ env: ClientEnvelope; reattached: boolean }> {
        const cached = this.#threads.get(threadId);
        if (cached !== undefined) return { env: cached, reattached: true };
        const name = `${this.#opts.sessionPrefix}-${threadId}`;
        const known = (await this.#seam.listSessions()).find((s) => s.name === name);
        let env: ClientEnvelope;
        let reattached = false;
        if (known !== undefined) {
            env = await this.#seam.attachSession({ sessionId: known.id });
            reattached = true;
        } else {
            const opts = forwarded ?? {};
            env = await this.#seam.createSession({
                name,
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
            this.#portal.closeThread(sessionId);
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

        this.#portal.openThread({ sessionId, runId, threadId: input.threadId, emit, modelRunId: runId });
        emit([
            { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
            stateSnapshot({ providers: this.#seam.listProviders().aliases, session: { id: sessionId, name: env.sessionName, projectRoot: env.projectRoot } }),
        ]);
        if (finished) return;

        // §3 — a management ACTION run (forwardedProps.plurnk.action): execute via the
        // seam, project the outcome as plurnk.action.result, finish. No loop driven.
        const action = parseAction(input.forwardedProps);
        if (action !== null) {
            const outcome = await this.#action(action, env);
            emit([actionResult(action.kind, outcome), { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId }]);
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

    // The action executor — the verb surface, scoped to the thread's own session.
    // Every kind maps to a seam operation; an unknown kind is an honest error, never a
    // silent pass-through (the seam is the whole surface — no RPC fallback beneath it).
    // loop.inject rides here too (§4): the seam's unified runLoop folds a prompt into
    // the active drain; the steered effect streams on the original run's open SSE.
    async #action(a: ActionRequest, env: ClientEnvelope): Promise<ActionOutcome> {
        const p = a.params;
        try {
            switch (a.kind) {
                case "ping": return { ok: true, result: {} };
                case "providers.list": return { ok: true, result: this.#seam.listProviders() };
                case "session.list": return { ok: true, result: { sessions: await this.#seam.listSessions() } };
                case "session.runs": return { ok: true, result: { runs: await this.#seam.listRuns(env.sessionId) } };
                case "log.read": {
                    const entries = await this.#seam.readLog({ sessionId: env.sessionId, runId: await this.#seam.ensureModelRun(env.sessionId), ...(typeof p.limit === "number" ? { limit: p.limit } : {}), ...(typeof p.sinceId === "number" ? { sinceId: p.sinceId } : {}) });
                    return { ok: true, result: { entries } };
                }
                case "loop.inject": {
                    if (typeof p.prompt !== "string" || p.prompt.length === 0) return { ok: false, error: "loop.inject requires prompt" };
                    const ack = await this.#seam.runLoop({ sessionId: env.sessionId, runId: await this.#seam.ensureModelRun(env.sessionId), prompt: p.prompt });
                    return { ok: true, result: ack };
                }
                case "session.create": {
                    // An explicit named session: the NAME is the threadId (the module's
                    // thread→envelope binding stays consistent — subsequent runs address it).
                    const threadId = typeof p.name === "string" && p.name.length > 0 ? p.name : crypto.randomUUID().slice(0, 8);
                    const { env: created } = await this.#envelope(threadId, p);
                    return { ok: true, result: { id: created.sessionId, name: threadId, runId: created.runId } };
                }
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
                case "run.fork": return { ok: true, result: await this.#seam.forkRun({ sessionId: env.sessionId, runId: await this.#seam.ensureModelRun(env.sessionId), ...(typeof p.name === "string" ? { name: p.name } : {}) }) };
                default: return { ok: false, error: `unknown action kind '${a.kind}' — the seam surface is the contract` };
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

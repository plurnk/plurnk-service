// The AG-UI face: POST / runs an agent turn and streams the projection as SSE until the loop
// terminates; POST /resolve answers a pending proposal (file edit, MCP auth, [300] question).
// An AG-UI threadId IS a plurnk session (`<prefix>-<threadId>`, created on first run, reattached
// after) — the daemon's extended context persists across AG-UI runs for free (§agui-thread-is-session).

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import DaemonClient from "./DaemonClient.ts";
import Translator from "./Translator.ts";
import type { AguiEvent, LogEntryNotification, ProposalNotification, RunAgentInput, TerminatedNotification } from "./types.ts";

const env = (name: string): string => {
    const v = process.env[name];
    if (v === undefined || v.length === 0) throw new Error(`plurnk-agui: ${name} must be set (see .env.example)`);
    return v;
};

export default class Server {
    #http: HttpServer;
    #daemonUrl: string;
    #threads = new Map<string, { sessionId: number; client: DaemonClient; reattached: boolean; modelRunId: number | null }>();

    constructor() {
        this.#daemonUrl = env("PLURNK_AGUI_DAEMON_URL");
        this.#http = createServer((req, res) => { void this.#route(req, res); });
    }

    async listen(): Promise<{ host: string; port: number }> {
        const host = env("PLURNK_AGUI_HOST");
        await new Promise<void>((resolve) => this.#http.listen(Number(env("PLURNK_AGUI_PORT")), host, resolve));
        const addr = this.#http.address();
        if (addr === null || typeof addr === "string") throw new Error("plurnk-agui: listener bound no TCP address");
        return { host, port: addr.port }; // the BOUND port — PORT=0 (ephemeral) reports the real one
    }

    async close(): Promise<void> {
        for (const t of this.#threads.values()) t.client.close();
        await new Promise<void>((resolve, reject) => this.#http.close((e) => (e ? reject(e) : resolve())));
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            if (req.method === "POST" && (req.url === "/" || req.url === "/agui")) return await this.#run(req, res);
            if (req.method === "POST" && req.url === "/resolve") return await this.#resolve(req, res);
            if (req.method === "POST" && req.url === "/plurnk/rpc") return await this.#rpc(req, res);
            res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "POST / (AG-UI run) or POST /resolve" }));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: message }));
        }
    }

    async #thread(threadId: string, createOptions?: Record<string, unknown>): Promise<{ sessionId: number; client: DaemonClient; reattached: boolean; modelRunId: number | null }> {
        const existing = this.#threads.get(threadId);
        if (existing !== undefined) return existing;
        const client = await DaemonClient.connect(this.#daemonUrl);
        const name = `${env("PLURNK_AGUI_SESSION_PREFIX")}-${threadId}`;
        // Reattach by NAME via session.list → attach by ID (the daemon's real contract — the
        // earlier attach-by-name silently created a fresh session every bridge restart, found
        // by the service's own §proposal-list e2e). A rediscovered thread is a REATTACH.
        const listed = await client.call<{ sessions: Array<{ id: number; name: string }> }>("session.list", {});
        const known = Array.isArray(listed?.sessions) ? listed.sessions.find((x) => x.name === name) : undefined;
        let sessionId: number;
        let reattached = false;
        let modelRunId: number | null = null;
        if (known !== undefined) {
            await client.call("session.attach", { id: known.id });
            sessionId = known.id;
            reattached = true;
            const runs = await client.call<{ runs: Array<{ id: number; name: string }> }>("session.runs", {}).catch(() => null);
            modelRunId = (Array.isArray(runs?.runs) ? runs.runs.find((r) => r.name.startsWith("model-"))?.id : undefined) ?? null;
        } else {
            // §agui-forwarded-props — RunAgentInput.forwardedProps.plurnk is the spec's sanctioned
            // side-channel: session.create options (projectRoot, constraints, settings) ride the
            // thread's FIRST run. The bridge's questions default composes UNDER an explicit one.
            const opts = createOptions ?? {};
            const settings = { ...(env("PLURNK_AGUI_QUESTIONS") === "1" ? { questions: true } : {}), ...(typeof opts.settings === "object" && opts.settings !== null ? opts.settings : {}) };
            const created = await client.call<{ id: number; runId?: number }>("session.create", {
                name, settings,
                ...(typeof opts.projectRoot === "string" ? { projectRoot: opts.projectRoot } : {}),
                ...(Array.isArray(opts.constraints) ? { constraints: opts.constraints } : {}),
            });
            sessionId = created.id;
            modelRunId = typeof created.runId === "number" ? created.runId : null;
        }
        const thread = { sessionId, client, reattached, modelRunId };
        this.#threads.set(threadId, thread);
        return thread;
    }

    async #run(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const input = JSON.parse(await Server.#body(req)) as RunAgentInput;
        if (typeof input.threadId !== "string" || input.threadId.length === 0) throw new Error("RunAgentInput.threadId required");
        const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
        if (lastUser?.content === undefined || lastUser.content.length === 0) throw new Error("RunAgentInput.messages must carry a user message");

        const forwarded = (input.forwardedProps as { plurnk?: Record<string, unknown> } | undefined)?.plurnk;
        const thread = await this.#thread(input.threadId, forwarded);
        const client = thread.client;
        const translator = new Translator({ threadId: input.threadId, runId: input.runId ?? crypto.randomUUID(), modelRunId: thread.modelRunId });

        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "access-control-allow-origin": "*",
        });
        const emit = (events: AguiEvent[]): void => {
            for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        };

        // The state gauge starts TRUE: the daemon's providers.list carries the effective prompt
        // budget (service#345) — passed through verbatim, never recomputed.
        const providers = await client.call<{ aliases: Array<{ alias: string; model: string; active: boolean; contextSize: number | null }> }>("providers.list", {}).catch(() => null);
        const active = Array.isArray(providers?.aliases) ? providers.aliases.find((a) => a.active) ?? null : null;
        emit(translator.runStarted(active === null ? undefined : { budget: { contextSize: active.contextSize }, model: { alias: active.alias, id: active.model } }));
        // A reattached thread starts ORIENTED, not blind: the session log replays as
        // MESSAGES_SNAPSHOT (§agui-replay) and any stopped world re-surfaces immediately —
        // the indefinite-wait ruling's client half (a days-old question is discoverable).
        if (thread.reattached) {
            // The conversation spine lives in the MODEL run (service #214) — log.read defaults
            // to the connection's own run, so resolve the model run via session.runs first.
            const runs = await client.call<{ runs: Array<{ id: number; name: string }> }>("session.runs", {}).catch(() => null);
            const modelRun = Array.isArray(runs?.runs) ? runs.runs.find((r) => r.name.startsWith("model-")) : undefined;
            const history = modelRun === undefined ? null : await client.call<{ entries: Array<Record<string, unknown>> }>("log.read", { runId: modelRun.id, limit: 1000 }).catch(() => null);
            if (history !== null && Array.isArray(history.entries)) emit(translator.replay(history.entries));
            const pending = await client.call<{ proposals: Array<Record<string, unknown>> }>("proposal.list", {}).catch(() => null);
            if (pending !== null && Array.isArray(pending.proposals)) {
                for (const pr of pending.proposals) emit([{ type: "CUSTOM", name: "plurnk.proposal", value: pr }]);
            }
        }
        const done = new Promise<void>((resolve) => {
            const offEntry = client.on("log/entry", (p) => emit(translator.logEntry(p as LogEntryNotification)));
            const offProposal = client.on("loop/proposal", (p) => emit(translator.proposal(p as ProposalNotification)));
            const offTelemetry = client.on("loop/telemetry", (p) => emit(translator.telemetry(p)));
            const offTerm = client.on("loop/terminated", (p) => {
                emit(translator.terminated(p as TerminatedNotification));
                offEntry(); offProposal(); offTelemetry(); offTerm();
                resolve();
            });
        });
        const ack = await client.call<{ loopId: number }>("loop.run", {
            prompt: lastUser.content,
            maxTurns: Number(env("PLURNK_AGUI_MAX_TURNS")),
            flags: { yolo: env("PLURNK_AGUI_YOLO") === "1" },
        });
        // AG-UI cancellation: the frontend hanging up IS the abort signal — a dropped SSE
        // stream cancels the loop rather than orphaning a run nobody is watching.
        let finished = false;
        req.on("close", () => {
            if (!finished) void client.call("loop.cancel", { loopId: ack.loopId }).catch(() => {});
        });
        await done;
        finished = true;
        res.end();
    }

    // §agui-management-plane — the charter's ONE escape hatch: AG-UI models the RUN plane;
    // the workspace plane (sessions, entry CRUD, providers, auth) rides a boring JSON-RPC
    // passthrough. {threadId, method, params} → the thread's own daemon connection (so session
    // scoping is exactly the thread's), the daemon's response verbatim. The daemon's method
    // registry is the contract — discover it via {method: "discover"}.
    async #rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const p = JSON.parse(await Server.#body(req)) as { threadId: string; method: string; params?: object };
        if (typeof p.threadId !== "string" || p.threadId.length === 0) throw new Error("/plurnk/rpc requires threadId");
        if (typeof p.method !== "string" || p.method.length === 0) throw new Error("/plurnk/rpc requires method");
        const thread = await this.#thread(p.threadId);
        const result = await thread.client.call(p.method, p.params ?? {});
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
    }

    async #resolve(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const p = JSON.parse(await Server.#body(req)) as { threadId: string; logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string };
        const thread = this.#threads.get(p.threadId);
        if (thread === undefined) throw new Error(`unknown threadId '${p.threadId}' — resolve rides the thread that raised the proposal`);
        const result = await thread.client.call("loop.resolve", { logEntryId: p.logEntryId, decision: p.decision, ...(p.body !== undefined ? { body: p.body } : {}) });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result ?? { ok: true }));
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

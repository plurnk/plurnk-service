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
    #threads = new Map<string, { sessionId: number; client: DaemonClient }>();

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
            res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "POST / (AG-UI run) or POST /resolve" }));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: message }));
        }
    }

    async #thread(threadId: string): Promise<{ sessionId: number; client: DaemonClient }> {
        const existing = this.#threads.get(threadId);
        if (existing !== undefined) return existing;
        const client = await DaemonClient.connect(this.#daemonUrl);
        const name = `${env("PLURNK_AGUI_SESSION_PREFIX")}-${threadId}`;
        // Attach if the session exists (a bridge restart must not orphan threads); create otherwise.
        let sessionId: number;
        try {
            const attached = await client.call<{ id: number }>("session.attach", { name });
            sessionId = attached.id;
        } catch {
            const settings = env("PLURNK_AGUI_QUESTIONS") === "1" ? { questions: true } : {};
            const created = await client.call<{ id: number }>("session.create", { name, settings });
            sessionId = created.id;
        }
        const thread = { sessionId, client };
        this.#threads.set(threadId, thread);
        return thread;
    }

    async #run(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const input = JSON.parse(await Server.#body(req)) as RunAgentInput;
        if (typeof input.threadId !== "string" || input.threadId.length === 0) throw new Error("RunAgentInput.threadId required");
        const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
        if (lastUser?.content === undefined || lastUser.content.length === 0) throw new Error("RunAgentInput.messages must carry a user message");

        const { client } = await this.#thread(input.threadId);
        const translator = new Translator({ threadId: input.threadId, runId: input.runId ?? crypto.randomUUID() });

        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "access-control-allow-origin": "*",
        });
        const emit = (events: AguiEvent[]): void => {
            for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        };

        emit(translator.runStarted());
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
        await client.call("loop.run", {
            prompt: lastUser.content,
            maxTurns: Number(env("PLURNK_AGUI_MAX_TURNS")),
            flags: { yolo: env("PLURNK_AGUI_YOLO") === "1" },
        });
        await done;
        res.end();
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

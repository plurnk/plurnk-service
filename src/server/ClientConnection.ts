// Per-WebSocket-client JSON-RPC dispatch. One instance per connected client.
// Owns session attachment state, calls into the engine for auto-create on
// first requiresInit RPC, closes the client loop on disconnect.
//
// SPEC §13.2 (protocol), §13.7 (lifecycle), §13.8 (errors).

import type { WebSocket } from "ws";
import type Engine from "../core/Engine.ts";
import type MethodRegistry from "./MethodRegistry.ts";
import type { DaemonSurface, HandlerContext, NotifyTarget, Provider } from "./MethodRegistry.ts";
import type { Db } from "../core/Db.ts";
import { createClientEnvelope, closeClientLoop } from "./envelope.ts";
import type { ClientEnvelope } from "./envelope.ts";

// JSON-RPC 2.0 standard error codes (SPEC §13.8).
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;

// Plurnk-specific (SPEC §13.8).
const ERR_NOT_INITIALIZED = -32000;

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: string | number | null;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}

export interface ClientConnectionOptions {
    ws: WebSocket;
    registry: MethodRegistry;
    db: Db;
    engine: Engine;
    provider: Provider | null;
    daemon: DaemonSurface;
    broadcast: (target: NotifyTarget, from: ClientConnection, method: string, params?: unknown) => void;
}

export default class ClientConnection {
    #ws: WebSocket;
    #registry: MethodRegistry;
    #db: Db;
    #engine: Engine;
    #provider: Provider | null;
    #daemon: DaemonSurface;
    #broadcast: ClientConnectionOptions["broadcast"];
    #session: ClientEnvelope | null = null;

    constructor({ ws, registry, db, engine, provider, daemon, broadcast }: ClientConnectionOptions) {
        this.#ws = ws;
        this.#registry = registry;
        this.#db = db;
        this.#engine = engine;
        this.#provider = provider;
        this.#daemon = daemon;
        this.#broadcast = broadcast;
        this.#ws.on("message", (data) => this.#handleMessage(data));
    }

    get session(): ClientEnvelope | null {
        return this.#session;
    }

    sendNotification(method: string, params?: unknown): void {
        const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
        if (params !== undefined) notification.params = params;
        this.#send(notification);
    }

    close(): void {
        if (this.#session !== null) {
            // Only close the loop if one was actually allocated. A
            // connection that only ran loop.run never spawned a client
            // loop and has nothing to clean up here.
            if (this.#session.clientLoopId !== null) {
                void closeClientLoop(this.#db, this.#session.clientLoopId, 200);
            }
            this.#session = null;
        }
        if (this.#ws.readyState === 1) this.#ws.terminate();
    }

    async #handleMessage(data: unknown): Promise<void> {
        let id: string | number | null = null;
        let request: JsonRpcRequest;

        try {
            const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
            request = JSON.parse(text);
        } catch (_e) {
            this.#sendError(null, ERR_PARSE, "parse error");
            return;
        }

        if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
            this.#sendError(request.id ?? null, ERR_INVALID_REQUEST, "invalid request");
            return;
        }

        id = request.id ?? null;

        const registration = this.#registry.getMethod(request.method);
        if (registration === undefined) {
            this.#sendError(id, ERR_METHOD_NOT_FOUND, `method '${request.method}' not found`);
            return;
        }

        if (registration.requiresInit && this.#session === null) {
            try {
                const envelope = await createClientEnvelope(this.#db, { prefix: "auto" });
                this.#session = envelope;
                this.#broadcast("all", this, "session/created", {
                    id: envelope.sessionId,
                    name: envelope.sessionName,
                    projectRoot: envelope.projectRoot,
                    persona: envelope.sessionPersona,
                });
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                this.#sendError(id, ERR_NOT_INITIALIZED, `auto-create envelope failed: ${message}`);
                return;
            }
        }

        const ctx: HandlerContext = {
            registry: this.#registry,
            db: this.#db,
            engine: this.#engine,
            provider: this.#provider,
            daemon: this.#daemon,
            session: this.#session,
            attachSession: (envelope) => {
                if (this.#session !== null) {
                    throw new Error("connection already has a session attached");
                }
                this.#session = envelope;
            },
            notify: (target, method, params) => this.#broadcast(target, this, method, params),
        };

        try {
            const result = await registration.handler(request.params ?? {}, ctx);
            this.#send({ jsonrpc: "2.0", id, result });
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            this.#sendError(id, ERR_INTERNAL, message);
        }
    }

    #sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
        const response: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
        if (data !== undefined && response.error !== undefined) response.error.data = data;
        this.#send(response);
    }

    #send(payload: object): void {
        if (this.#ws.readyState === 1) this.#ws.send(JSON.stringify(payload));
    }
}

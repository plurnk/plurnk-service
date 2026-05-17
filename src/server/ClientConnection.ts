// Per-WebSocket-client JSON-RPC dispatch. One instance per connected client.
// Handles inbound request → handler lookup → response, plus outbound
// notification dispatch. SPEC §13.2 (protocol) and §13.8 (errors).

import type { WebSocket } from "ws";
import type MethodRegistry from "./MethodRegistry.ts";
import type { HandlerContext } from "./MethodRegistry.ts";

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

export default class ClientConnection {
    #ws: WebSocket;
    #registry: MethodRegistry;
    #sessionAttached = false;

    constructor({ ws, registry }: { ws: WebSocket; registry: MethodRegistry }) {
        this.#ws = ws;
        this.#registry = registry;
        this.#ws.on("message", (data) => this.#handleMessage(data));
    }

    sendNotification(method: string, params?: unknown): void {
        const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
        if (params !== undefined) notification.params = params;
        this.#send(notification);
    }

    setSessionAttached(value: boolean): void {
        this.#sessionAttached = value;
    }

    close(): void {
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

        if (registration.requiresInit && !this.#sessionAttached) {
            this.#sendError(id, ERR_NOT_INITIALIZED, `method '${request.method}' requires a session attach`);
            return;
        }

        const ctx: HandlerContext = { registry: this.#registry };

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

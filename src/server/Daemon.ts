// Top-level daemon orchestrator. Owns the WebSocketServer, the
// MethodRegistry, and the active ClientConnections. Lifecycle is start +
// stop; constructor wires up the bundled method registrations.
//
// SPEC §13 — wire protocol.

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import MethodRegistry from "./MethodRegistry.ts";
import ClientConnection from "./ClientConnection.ts";
import { register as registerPing } from "./methods/ping.ts";
import { register as registerDiscover } from "./methods/discover.ts";

export interface DaemonOptions {
    host?: string;
    port?: number;
}

export interface DaemonAddress {
    host: string;
    port: number;
}

export default class Daemon {
    #registry: MethodRegistry;
    #wss: WebSocketServer | null = null;
    #connections = new Set<ClientConnection>();

    constructor() {
        this.#registry = new MethodRegistry();
        registerPing(this.#registry);
        registerDiscover(this.#registry);
    }

    get registry(): MethodRegistry {
        return this.#registry;
    }

    async start({ host = "127.0.0.1", port = 3044 }: DaemonOptions = {}): Promise<DaemonAddress> {
        if (this.#wss !== null) throw new Error("daemon already started");

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
    }

    #onConnection(ws: WebSocket): void {
        const conn = new ClientConnection({ ws, registry: this.#registry });
        this.#connections.add(conn);
        ws.on("close", () => this.#connections.delete(conn));
    }
}

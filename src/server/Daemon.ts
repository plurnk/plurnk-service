// Top-level daemon orchestrator. Owns the DB connection, the method
// registry, the WebSocketServer, and the active client connections.
// SPEC §13.

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { DatabaseSync } from "node:sqlite";
import MethodRegistry from "./MethodRegistry.ts";
import type { NotifyTarget } from "./MethodRegistry.ts";
import ClientConnection from "./ClientConnection.ts";
import { register as registerPing } from "./methods/ping.ts";
import { register as registerDiscover } from "./methods/discover.ts";
import { register as registerSessionCreate } from "./methods/session_create.ts";
import { register as registerSessionList } from "./methods/session_list.ts";
import { register as registerSessionAttach } from "./methods/session_attach.ts";

export interface DaemonOptions {
    host?: string;
    port?: number;
}

export interface DaemonAddress {
    host: string;
    port: number;
}

export default class Daemon {
    #db: DatabaseSync;
    #registry: MethodRegistry;
    #wss: WebSocketServer | null = null;
    #connections = new Set<ClientConnection>();

    constructor({ db }: { db: DatabaseSync }) {
        this.#db = db;
        this.#registry = new MethodRegistry();
        registerPing(this.#registry);
        registerDiscover(this.#registry);
        registerSessionCreate(this.#registry);
        registerSessionList(this.#registry);
        registerSessionAttach(this.#registry);
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
        const conn = new ClientConnection({
            ws,
            registry: this.#registry,
            db: this.#db,
            broadcast: (target, from, method, params) => this.#broadcast(target, from, method, params),
        });
        this.#connections.add(conn);
        ws.on("close", () => {
            conn.close();
            this.#connections.delete(conn);
        });
    }

    #broadcast(target: NotifyTarget, from: ClientConnection, method: string, params?: unknown): void {
        if (target === "this") {
            from.sendNotification(method, params);
            return;
        }
        for (const conn of this.#connections) {
            conn.sendNotification(method, params);
        }
    }
}

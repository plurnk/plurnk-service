// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the WebSocketServer, and the active client connections.
// SPEC §13.

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { DatabaseSync } from "node:sqlite";
import Engine from "../core/Engine.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import MethodRegistry from "./MethodRegistry.ts";
import type { NotifyTarget, Provider } from "./MethodRegistry.ts";
import ClientConnection from "./ClientConnection.ts";

import { register as registerPing } from "./methods/ping.ts";
import { register as registerDiscover } from "./methods/discover.ts";
import { register as registerSessionCreate } from "./methods/session_create.ts";
import { register as registerSessionList } from "./methods/session_list.ts";
import { register as registerSessionAttach } from "./methods/session_attach.ts";
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
    #engine: Engine;
    #provider: Provider | null;
    #registry: MethodRegistry;
    #wss: WebSocketServer | null = null;
    #connections = new Set<ClientConnection>();

    constructor({ db, schemes, provider }: { db: DatabaseSync; schemes?: SchemeRegistry; provider?: Provider | null }) {
        this.#db = db;
        this.#engine = new Engine({ db, schemes: schemes ?? new SchemeRegistry() });
        this.#provider = provider ?? null;
        this.#registry = new MethodRegistry();
        this.#registerBuiltins();
        this.#registerNotifications();
    }

    get registry(): MethodRegistry { return this.#registry; }
    get engine(): Engine { return this.#engine; }
    get provider(): Provider | null { return this.#provider; }

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

    #registerBuiltins(): void {
        registerPing(this.#registry);
        registerDiscover(this.#registry);
        registerSessionCreate(this.#registry);
        registerSessionList(this.#registry);
        registerSessionAttach(this.#registry);
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
        registerEntryRead(this.#registry);
        registerLogRead(this.#registry);
    }

    #registerNotifications(): void {
        this.#registry.registerNotification("log/entry", {
            description: "A new log_entries row was written; scoped to the connection's attached session.",
            params: { entry: "LogEntry — wire-shape log_entries row" },
        });
        this.#registry.registerNotification("loop/terminated", {
            description: "A loop has reached a terminal status; scoped to the connection's attached session.",
            params: {
                loopId: "number",
                finalStatus: "number — terminal status code (200, 499, etc.)",
                hitMaxTurns: "boolean",
            },
        });
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

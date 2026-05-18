// Shared WebSocket / Daemon test helpers. Used by every Daemon.* and
// SEND[*] integration test.

import { WebSocket } from "ws";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import Daemon from "../../src/server/Daemon.ts";
import type Mock from "../../src/providers/Mock.ts";
import type { MockResponse } from "../../src/providers/Mock.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated } from "./_helpers.ts";

export interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

export interface DaemonAddr { host: string; port: number }

export const rpcCall = (ws: WebSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); resolve(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        const payload: { jsonrpc: string; id: number; method: string; params?: object } = { jsonrpc: "2.0", id, method };
        if (params !== undefined) payload.params = params;
        ws.send(JSON.stringify(payload));
    });

// Subscribe to a notification stream. Returns a getter that yields the
// captured params in order.
export const subscribeNotifications = (ws: WebSocket, method: string): (() => unknown[]) => {
    const captured: unknown[] = [];
    ws.on("message", (data) => {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const parsed = JSON.parse(text) as { method?: string; params?: unknown; id?: unknown };
        if (parsed.id === undefined && parsed.method === method) captured.push(parsed.params);
    });
    return () => captured;
};

// Sleep enough for notifications to flush across the worker boundary.
// 50ms is what we landed on after diagnosing race conditions in
// stream/event tests. Don't use setImmediate — it isn't enough.
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

export const connect = (addr: DaemonAddr): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });

// Open db + daemon, run the callback, clean up. Provider is optional.
export const withDaemon = async <T>(
    provider: Mock | null,
    fn: (db: Db, daemon: Daemon, addr: DaemonAddr) => Promise<T>,
): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try { return await fn(db, daemon, addr); }
    finally { await daemon.stop(); await db.close(); }
};

// Parse plurnk DSL into statement ops. Used to build mock provider responses.
export const parseDsl = (text: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(text);
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
};

export const makeMockResponse = (dsl: string, tokens: number = 0): MockResponse => ({
    assistant: { tokens, content: dsl, ops: parseDsl(dsl), reasoning: null },
    assistantRaw: null,
});

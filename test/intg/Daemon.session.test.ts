// Daemon session-lifecycle methods: result shapes + connection re-binding.
// #199 (create surfaces the auto-created run), #196 (re-attach without reconnect).

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { Db } from "../../src/core/Db.ts";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";

interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

const rpcCall = (ws: WebSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); resolve(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

const withDaemon = async <T>(fn: (db: Db, addr: { host: string; port: number }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try { return await fn(db, addr); }
    finally { await daemon.stop(); await db.close(); }
};

const connect = (addr: { host: string; port: number }): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });

test("[§methods-session-create] session.create returns the auto-created run's identity (runId + runName) — #199", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "session.create", { name: "create-shape" });
            const result = r.result as { id: number; name: string; runId: number; runName: string };
            assert.equal(typeof result.id, "number");
            assert.equal(result.name, "create-shape");
            assert.equal(typeof result.runId, "number", "create must surface the run id (no pending-dance)");
            assert.equal(typeof result.runName, "string", "create must surface the run name");
        } finally { ws.close(); }
    });
});

test("#196 a bound connection re-binds to a different session in place (no reconnect)", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const a = await rpcCall(ws, 1, "session.create", { name: "first" });
            const aId = (a.result as { id: number }).id;
            // Re-create on the SAME connection — previously threw "already attached".
            const b = await rpcCall(ws, 2, "session.create", { name: "second" });
            assert.equal(b.error, undefined, "re-create on a bound connection must not throw");
            const bId = (b.result as { id: number }).id;
            assert.notEqual(bId, aId, "the connection switched to a fresh session");
            // Re-attach to the first by id — also re-binds cleanly.
            const back = await rpcCall(ws, 3, "session.attach", { id: aId });
            assert.equal(back.error, undefined, "re-attach on a bound connection must not throw");
            assert.equal((back.result as { id: number }).id, aId, "switched back to the first session");
        } finally { ws.close(); }
    });
});

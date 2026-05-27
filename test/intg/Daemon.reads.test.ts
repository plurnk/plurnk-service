// Tests for daemon Phase 4: entry.read and log.read.

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

test("entry.read returns full entry shape (channels + tags + metadata)", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "entry-read-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://france/capital", content: "Paris", tags: ["france", "europe"] });

            const r = await rpcCall(ws, 3, "entry.read", { path: "known://france/capital" });
            const result = r.result as { status: number; entry: { scheme: string; pathname: string; channels: Record<string, { content: string; mimetype: string }>; tags: string[] } };
            assert.equal(result.status, 200);
            assert.equal(result.entry.scheme, "known");
            assert.equal(result.entry.pathname, "france/capital");
            assert.equal(result.entry.channels.body.content, "Paris");
            assert.equal(result.entry.channels.body.mimetype, "text/markdown");
            assert.deepEqual(result.entry.tags.toSorted(), ["europe", "france"]);
        } finally { ws.close(); }
    });
});

test("entry.read returns 404 for missing entry", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "404-test" });
            const r = await rpcCall(ws, 2, "entry.read", { path: "known://does-not-exist" });
            const result = r.result as { status: number; entry: null };
            assert.equal(result.status, 404);
            assert.equal(result.entry, null);
        } finally { ws.close(); }
    });
});

test("entry.read requires URL-shaped path", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "shape-test" });
            const r = await rpcCall(ws, 2, "entry.read", { path: "not-a-url" });
            assert.equal(r.error?.code, -32603);
            assert.match(r.error?.message ?? "", /URL-shaped/);
        } finally { ws.close(); }
    });
});

test("entry.read with fragment strips fragment (channel selection is per-op concern)", async () => {
    // entry.read returns the WHOLE entry. Channel selection via fragment is for
    // op.read where the model wants a specific channel. entry.read is the
    // omnibus surface — fragment is ignored.
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "fragment-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://x", content: "body content" });
            const r = await rpcCall(ws, 3, "entry.read", { path: "known://x#anything" });
            if (r.result === undefined) {
                throw new Error(`entry.read failed: ${JSON.stringify(r)}`);
            }
            const result = r.result as { status: number; entry: { channels: Record<string, unknown> } };
            assert.equal(result.status, 200);
            assert.ok(result.entry.channels.body !== undefined);
        } finally { ws.close(); }
    });
});

test("log.read returns recent entries from the attached session", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "log-read-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://a", content: "alpha" });
            await rpcCall(ws, 3, "op.edit", { path: "known://b", content: "beta" });

            const r = await rpcCall(ws, 4, "log.read");
            const result = r.result as { status: number; entries: Array<{ op: string; origin: string }> };
            assert.equal(result.status, 200);
            assert.equal(result.entries.length, 2);
            // Order is at DESC — most recent first
            assert.ok(result.entries.every((e) => e.op === "EDIT" && e.origin === "client"));
        } finally { ws.close(); }
    });
});

test("log.read respects limit", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "limit-test" });
            for (let i = 0; i < 5; i++) {
                await rpcCall(ws, 10 + i, "op.edit", { path: `known://e${i}`, content: `v${i}` });
            }
            const r = await rpcCall(ws, 20, "log.read", { limit: 3 });
            const result = r.result as { entries: Array<unknown> };
            assert.equal(result.entries.length, 3);
        } finally { ws.close(); }
    });
});

test("log.read filters by sinceId for incremental fetch", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "since-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://a", content: "first" });
            const firstFetch = await rpcCall(ws, 3, "log.read");
            const firstResult = firstFetch.result as { entries: Array<{ id: number }> };
            const lastSeenId = firstResult.entries[0].id;

            await rpcCall(ws, 4, "op.edit", { path: "known://b", content: "second" });

            const incremental = await rpcCall(ws, 5, "log.read", { sinceId: lastSeenId });
            const incrementalResult = incremental.result as { entries: Array<{ id: number; tx: { op: string; target: { pathname: string } } }> };
            assert.equal(incrementalResult.entries.length, 1, "only the new entry");
            assert.equal(incrementalResult.entries[0].tx.target.pathname, "b");
        } finally { ws.close(); }
    });
});

test("log.read entries have hydrated JSON columns", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "hydration-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://x", content: "body", tags: ["a", "b"] });

            const r = await rpcCall(ws, 3, "log.read");
            const result = r.result as { entries: Array<{ tx: unknown; signal: unknown; status_rx: number }> };
            assert.equal(result.entries.length, 1);
            const entry = result.entries[0];
            // tx should be an object (parsed JSON), not a string
            assert.equal(typeof entry.tx, "object");
            // signal should be a parsed array (tags)
            assert.ok(Array.isArray(entry.signal));
            assert.equal(entry.status_rx, 201);
        } finally { ws.close(); }
    });
});

test("log.read is session-scoped — doesn't see other sessions' logs", async () => {
    await withDaemon(async (_db, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            await rpcCall(wsA, 1, "session.create", { name: "session-A" });
            await rpcCall(wsB, 1, "session.create", { name: "session-B" });

            await rpcCall(wsA, 2, "op.edit", { path: "known://a", content: "from A" });
            await rpcCall(wsB, 2, "op.edit", { path: "known://b", content: "from B" });

            const rA = await rpcCall(wsA, 3, "log.read");
            const rB = await rpcCall(wsB, 3, "log.read");
            const aEntries = (rA.result as { entries: Array<{ tx: { target: { pathname: string } } }> }).entries;
            const bEntries = (rB.result as { entries: Array<{ tx: { target: { pathname: string } } }> }).entries;

            assert.equal(aEntries.length, 1);
            assert.equal(aEntries[0].tx.target.pathname, "a");
            assert.equal(bEntries.length, 1);
            assert.equal(bEntries[0].tx.target.pathname, "b");
        } finally { wsA.close(); wsB.close(); }
    });
});

test("discover catalog includes entry.read and log.read", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "discover");
            const cat = r.result as { methods: Record<string, unknown> };
            assert.ok(cat.methods["entry.read"] !== undefined);
            assert.ok(cat.methods["log.read"] !== undefined);
        } finally { ws.close(); }
    });
});

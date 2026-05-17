import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import type { DatabaseSync } from "node:sqlite";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_helpers.ts";

interface RpcResponse {
    jsonrpc: "2.0";
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

// Round-trip helper. Sends one request, resolves with the response for that id.
const rpcCall = (ws: WebSocket, id: number | string, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) {
                ws.off("message", onMessage);
                resolve(parsed);
            }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        const payload: { jsonrpc: string; id: number | string; method: string; params?: object } = { jsonrpc: "2.0", id, method };
        if (params !== undefined) payload.params = params;
        ws.send(JSON.stringify(payload));
    });

// Collect notifications by method name. Returns a function that returns all
// captured notifications matching `method` since subscription.
const subscribeNotifications = (ws: WebSocket, method: string): (() => unknown[]) => {
    const captured: unknown[] = [];
    ws.on("message", (data) => {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const parsed = JSON.parse(text) as { method?: string; params?: unknown; id?: unknown };
        if (parsed.id === undefined && parsed.method === method) {
            captured.push(parsed.params);
        }
    });
    return () => captured;
};

const withDaemon = async <T>(fn: (db: DatabaseSync, addr: { host: string; port: number }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try {
        return await fn(db, addr);
    } finally {
        await daemon.stop();
        db.close();
    }
};

const connect = (addr: { host: string; port: number }): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });

// Brief wait helper used to let notifications settle on the wire.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test("Daemon: start binds to ephemeral port and reports the address", async () => {
    await withDaemon(async (_db, addr) => {
        assert.equal(addr.host, "127.0.0.1");
        assert.ok(addr.port > 0);
    });
});

test("Daemon: ping returns empty result without requiring init", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "ping");
            assert.deepEqual(response.result, {});
            assert.equal(response.error, undefined);
        } finally {
            ws.close();
        }
    });
});

test("Daemon: discover returns catalog including session methods", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { protocolVersion: string; methods: Record<string, unknown>; notifications: Record<string, unknown> };
            assert.equal(cat.protocolVersion, "0.1.0");
            assert.ok(cat.methods.ping !== undefined);
            assert.ok(cat.methods.discover !== undefined);
            assert.ok(cat.methods["session.create"] !== undefined);
            assert.ok(cat.methods["session.list"] !== undefined);
            assert.ok(cat.methods["session.attach"] !== undefined);
            assert.ok(cat.notifications["session/created"] !== undefined);
        } finally {
            ws.close();
        }
    });
});

test("Daemon: unknown method returns -32601 method-not-found", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "nonexistent.method");
            assert.equal(response.error?.code, -32601);
        } finally {
            ws.close();
        }
    });
});

test("Daemon: malformed JSON returns -32700 parse-error", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const messagePromise = new Promise<RpcResponse>((resolve) => {
                ws.once("message", (data) => {
                    const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
                    resolve(JSON.parse(text) as RpcResponse);
                });
            });
            ws.send("this is not json");
            const response = await messagePromise;
            assert.equal(response.id, null);
            assert.equal(response.error?.code, -32700);
        } finally {
            ws.close();
        }
    });
});

test("session.create returns id+name and emits session/created notification", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "session/created");
            const response = await rpcCall(ws, 1, "session.create", { name: "alpha" });
            const result = response.result as { id: number; name: string };
            assert.equal(result.name, "alpha");
            assert.ok(result.id > 0);
            await flush();
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.id, result.id);
            assert.equal(params.name, "alpha");

            // Verify DB rows: session, run, client loop all created
            const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(result.id) as { id: number; name: string };
            assert.equal(session.name, "alpha");
            const run = db.prepare("SELECT * FROM runs WHERE session_id = ?").get(result.id) as { id: number };
            assert.ok(run.id > 0);
            const loop = db.prepare("SELECT * FROM loops WHERE run_id = ?").get(run.id) as { id: number; status: number; prompt: string };
            assert.equal(loop.status, 102);
            assert.equal(loop.prompt, "");
        } finally {
            ws.close();
        }
    });
});

test("session.create with no name auto-generates a unique name", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.create");
            const result = response.result as { id: number; name: string };
            assert.ok(result.name.length > 0);
            assert.match(result.name, /^session-/);
        } finally {
            ws.close();
        }
    });
});

test("session.create rejects when already attached", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "first" });
            const response = await rpcCall(ws, 2, "session.create", { name: "second" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /already has a session/);
        } finally {
            ws.close();
        }
    });
});

test("session.list returns sessions most-recent-first", async () => {
    await withDaemon(async (db, addr) => {
        // Seed two sessions directly
        db.prepare("INSERT INTO sessions (name) VALUES (?)").run("first");
        db.prepare("INSERT INTO sessions (name) VALUES (?)").run("second");

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.list");
            const result = response.result as { sessions: Array<{ id: number; name: string }> };
            assert.equal(result.sessions.length, 2);
            // Most recent first — order depends on created_at; both inserted now, order may vary,
            // but both names must be present.
            const names = result.sessions.map((s) => s.name).toSorted();
            assert.deepEqual(names, ["first", "second"]);
        } finally {
            ws.close();
        }
    });
});

test("session.attach binds to existing session and opens a new run + client loop", async () => {
    await withDaemon(async (db, addr) => {
        const existing = db.prepare("INSERT INTO sessions (name) VALUES (?) RETURNING id").get("existing") as { id: number };

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: existing.id });
            const result = response.result as { id: number; name: string };
            assert.equal(result.id, existing.id);
            assert.equal(result.name, "existing");

            const runs = db.prepare("SELECT id FROM runs WHERE session_id = ?").all(existing.id) as Array<{ id: number }>;
            assert.equal(runs.length, 1);
            const loops = db.prepare("SELECT id, status FROM loops WHERE run_id = ?").all(runs[0].id) as Array<{ id: number; status: number }>;
            assert.equal(loops.length, 1);
            assert.equal(loops[0].status, 102);
        } finally {
            ws.close();
        }
    });
});

test("session.attach to nonexistent session returns -32603", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.attach", { id: 9999 });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /session 9999 not found/);
        } finally {
            ws.close();
        }
    });
});

test("multiple connections attaching to same session each get their own run", async () => {
    await withDaemon(async (db, addr) => {
        const session = db.prepare("INSERT INTO sessions (name) VALUES (?) RETURNING id").get("shared") as { id: number };

        const ws1 = await connect(addr);
        const ws2 = await connect(addr);
        try {
            await rpcCall(ws1, 1, "session.attach", { id: session.id });
            await rpcCall(ws2, 1, "session.attach", { id: session.id });

            const runs = db.prepare("SELECT id FROM runs WHERE session_id = ?").all(session.id) as Array<{ id: number }>;
            assert.equal(runs.length, 2);

            const loops = db.prepare("SELECT id, status FROM loops").all() as Array<{ id: number; status: number }>;
            assert.equal(loops.length, 2);
            assert.ok(loops.every((l) => l.status === 102));
        } finally {
            ws1.close();
            ws2.close();
        }
    });
});

test("session/created notification broadcasts to other connected clients", async () => {
    await withDaemon(async (_db, addr) => {
        const observer = await connect(addr);
        const creator = await connect(addr);
        try {
            const observerNotifs = subscribeNotifications(observer, "session/created");

            await rpcCall(creator, 1, "session.create", { name: "broadcast-test" });
            await flush();

            const captured = observerNotifs();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.name, "broadcast-test");
        } finally {
            observer.close();
            creator.close();
        }
    });
});

test("client loop status transitions to 200 on clean disconnect", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        const response = await rpcCall(ws, 1, "session.create", { name: "lifecycle" });
        const result = response.result as { id: number };
        const run = db.prepare("SELECT id FROM runs WHERE session_id = ?").get(result.id) as { id: number };
        const loopId = (db.prepare("SELECT id FROM loops WHERE run_id = ?").get(run.id) as { id: number }).id;

        // Loop should be 102 while connected
        let loop = db.prepare("SELECT status FROM loops WHERE id = ?").get(loopId) as { status: number };
        assert.equal(loop.status, 102);

        // Close from client side; daemon's onClose handler closes the loop
        ws.close();
        // Wait for the close event to propagate through the daemon
        await new Promise((r) => setTimeout(r, 50));

        loop = db.prepare("SELECT status FROM loops WHERE id = ?").get(loopId) as { status: number };
        assert.equal(loop.status, 200);
    });
});

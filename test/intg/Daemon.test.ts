import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import Daemon from "../../src/server/Daemon.ts";

// Promisified single-message round-trip helper: send one JSON-RPC request, wait
// for the matching response. Used to keep tests linear.
const rpcCall = (ws: WebSocket, id: number | string, method: string, params?: object): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text);
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

const withDaemon = async <T>(fn: (addr: { host: string; port: number }) => Promise<T>): Promise<T> => {
    const daemon = new Daemon();
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try {
        return await fn(addr);
    } finally {
        await daemon.stop();
    }
};

const connect = (addr: { host: string; port: number }): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });

test("Daemon: start binds to ephemeral port and reports the address", async () => {
    await withDaemon(async (addr) => {
        assert.equal(addr.host, "127.0.0.1");
        assert.ok(addr.port > 0);
    });
});

test("Daemon: start twice on same instance throws", async () => {
    const daemon = new Daemon();
    await daemon.start({ host: "127.0.0.1", port: 0 });
    try {
        await assert.rejects(
            daemon.start({ host: "127.0.0.1", port: 0 }),
            /daemon already started/,
        );
    } finally {
        await daemon.stop();
    }
});

test("Daemon: stop is idempotent (callable when not started)", async () => {
    const daemon = new Daemon();
    await daemon.stop(); // should not throw
});

test("Daemon: ping returns empty result", async () => {
    await withDaemon(async (addr) => {
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

test("Daemon: discover returns the catalog with bundled methods", async () => {
    await withDaemon(async (addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { protocolVersion: string; methods: Record<string, unknown>; notifications: Record<string, unknown> };
            assert.equal(cat.protocolVersion, "0.1.0");
            assert.ok(cat.methods.ping !== undefined);
            assert.ok(cat.methods.discover !== undefined);
            assert.deepEqual(cat.notifications, {});
        } finally {
            ws.close();
        }
    });
});

test("Daemon: unknown method returns -32601 method-not-found", async () => {
    await withDaemon(async (addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "nonexistent.method");
            assert.equal(response.result, undefined);
            assert.equal(response.error?.code, -32601);
            assert.match(response.error?.message ?? "", /nonexistent\.method/);
        } finally {
            ws.close();
        }
    });
});

test("Daemon: malformed JSON returns -32700 parse-error", async () => {
    await withDaemon(async (addr) => {
        const ws = await connect(addr);
        try {
            const messagePromise = new Promise<unknown>((resolve) => {
                ws.once("message", (data) => {
                    const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
                    resolve(JSON.parse(text));
                });
            });
            ws.send("this is not json");
            const response = await messagePromise as { id: null; error: { code: number } };
            assert.equal(response.id, null);
            assert.equal(response.error.code, -32700);
        } finally {
            ws.close();
        }
    });
});

test("Daemon: missing jsonrpc field returns -32600 invalid-request", async () => {
    await withDaemon(async (addr) => {
        const ws = await connect(addr);
        try {
            const messagePromise = new Promise<unknown>((resolve) => {
                ws.once("message", (data) => {
                    const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
                    resolve(JSON.parse(text));
                });
            });
            ws.send(JSON.stringify({ id: 1, method: "ping" }));
            const response = await messagePromise as { error: { code: number } };
            assert.equal(response.error.code, -32600);
        } finally {
            ws.close();
        }
    });
});

test("Daemon: method requiring init rejects when not attached", async () => {
    const daemon = new Daemon();
    daemon.registry.registerMethod("session.test", {
        handler: async () => ({ ok: true }),
        description: "test method that requires init",
        requiresInit: true,
    });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.test");
            assert.equal(response.result, undefined);
            assert.equal(response.error?.code, -32000);
        } finally {
            ws.close();
        }
    } finally {
        await daemon.stop();
    }
});

test("Daemon: handler exception returns -32603 internal-error with the message", async () => {
    const daemon = new Daemon();
    daemon.registry.registerMethod("kaboom", {
        handler: async () => { throw new Error("intentional explosion"); },
        description: "test method that throws",
    });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "kaboom");
            assert.equal(response.error?.code, -32603);
            assert.equal(response.error?.message, "intentional explosion");
        } finally {
            ws.close();
        }
    } finally {
        await daemon.stop();
    }
});

test("Daemon: multiple concurrent clients are isolated", async () => {
    await withDaemon(async (addr) => {
        const ws1 = await connect(addr);
        const ws2 = await connect(addr);
        try {
            const [r1, r2] = await Promise.all([
                rpcCall(ws1, 1, "ping"),
                rpcCall(ws2, 1, "ping"),
            ]);
            assert.deepEqual(r1.result, {});
            assert.deepEqual(r2.result, {});
        } finally {
            ws1.close();
            ws2.close();
        }
    });
});

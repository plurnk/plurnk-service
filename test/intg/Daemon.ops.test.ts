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

const rpcCall = (ws: WebSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
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
        const payload: { jsonrpc: string; id: number; method: string; params?: object } = { jsonrpc: "2.0", id, method };
        if (params !== undefined) payload.params = params;
        ws.send(JSON.stringify(payload));
    });

const subscribeNotifications = (ws: WebSocket, method: string): (() => unknown[]) => {
    const captured: unknown[] = [];
    ws.on("message", (data) => {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const parsed = JSON.parse(text) as { method?: string; params?: unknown; id?: unknown };
        if (parsed.id === undefined && parsed.method === method) captured.push(parsed.params);
    });
    return () => captured;
};

const withDaemon = async <T>(fn: (db: DatabaseSync, addr: { host: string; port: number }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try { return await fn(db, addr); }
    finally { await daemon.stop(); db.close(); }
};

const connect = (addr: { host: string; port: number }): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

test("op.edit creates an entry via engine.dispatch (origin=client)", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "ops-test" });
            const response = await rpcCall(ws, 2, "op.edit", {
                path: "known://france/capital",
                content: "Paris",
                tags: ["france", "geography"],
            });
            const result = response.result as { status: number };
            assert.equal(result.status, 201);

            // Verify entry exists in DB
            const entry = db.prepare("SELECT scheme, pathname FROM entries WHERE pathname = 'france/capital'").get() as { scheme: string; pathname: string };
            assert.equal(entry.scheme, "known");
            assert.equal(entry.pathname, "france/capital");

            // Verify body content
            const body = (db.prepare("SELECT content FROM entry_channels WHERE name = 'body'").get() as { content: string }).content;
            assert.equal(body, "Paris");

            // Verify tags
            const tags = db.prepare("SELECT tag FROM entry_tags ORDER BY tag").all() as { tag: string }[];
            assert.deepEqual(tags.map((t) => t.tag), ["france", "geography"]);

            // Verify log_entries row has origin='client'
            const log = db.prepare("SELECT origin, op FROM log_entries").get() as { origin: string; op: string };
            assert.equal(log.origin, "client");
            assert.equal(log.op, "EDIT");
        } finally { ws.close(); }
    });
});

test("op.read fetches an entry's body", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "read-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://x", content: "hello" });
            const response = await rpcCall(ws, 3, "op.read", { path: "known://x" });
            const result = response.result as { status: number; content: string };
            assert.equal(result.status, 200);
            assert.equal(result.content, "hello");
        } finally { ws.close(); }
    });
});

test("op.read on nonexistent entry returns 404", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "404-test" });
            const response = await rpcCall(ws, 2, "op.read", { path: "known://nope" });
            const result = response.result as { status: number };
            assert.equal(result.status, 404);
        } finally { ws.close(); }
    });
});

test("op.show / op.hide toggle visibility", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "vis-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://x", content: "body" });

            const hideRes = await rpcCall(ws, 3, "op.hide", { path: "known://x" });
            assert.equal((hideRes.result as { status: number }).status, 200);

            const visAfterHide = (db.prepare("SELECT indexed FROM visibility WHERE channel = 'body'").get() as { indexed: number }).indexed;
            assert.equal(visAfterHide, 0);

            const showRes = await rpcCall(ws, 4, "op.show", { path: "known://x" });
            assert.equal((showRes.result as { status: number }).status, 200);

            const visAfterShow = (db.prepare("SELECT indexed FROM visibility WHERE channel = 'body'").get() as { indexed: number }).indexed;
            assert.equal(visAfterShow, 1);
        } finally { ws.close(); }
    });
});

test("op.dispatch accepts a raw PlurnkStatement AST and dispatches it", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "dispatch-test" });
            const statement = {
                op: "EDIT" as const,
                suffix: "",
                signal: null,
                path: {
                    kind: "url" as const, raw: "known://hello",
                    scheme: "known", username: null, password: null,
                    hostname: null, port: null, pathname: "hello",
                    params: {}, fragment: null,
                },
                lineMarker: null,
                body: "world",
                position: { line: 1, column: 1 },
            };
            const response = await rpcCall(ws, 2, "op.dispatch", { statement });
            assert.equal((response.result as { status: number }).status, 201);

            const body = (db.prepare("SELECT content FROM entry_channels WHERE entry_id = (SELECT id FROM entries WHERE pathname = 'hello')").get() as { content: string }).content;
            assert.equal(body, "world");
        } finally { ws.close(); }
    });
});

test("op.parse parses multi-statement text and dispatches each", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "parse-test" });
            const text = `<<EDIT(known://a):alpha:EDIT
<<EDIT(known://b):beta:EDIT`;
            const response = await rpcCall(ws, 2, "op.parse", { text });
            const result = response.result as { results: Array<{ status: number }> };
            assert.equal(result.results.length, 2);
            assert.equal(result.results[0].status, 201);
            assert.equal(result.results[1].status, 201);

            const entries = db.prepare("SELECT pathname FROM entries ORDER BY pathname").all() as Array<{ pathname: string }>;
            assert.deepEqual(entries.map((e) => e.pathname), ["a", "b"]);
        } finally { ws.close(); }
    });
});

test("op.* fires log/entry notification with the entry shape", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "session.create", { name: "notif-test" });
            await rpcCall(ws, 2, "op.edit", { path: "known://x", content: "test" });
            await flush();

            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { entry: { op: string; origin: string; status_rx: number } };
            assert.equal(params.entry.op, "EDIT");
            assert.equal(params.entry.origin, "client");
            assert.equal(params.entry.status_rx, 201);
        } finally { ws.close(); }
    });
});

test("log/entry notification is scoped to session — other sessions don't receive it", async () => {
    await withDaemon(async (_db, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aNotifs = subscribeNotifications(wsA, "log/entry");
            const bNotifs = subscribeNotifications(wsB, "log/entry");

            await rpcCall(wsA, 1, "session.create", { name: "session-A" });
            await rpcCall(wsB, 1, "session.create", { name: "session-B" });

            // Wait for any cross-session noise to settle (session/created is global).
            await flush();
            aNotifs(); // drain any pre-existing
            bNotifs();

            await rpcCall(wsA, 2, "op.edit", { path: "known://x", content: "from A" });
            await flush();

            // A should see its own log/entry; B should not
            assert.equal(aNotifs().length, 1);
            assert.equal(bNotifs().length, 0);
        } finally { wsA.close(); wsB.close(); }
    });
});

test("op.* methods require init: rejected without prior session attach? Auto-create kicks in", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        try {
            // No session.create first; op.edit triggers auto-create per SPEC §13.7
            const response = await rpcCall(ws, 1, "op.edit", { path: "known://x", content: "auto" });
            assert.equal((response.result as { status: number }).status, 201);

            const sessions = db.prepare("SELECT name FROM sessions").all() as Array<{ name: string }>;
            assert.equal(sessions.length, 1);
            assert.match(sessions[0].name, /^auto-/);
        } finally { ws.close(); }
    });
});

test("op.find with empty body returns 200 (engine returns 501 for non-glob today; status 200 is the success route)", async () => {
    // Today the Known scheme doesn't implement `find`; dispatch returns 501.
    // This test pins the contract: op.find IS exposed; engine semantics
    // determine the status. Floor-scope PR adds find to Known/Unknown/Skill.
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "find-test" });
            const response = await rpcCall(ws, 2, "op.find", { scope: "known://" });
            const result = response.result as { status: number };
            // Currently: 501 (Known.find not implemented)
            assert.equal(result.status, 501);
        } finally { ws.close(); }
    });
});

test("op.send broadcast with terminal status updates loop status", async () => {
    await withDaemon(async (db, addr) => {
        const ws = await connect(addr);
        try {
            const session = await rpcCall(ws, 1, "session.create", { name: "send-test" });
            const sessionId = (session.result as { id: number }).id;
            // Get the run + client loop id
            const run = db.prepare("SELECT id FROM runs WHERE session_id = ?").get(sessionId) as { id: number };
            const clientLoopId = (db.prepare("SELECT id FROM loops WHERE run_id = ?").get(run.id) as { id: number }).id;

            const response = await rpcCall(ws, 2, "op.send", { status: 200 });
            assert.equal((response.result as { status: number }).status, 200);

            // The client loop status should now be 200 (terminal SEND broadcast updated it)
            const loop = db.prepare("SELECT status FROM loops WHERE id = ?").get(clientLoopId) as { status: number };
            assert.equal(loop.status, 200);
        } finally { ws.close(); }
    });
});

test("discover catalog includes all op.* methods", async () => {
    await withDaemon(async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { methods: Record<string, unknown>; notifications: Record<string, unknown> };
            const expectedOps = ["op.edit", "op.read", "op.find", "op.show", "op.hide", "op.copy", "op.move", "op.send", "op.exec", "op.dispatch", "op.parse"];
            for (const m of expectedOps) {
                assert.ok(cat.methods[m] !== undefined, `missing method: ${m}`);
            }
            assert.ok(cat.notifications["log/entry"] !== undefined);
            assert.ok(cat.notifications["session/created"] !== undefined);
        } finally { ws.close(); }
    });
});

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { DatabaseSync } from "node:sqlite";
import Daemon from "../../src/server/Daemon.ts";
import Mock from "../../src/providers/Mock.ts";
import type { MockResponse } from "../../src/providers/Mock.ts";
import { openMigrated } from "./_helpers.ts";

const rpcCall = (ws: WebSocket, id: number, method: string, params?: object): Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }> =>
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
        const payload: { jsonrpc: string; id: number; method: string; params?: object } = { jsonrpc: "2.0", id, method };
        if (params !== undefined) payload.params = params;
        ws.send(JSON.stringify(payload));
    });

const subscribe = (ws: WebSocket, method: string): (() => unknown[]) => {
    const captured: unknown[] = [];
    ws.on("message", (data) => {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const parsed = JSON.parse(text) as { method?: string; params?: unknown; id?: unknown };
        if (parsed.id === undefined && parsed.method === method) captured.push(parsed.params);
    });
    return () => captured;
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const connect = (addr: { host: string; port: number }): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });

const parseDsl = (text: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(text);
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
};

const withDaemon = async <T>(provider: Mock | null, fn: (db: DatabaseSync, addr: { host: string; port: number }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    try { return await fn(db, addr); }
    finally { await daemon.stop(); db.close(); }
};

const makeMockResponse = (dsl: string, tokens: number): MockResponse => {
    const ops = parseDsl(dsl);
    return {
        assistant: {
            tokens,
            content: dsl,
            ops,
            reasoning: null,
        },
        assistantRaw: null,
    };
};

test("loop.run with mock provider runs a model turn and persists entries", async () => {
    const dsl = "<<EDIT(known://france/capital):Paris:EDIT\n<<SEND[200]:Paris is the capital.:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 142)] });

    await withDaemon(mock, async (db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "loop-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "what is the capital of france?" });
            const result = response.result as { loopId: number; turnIds: number[]; finalStatus: number; hitMaxTurns: boolean };
            assert.equal(result.finalStatus, 200);
            assert.equal(result.hitMaxTurns, false);
            assert.equal(result.turnIds.length, 1);

            const entries = db.prepare("SELECT pathname FROM entries").all() as Array<{ pathname: string }>;
            assert.equal(entries.length, 1);
            assert.equal(entries[0].pathname, "france/capital");

            const body = (db.prepare("SELECT content FROM entry_channels WHERE name = 'body'").get() as { content: string }).content;
            assert.equal(body, "Paris");
        } finally { ws.close(); }
    });
});

test("loop.run streams log/entry notifications during execution", async () => {
    const dsl = "<<EDIT(known://x):hello:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const logEntries = subscribe(ws, "log/entry");
            await rpcCall(ws, 1, "session.create", { name: "stream-test" });
            await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            await flush();

            const captured = logEntries();
            // 2 ops (EDIT + SEND broadcast) → 2 log/entry notifications
            assert.equal(captured.length, 2);
            const first = captured[0] as { entry: { op: string; origin: string } };
            assert.equal(first.entry.op, "EDIT");
            assert.equal(first.entry.origin, "model");
            const second = captured[1] as { entry: { op: string; status_rx: number } };
            assert.equal(second.entry.op, "SEND");
            assert.equal(second.entry.status_rx, 200);
        } finally { ws.close(); }
    });
});

test("loop.run fires loop/terminated notification on completion", async () => {
    const dsl = "<<EDIT(known://x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const terminated = subscribe(ws, "loop/terminated");
            await rpcCall(ws, 1, "session.create", { name: "term-test" });
            await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            await flush();

            const captured = terminated();
            assert.equal(captured.length, 1);
            const params = captured[0] as { loopId: number; finalStatus: number; hitMaxTurns: boolean };
            assert.equal(params.finalStatus, 200);
            assert.equal(params.hitMaxTurns, false);
        } finally { ws.close(); }
    });
});

test("loop.run without provider returns 501", async () => {
    await withDaemon(null, async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "no-provider" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "anything" });
            const result = response.result as { status: number; error?: string };
            assert.equal(result.status, 501);
        } finally { ws.close(); }
    });
});

test("loop.run requires non-empty prompt", async () => {
    const mock = new Mock({ contextSize: 8192, responses: [] });
    await withDaemon(mock, async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "empty-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /non-empty params\.prompt/);
        } finally { ws.close(); }
    });
});

test("loop.run respects maxTurns cap when model emits non-terminal statuses repeatedly", async () => {
    // Mock emits SEND[102] (continuing) each turn; loop runs until maxTurns
    const dsl = "<<EDIT(known://x):iter:EDIT\n<<SEND[102]:continue:SEND";
    const responses = Array.from({ length: 5 }, () => makeMockResponse(dsl, 10));
    const mock = new Mock({ contextSize: 8192, responses });

    await withDaemon(mock, async (_db, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "maxturns-test" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "iterate", maxTurns: 3 });
            const result = response.result as { finalStatus: number; hitMaxTurns: boolean; turnIds: number[] };
            assert.equal(result.hitMaxTurns, true);
            assert.equal(result.finalStatus, 499);
            assert.equal(result.turnIds.length, 3);
        } finally { ws.close(); }
    });
});

test("discover catalog includes loop.run and loop/terminated", async () => {
    await withDaemon(null, async (_db, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { methods: Record<string, { longRunning?: boolean }>; notifications: Record<string, unknown> };
            assert.ok(cat.methods["loop.run"] !== undefined);
            assert.equal(cat.methods["loop.run"].longRunning, true);
            assert.ok(cat.notifications["loop/terminated"] !== undefined);
        } finally { ws.close(); }
    });
});

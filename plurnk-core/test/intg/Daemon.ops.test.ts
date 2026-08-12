import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

test("op.edit creates an entry via engine.dispatch (origin=client)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ops-test" });
            const response = await rpcCall(ws, 2, "op.edit", {
                target: "worker:///france/capital", content: "Paris", tags: ["france", "geography"],
            });
            assert.equal((response.result as { status: number }).status, 201);

            const entry = await db.test_get_entry_by_pathname_scheme.get<{ scheme: string; pathname: string }>({ pathname: "/france/capital", scheme: "worker" });
            assert.equal(entry?.scheme, "worker");
            assert.equal(entry?.pathname, "/france/capital");
            const body = (await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/france/capital" }))?.content;
            assert.equal(body, "Paris");
            const tags = await db.test_parser_tags.all<{ tag: string }>();
            assert.deepEqual(tags.map((t) => t.tag), ["france", "geography"]);
            const log = await db.test_first_log_entry.get<{ origin: string; op: string }>();
            assert.equal(log?.origin, "client");
            assert.equal(log?.op, "EDIT");
        } finally { ws.close(); }
    });
});

test("{§methods-op-mirror}: op.edit log/entry notification precedes the action response", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "notify-order" });
            // Record inbound messages in arrival order, after the workspace is up — so we capture
            // only the op.edit exchange: the log/entry notification must land before response#2.
            const order: string[] = [];
            ws.on("message", (data) => {
                const m = JSON.parse(typeof data === "string" ? data : (data as Buffer).toString("utf8")) as { method?: string; id?: number };
                order.push(m.method ?? `response#${m.id}`);
            });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///x", content: "hi" });
            const notifyIdx = order.indexOf("log/entry");
            const respIdx = order.indexOf("response#2");
            assert.ok(notifyIdx !== -1, `log/entry should have fired (order: ${order.join(", ")})`);
            assert.ok(respIdx !== -1 && notifyIdx < respIdx, `{§methods-op-mirror}: log/entry must precede the op response (order: ${order.join(", ")})`);
        } finally { ws.close(); }
    });
});

test("op.read fetches an entry's body", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///x", content: "hello" });
            const response = await rpcCall(ws, 3, "op.read", { target: "worker:///x" });
            const result = response.result as { status: number; content: string };
            assert.equal(result.status, 200);
            assert.equal(result.content, "hello");
        } finally { ws.close(); }
    });
});

test("op.read on nonexistent entry returns 404", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "404-test" });
            const response = await rpcCall(ws, 2, "op.read", { target: "worker:///nope" });
            assert.equal((response.result as { status: number }).status, 404);
        } finally { ws.close(); }
    });
});

test("{§op-look}: resolves like READ without writing a log entry", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "look-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///x", content: "secret" });
            const before = (await db.test_log_entries_count_all.get<{ n: number }>())?.n ?? -1;
            const response = await rpcCall(ws, 3, "op.look", { text: "## READ0 (worker:///x)" });
            const result = response.result as { status: number; content: string };
            assert.equal(result.status, 200);
            assert.equal(result.content, "secret");
            const after = (await db.test_log_entries_count_all.get<{ n: number }>())?.n ?? -2;
            assert.equal(after, before, "op.look must write no log_entries row — that's the whole contract");
        } finally { ws.close(); }
    });
});

test("{§op-look}: rejects a non-READ statement", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "look-readonly" });
            const response = await rpcCall(ws, 2, "op.look", { text: "## EDIT0 (worker:///x)\nnope" });
            assert.ok(response.error, "a non-READ LOOK must be rejected");
            assert.match(response.error!.message, /READ only/);
        } finally { ws.close(); }
    });
});

test("op.dispatch accepts a raw PlurnkStatement AST and dispatches it", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "dispatch-test" });
            const statement = {
                op: "EDIT" as const,
                suffix: "",
                signal: null,
                target: {
                    kind: "url" as const, raw: "worker:///hello",
                    scheme: "worker", username: null, password: null,
                    hostname: null, port: null, pathname: "/hello",
                    query: null, fragment: null,
                },
                lineMarker: null,
                body: "world",
                position: { line: 1, column: 1 },
            };
            const response = await rpcCall(ws, 2, "op.dispatch", { statement });
            assert.equal((response.result as { status: number }).status, 201);

            const body = (await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: "/hello" }))?.content;
            assert.equal(body, "world");
        } finally { ws.close(); }
    });
});

test("op.* fires log/entry notification with the entry shape", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "workspace.create", { name: "notif-test" });
            await rpcCall(ws, 2, "op.edit", { target: "worker:///x", content: "test" });
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

test("log/entry notification is scoped to workspace", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aNotifs = subscribeNotifications(wsA, "log/entry");
            const bNotifs = subscribeNotifications(wsB, "log/entry");

            await rpcCall(wsA, 1, "workspace.create", { name: "workspace-A" });
            await rpcCall(wsB, 1, "workspace.create", { name: "workspace-B" });
            await flush();
            aNotifs(); bNotifs();

            await rpcCall(wsA, 2, "op.edit", { target: "worker:///x", content: "from A" });
            await flush();

            assert.equal(aNotifs().length, 1);
            assert.equal(bNotifs().length, 0);
        } finally { wsA.close(); wsB.close(); }
    });
});
test("op.find on empty scope returns 200 with empty results", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "find-test" });
            const response = await rpcCall(ws, 2, "op.find", { scope: "worker:///" });
            const result = response.result as { status: number; results: string[]; content: string };
            assert.equal(result.status, 200);
            assert.deepEqual(result.results, []);
            assert.equal(result.content, "[]", "FIND content is a JSON catalog array — empty here");
        } finally { ws.close(); }
    });
});

test("op.send broadcast with terminal status updates loop status", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspace = await rpcCall(ws, 1, "workspace.create", { name: "send-test" });
            const workspaceId = (workspace.result as { id: number }).id;
            const clientWorker = await db.test_get_client_worker_by_workspace.get<{ id: number }>({ workspace_id: workspaceId });

            // op.send is the first client op — it lazily creates the
            // client loop. After it runs we can look up that loop.
            const response = await rpcCall(ws, 2, "op.send", { status: 200 });
            assert.equal((response.result as { status: number }).status, 200);

            const clientLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: clientWorker?.id });
            const loop = await db.test_get_loop_status.get<{ status: number }>({ id: clientLoop?.id });
            assert.equal(loop?.status, 200);
        } finally { ws.close(); }
    });
});

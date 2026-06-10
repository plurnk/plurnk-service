import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

test("[§13.5-op-mirror] op.edit creates an entry via engine.dispatch (origin=client)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "ops-test" });
            const response = await rpcCall(ws, 2, "op.edit", {
                target: "known://france/capital", content: "Paris", tags: ["france", "geography"],
            });
            assert.equal((response.result as { status: number }).status, 201);

            const entry = await (db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ scheme: string; pathname: string }>({ pathname: "france/capital", scheme: "known" });
            assert.equal(entry?.scheme, "known");
            assert.equal(entry?.pathname, "france/capital");
            const body = (await (db.test_get_body_by_pathname as PrepMethod).get<{ content: string }>({ pathname: "france/capital" }))?.content;
            assert.equal(body, "Paris");
            const tags = await (db.test_parser_tags as PrepMethod).all<{ tag: string }>();
            assert.deepEqual(tags.map((t) => t.tag), ["france", "geography"]);
            const log = await (db.test_first_log_entry as PrepMethod).get<{ origin: string; op: string }>();
            assert.equal(log?.origin, "client");
            assert.equal(log?.op, "EDIT");
        } finally { ws.close(); }
    });
});

test("op.read fetches an entry's body", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "read-test" });
            await rpcCall(ws, 2, "op.edit", { target: "known://x", content: "hello" });
            const response = await rpcCall(ws, 3, "op.read", { target: "known://x" });
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
            await rpcCall(ws, 1, "session.create", { name: "404-test" });
            const response = await rpcCall(ws, 2, "op.read", { target: "known://nope" });
            assert.equal((response.result as { status: number }).status, 404);
        } finally { ws.close(); }
    });
});

test("op.dispatch accepts a raw PlurnkStatement AST and dispatches it", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "dispatch-test" });
            const statement = {
                op: "EDIT" as const,
                suffix: "",
                signal: null,
                target: {
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

            const body = (await (db.test_get_body_by_pathname as PrepMethod).get<{ content: string }>({ pathname: "hello" }))?.content;
            assert.equal(body, "world");
        } finally { ws.close(); }
    });
});

test("op.parse parses multi-statement text and dispatches each", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
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

            const entries = await (db.test_parser_pathnames as PrepMethod).all<{ pathname: string }>();
            assert.deepEqual(entries.map((e) => e.pathname), ["a", "b"]);
        } finally { ws.close(); }
    });
});

test("[§13.6-log-entry-notify] op.* fires log/entry notification with the entry shape", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 1, "session.create", { name: "notif-test" });
            await rpcCall(ws, 2, "op.edit", { target: "known://x", content: "test" });
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

test("log/entry notification is scoped to session", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aNotifs = subscribeNotifications(wsA, "log/entry");
            const bNotifs = subscribeNotifications(wsB, "log/entry");

            await rpcCall(wsA, 1, "session.create", { name: "session-A" });
            await rpcCall(wsB, 1, "session.create", { name: "session-B" });
            await flush();
            aNotifs(); bNotifs();

            await rpcCall(wsA, 2, "op.edit", { target: "known://x", content: "from A" });
            await flush();

            assert.equal(aNotifs().length, 1);
            assert.equal(bNotifs().length, 0);
        } finally { wsA.close(); wsB.close(); }
    });
});

test("[§13.5-auto-envelope] op.* methods require init: Auto-create kicks in", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "op.edit", { target: "known://x", content: "auto" });
            assert.equal((response.result as { status: number }).status, 201);

            const sessions = await (db.test_list_sessions as PrepMethod).all<{ name: string }>();
            assert.equal(sessions.length, 1);
            assert.match(sessions[0].name, /^auto-/);
        } finally { ws.close(); }
    });
});

test("op.find on empty scope returns 200 with empty results", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "find-test" });
            const response = await rpcCall(ws, 2, "op.find", { scope: "known://" });
            const result = response.result as { status: number; results: string[]; content: string };
            assert.equal(result.status, 200);
            assert.deepEqual(result.results, []);
            assert.equal(result.content, "");
        } finally { ws.close(); }
    });
});

test("op.send broadcast with terminal status updates loop status", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const session = await rpcCall(ws, 1, "session.create", { name: "send-test" });
            const sessionId = (session.result as { id: number }).id;
            const run = await (db.test_get_run_by_session as PrepMethod).get<{ id: number }>({ session_id: sessionId });

            // op.send is the first client op — it lazily creates the
            // client loop. After it runs we can look up that loop.
            const response = await rpcCall(ws, 2, "op.send", { status: 200 });
            assert.equal((response.result as { status: number }).status, 200);

            const clientLoop = await (db.test_get_loop_by_run as PrepMethod).get<{ id: number }>({ run_id: run?.id });
            const loop = await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: clientLoop?.id });
            assert.equal(loop?.status, 200);
        } finally { ws.close(); }
    });
});

test("discover catalog includes all op.* methods", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
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

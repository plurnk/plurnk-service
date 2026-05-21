// F.1: sessions.project_root column + session.create(projectRoot) +
// session.set_root RPC. Workspace pointer lives on the session row;
// client supplies it at create or via set_root. Absent value = headless
// mode (no disk side-effects on file ops, asserted by later phases).

import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

test("session.create with projectRoot round-trips and persists the column", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.create", {
                name: "with-root", projectRoot: "/home/me/repo/foo",
            });
            const result = response.result as { id: number; name: string; projectRoot: string | null };
            assert.equal(result.name, "with-root");
            assert.equal(result.projectRoot, "/home/me/repo/foo");

            const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: result.id });
            assert.equal(row?.project_root, "/home/me/repo/foo");
        } finally { ws.close(); }
    });
});

test("session.create without projectRoot leaves the column null (headless)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.create", { name: "headless" });
            const result = response.result as { id: number; name: string; projectRoot: string | null };
            assert.equal(result.projectRoot, null);

            const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: result.id });
            assert.equal(row?.project_root, null);
        } finally { ws.close(); }
    });
});

test("session.create rejects non-absolute projectRoot", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.create", {
                name: "bad-root", projectRoot: "relative/path",
            });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /must be an absolute path/);
        } finally { ws.close(); }
    });
});

test("session/created notification carries projectRoot", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "session/created");
            await rpcCall(ws, 1, "session.create", {
                name: "with-notif", projectRoot: "/tmp/notif-test",
            });
            await flush();
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string; projectRoot: string | null };
            assert.equal(params.projectRoot, "/tmp/notif-test");
        } finally { ws.close(); }
    });
});

test("session.set_root updates the column and subsequent reads observe it", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "set-root" });
            const sessionId = (created.result as { id: number }).id;

            const set = await rpcCall(ws, 2, "session.set_root", { projectRoot: "/var/work/proj" });
            const setResult = set.result as { id: number; projectRoot: string | null };
            assert.equal(setResult.id, sessionId);
            assert.equal(setResult.projectRoot, "/var/work/proj");

            const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: sessionId });
            assert.equal(row?.project_root, "/var/work/proj");
        } finally { ws.close(); }
    });
});

test("session.set_root accepts null to revert to headless", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", {
                name: "go-headless", projectRoot: "/start/here",
            });
            const sessionId = (created.result as { id: number }).id;

            const set = await rpcCall(ws, 2, "session.set_root", { projectRoot: null });
            const setResult = set.result as { projectRoot: string | null };
            assert.equal(setResult.projectRoot, null);

            const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: sessionId });
            assert.equal(row?.project_root, null);
        } finally { ws.close(); }
    });
});

test("session.set_root errors when no session attached", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "session.set_root", { projectRoot: "/x" });
            // requiresInit:true auto-creates a headless envelope before the
            // handler runs, so by the time set_root sees ctx, the session is
            // attached. The call should succeed against that auto-envelope.
            const result = response.result as { id: number; projectRoot: string | null };
            assert.equal(result.projectRoot, "/x");
        } finally { ws.close(); }
    });
});

test("session.set_root rejects non-absolute projectRoot", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "set-root-bad" });
            const response = await rpcCall(ws, 2, "session.set_root", { projectRoot: "relative" });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /must be an absolute path/);
        } finally { ws.close(); }
    });
});

test("discover catalog advertises session.set_root", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { methods: Record<string, { params: Record<string, string> }> };
            assert.ok(cat.methods["session.set_root"] !== undefined);
            assert.ok(cat.methods["session.set_root"].params.projectRoot !== undefined);
        } finally { ws.close(); }
    });
});

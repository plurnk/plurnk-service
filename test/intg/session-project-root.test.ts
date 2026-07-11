// F.1: sessions.project_root column + session.create(projectRoot). The workspace
// pointer lives on the session row and is set at session.create or never —
// headless is forever. Absent value = headless mode (no disk side-effects on
// file ops, asserted by later phases).

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

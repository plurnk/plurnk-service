// Tests for daemon's notice/event notification. SPEC §operation-results client
// surface — every Notice the engine pushes to a loop's buffer
// also broadcasts live, scoped to the loop's workspace.

import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";
test("notifyNotice broadcasts to clients attached to the loop's workspace", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "notices-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "notice/event");

            daemon.notifyNotice(workspaceId, {
                loopId: 42,
                notice: {
                    source: "provider:local",
                    kind: "grammar_unenforced",
                    level: "warn",
                    message: "transported grammar diverged from returned content",
                    position: { type: "content-offset", line: 3, column: 7 },
                },
            });
            await flush();

            const notices = (captured() as Array<{ loopId: number; notice: { source: string; kind: string; message: string } }>)
                .filter((item) => item.loopId === 42);
            assert.equal(notices.length, 1);
            assert.equal(notices[0].loopId, 42);
            assert.equal(notices[0].notice.source, "provider:local");
            assert.equal(notices[0].notice.kind, "grammar_unenforced");
            assert.equal(notices[0].notice.message, "transported grammar diverged from returned content");
        } finally { ws.close(); }
    });
});

test("notice/event is workspace-scoped — other workspaces don't see it", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "workspace.create", { name: "notices-A" });
            const bResp = await rpcCall(wsB, 1, "workspace.create", { name: "notices-B" });
            const workspaceA = (aResp.result as { id: number }).id;
            const workspaceB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "notice/event");
            const bEvents = subscribeNotifications(wsB, "notice/event");

            daemon.notifyNotice(workspaceA, { loopId: 1, notice: { source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response" } });
            daemon.notifyNotice(workspaceB, { loopId: 2, notice: { source: "exec:search", kind: "search_progress", level: "info", completed: 5, total: 10, percent: 50 } });

            await flush();

            const aCaptured = (aEvents() as Array<{ notice: { kind: string } }>).filter((item) => item.notice.kind === "turn_awaiting_model");
            const bCaptured = (bEvents() as Array<{ notice: { kind: string } }>).filter((item) => item.notice.kind === "search_progress");
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].notice.kind, "turn_awaiting_model");
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].notice.kind, "search_progress");
        } finally { wsA.close(); wsB.close(); }
    });
});

// Tests for daemon's telemetry/event notification. SPEC §telemetry client
// surface — every TelemetryEvent the engine pushes to a loop's buffer
// also broadcasts live, scoped to the loop's workspace.

import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";
test("[§notifications-telemetry-event] notifyTelemetryEvent broadcasts to clients attached to the loop's workspace", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceResp = await rpcCall(ws, 1, "workspace.create", { name: "telemetry-test" });
            const workspaceId = (workspaceResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "telemetry/event");

            daemon.notifyTelemetryEvent(workspaceId, {
                loopId: 42,
                event: {
                    source: "grammar",
                    kind: "parse_error",
                    message: "unexpected token",
                    position: { type: "content-offset", line: 3, column: 7 },
                },
            });
            await flush();

            const events = captured() as Array<{ loopId: number; event: { source: string; kind: string; message: string } }>;
            assert.equal(events.length, 1);
            assert.equal(events[0].loopId, 42);
            assert.equal(events[0].event.source, "grammar");
            assert.equal(events[0].event.kind, "parse_error");
            assert.equal(events[0].event.message, "unexpected token");
        } finally { ws.close(); }
    });
});

test("telemetry/event is workspace-scoped — other workspaces don't see it", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "workspace.create", { name: "telemetry-A" });
            const bResp = await rpcCall(wsB, 1, "workspace.create", { name: "telemetry-B" });
            const workspaceA = (aResp.result as { id: number }).id;
            const workspaceB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "telemetry/event");
            const bEvents = subscribeNotifications(wsB, "telemetry/event");

            daemon.notifyTelemetryEvent(workspaceA, { loopId: 1, event: { source: "grammar", kind: "parse_error", message: "unexpected token", position: { type: "content-offset", line: 1, column: 0 } } });
            daemon.notifyTelemetryEvent(workspaceB, { loopId: 2, event: { source: "engine:rail", kind: "max_commands_exceeded", emitted: 50, dropped: 30 } });

            await flush();

            const aCaptured = aEvents() as Array<{ event: { kind: string } }>;
            const bCaptured = bEvents() as Array<{ event: { kind: string } }>;
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].event.kind, "parse_error");
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].event.kind, "max_commands_exceeded");
        } finally { wsA.close(); wsB.close(); }
    });
});

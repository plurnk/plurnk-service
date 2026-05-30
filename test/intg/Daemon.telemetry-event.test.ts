// Tests for daemon's telemetry/event notification. SPEC §15.1 client
// surface — every TelemetryEvent the engine pushes to a loop's buffer
// also broadcasts live, scoped to the loop's session.

import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

test("daemon registers telemetry/event in discover catalog", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const r = await rpcCall(ws, 1, "discover");
            const cat = r.result as { notifications: Record<string, { description?: string }> };
            assert.ok(cat.notifications["telemetry/event"] !== undefined);
        } finally { ws.close(); }
    });
});

test("notifyTelemetryEvent broadcasts to clients attached to the loop's session", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const sessionResp = await rpcCall(ws, 1, "session.create", { name: "telemetry-test" });
            const sessionId = (sessionResp.result as { id: number }).id;
            const captured = subscribeNotifications(ws, "telemetry/event");

            daemon.notifyTelemetryEvent(sessionId, {
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

test("telemetry/event is session-scoped — other sessions don't see it", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const aResp = await rpcCall(wsA, 1, "session.create", { name: "telemetry-A" });
            const bResp = await rpcCall(wsB, 1, "session.create", { name: "telemetry-B" });
            const sessionA = (aResp.result as { id: number }).id;
            const sessionB = (bResp.result as { id: number }).id;

            const aEvents = subscribeNotifications(wsA, "telemetry/event");
            const bEvents = subscribeNotifications(wsB, "telemetry/event");

            daemon.notifyTelemetryEvent(sessionA, { loopId: 1, event: { source: "engine:rail", kind: "strike", streak: 1, maxStrikes: 3, reason: "no_ops" } });
            daemon.notifyTelemetryEvent(sessionB, { loopId: 2, event: { source: "engine:rail", kind: "cycle", period: 2, cycles: 3 } });

            await flush();

            const aCaptured = aEvents() as Array<{ event: { kind: string } }>;
            const bCaptured = bEvents() as Array<{ event: { kind: string } }>;
            assert.equal(aCaptured.length, 1);
            assert.equal(aCaptured[0].event.kind, "strike");
            assert.equal(bCaptured.length, 1);
            assert.equal(bCaptured[0].event.kind, "cycle");
        } finally { wsA.close(); wsB.close(); }
    });
});

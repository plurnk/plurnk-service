// Server-side YOLO wire path (#147). Closes the Phase E.3 deferred TODO:
// `loop.run` accepts `flags?: { yolo?: boolean }`, persists to loops.flags,
// the in-tree yolo.ts listener reads ProposalPendingEvent.flags and auto-
// resolves without any client `loop.resolve` call. The loop/proposal
// notification also carries flags so connected clients can suppress review
// UI for entries that will resolve before any human can react.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

// Minimal scheme that always proposes — same shape as the one in
// Engine.proposal-lifecycle.test.ts. Lets us trigger the lifecycle from a
// full Daemon RPC roundtrip without depending on the File scheme (whose
// File scheme used to require PLURNK_WORKSPACE_ROOT but now reads
// sessions.project_root — out of scope for these YOLO tests anyway).
class ProposingTest {
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
    };
    async edit(): Promise<{ status: number; attrs: object; body: string }> {
        return {
            status: 202,
            body: "--- proposed-test\n+++ proposed-test\n@@ +x @@",
            attrs: { target: "/proposed-test" },
        };
    }
}

test("loop.run with flags.yolo=true persists to loops.flags", async () => {
    const dsl = "<<EDIT(known://x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "yolo-persist" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "test", flags: { yolo: true } });
            const result = response.result as { loopId: number };

            const row = await (db.engine_get_loop_flags as PrepMethod).get<{ flags: string }>({ loop_id: result.loopId });
            assert.ok(row !== undefined);
            const parsed = JSON.parse(row!.flags) as { yolo: boolean };
            assert.equal(parsed.yolo, true);
        } finally { ws.close(); }
    });
});

test("loop.run without flags leaves loops.flags at default ({})", async () => {
    const dsl = "<<EDIT(known://x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "no-flags" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            const result = response.result as { loopId: number };

            const row = await (db.engine_get_loop_flags as PrepMethod).get<{ flags: string }>({ loop_id: result.loopId });
            assert.equal(row?.flags, "{}");
        } finally { ws.close(); }
    });
});

test("[§14.7-server-yolo-auto-accept] loop.run with flags.yolo=true: in-tree yolo listener auto-accepts proposal", async () => {
    // Model emits EDIT against the proposing-test scheme (status=202), then
    // SEND[200]. With server YOLO on, the proposal resolves in-process; the
    // loop completes without any client loop.resolve. Assert: final status
    // is 200 and a proposal/resolved log row exists.
    const dsl = "<<EDIT(proposing-test://x):y:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());

        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "yolo-resolve" });
            const response = await rpcCall(ws, 2, "loop.run", {
                prompt: "trigger proposal", flags: { yolo: true },
            });
            const result = response.result as { loopId: number; finalStatus: number; hitMaxTurns: boolean };
            assert.equal(result.finalStatus, 200, "loop should complete without external resolution");
            assert.equal(result.hitMaxTurns, false);

            // The proposed entry should have transitioned out of 'proposed'.
            const rows = await (db.test_log_entries_by_loop as PrepMethod).all<{
                op: string; status_rx: number; scheme: string;
            }>({ loop_id: result.loopId });
            const edit = rows.find((r) => r.op === "EDIT" && r.scheme === "proposing-test");
            assert.ok(edit !== undefined, "proposing-test EDIT log entry expected");
            // Post-accept the dispatch overwrites status with applyResolution's
            // final status — ProposingTest has no applyResolution so the engine
            // downgrade-on-throw path leaves the entry resolved at 200/4xx.
            // Either is acceptable here; assert it's NOT still 202.
            assert.notEqual(edit!.status_rx, 202, "yolo should have resolved the 202");
        } finally { ws.close(); }
    });
});

test("[§14.7-proposal-carries-flags] loop/proposal notification carries flags.yolo", async () => {
    // Without YOLO active: dispatch pauses awaiting resolution. We capture
    // the broadcast, confirm flags is present and yolo=false, then send
    // loop.resolve to unblock the dispatch so the loop completes cleanly.
    const dsl = "<<EDIT(proposing-test://x):y:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());

        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "session.create", { name: "flags-notif" });

            // Race-safe pattern: kick loop.run, capture the first proposal
            // notification, resolve it, then await loop.run.
            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "trigger" });

            // Poll briefly for the notification (capped at ~1s).
            let captured: unknown[] = [];
            for (let i = 0; i < 20; i++) {
                await flush();
                captured = proposals();
                if (captured.length > 0) break;
            }
            assert.ok(captured.length > 0, "loop/proposal notification expected");
            const params = captured[0] as {
                logEntryId: number; flags?: { yolo?: boolean };
            };
            assert.ok(params.flags !== undefined, "flags must be on loop/proposal payload");
            assert.equal(params.flags!.yolo, false, "yolo defaults to false");

            // Unblock the dispatch.
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: params.logEntryId, decision: "accept" });
            await loopPromise;
        } finally { ws.close(); }
    });
});

test("loop/proposal notification: flags.yolo=true when server YOLO is active", async () => {
    const dsl = "<<EDIT(proposing-test://x):y:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextSize: 8192, responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());

        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "session.create", { name: "flags-yolo-notif" });
            await rpcCall(ws, 2, "loop.run", { prompt: "trigger", flags: { yolo: true } });
            await flush();

            const captured = proposals();
            assert.ok(captured.length > 0, "loop/proposal still broadcasts under server YOLO");
            const params = captured[0] as { flags?: { yolo?: boolean } };
            assert.equal(params.flags?.yolo, true, "notification reflects active server YOLO");
        } finally { ws.close(); }
    });
});

test("loop.run rejects non-boolean flags.yolo", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "bad-yolo" });
            const response = await rpcCall(ws, 2, "loop.run", {
                prompt: "test", flags: { yolo: "not-a-boolean" },
            });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /flags\.yolo must be a boolean/);
        } finally { ws.close(); }
    });
});

test("loop.run rejects non-object flags", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "bad-flags" });
            const response = await rpcCall(ws, 2, "loop.run", {
                prompt: "test", flags: "yolo",
            });
            assert.equal(response.error?.code, -32603);
            assert.match(response.error?.message ?? "", /flags must be an object/);
        } finally { ws.close(); }
    });
});

test("discover catalog advertises loop.run.flags param", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { methods: Record<string, { params: Record<string, string> }> };
            assert.ok(cat.methods["loop.run"].params.flags !== undefined);
            assert.match(cat.methods["loop.run"].params.flags, /yolo/);
        } finally { ws.close(); }
    });
});

test("discover catalog advertises loop/proposal.flags param", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "discover");
            const cat = response.result as { notifications: Record<string, { params: Record<string, string> }> };
            assert.ok(cat.notifications["loop/proposal"].params.flags !== undefined);
        } finally { ws.close(); }
    });
});

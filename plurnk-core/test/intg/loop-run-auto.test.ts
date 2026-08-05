// Server-side auto wire path (#147). Closes the Phase E.3 deferred TODO:
// `loop.run` accepts `flags?: { auto?: boolean }`, persists to loops.flags,
// and core's proposal disposition resolves without any client `loop.resolve`
// call. The loop/proposal notification carries that same disposition.

import test from "node:test";
import { viableWindow } from "./_helpers.ts";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { EditStatement } from "@plurnk/plurnk-contracts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { rpcCall, rpcProblem, subscribeNotifications, flush, connect, withDaemon, makeMockResponse, runLoopToTerminal, waitFor } from "./_rpc.ts";

// Minimal scheme that always proposes — same shape as the one in
// Engine.proposal-lifecycle.test.ts. Lets us trigger the lifecycle from a
// full Daemon RPC roundtrip without depending on the File scheme (whose
// File scheme used to require PLURNK_WORKSPACE_ROOT but now reads
// workspaces.project_root — out of scope for these auto tests anyway).
class ProposingTest {
    readonly batches: number[] = [];
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
    };
    async editBatch(statements: readonly EditStatement[]): Promise<{ status: number; attrs: object; body: string }> {
        this.batches.push(statements.length);
        return {
            status: 202,
            body: "--- proposed-test\n+++ proposed-test\n@@ +x @@",
            attrs: { target: "/proposed-test" },
        };
    }
}

test("{§edit-batch}: one proposal resolution governs every same-resource EDIT row", async () => {
    const dsl = "<<EDIT(proposing-test://x)<1>:one:EDIT\n<<EDIT(proposing-test://x)<3>:three:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (db, daemon, addr) => {
        const scheme = new ProposingTest();
        daemon.schemes.register("proposing-test", scheme);
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "one-resource-proposal" });
            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "batch" });
            const pending = await waitFor(
                () => proposals() as Array<{ logEntryId: number }>,
                (items) => items.length === 1,
            );
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "accept" });
            const run = await loopPromise;
            const loopId = (run.result as { loopId: number }).loopId;
            await flush();
            assert.deepEqual(scheme.batches, [2], "the scheme receives one resource batch");
            assert.equal(proposals().length, 1, "the client reviews the resource once");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string; status_rx: number }>({ loop_id: loopId });
            const edits = rows.filter((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.equal(edits.length, 2);
            assert.ok(edits.every((row) => row.status_rx === 200), "one acceptance settles every statement row");
        } finally { ws.close(); }
    });
});

test("loop.run with flags.auto=true persists to loops.flags", async () => {
    const dsl = "<<EDIT(worker:///x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "auto-persist" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "test", flags: { auto: true } });
            const result = response.result as { loopId: number };

            const row = await db.engine_get_loop_flags.get<{ flags: string }>({ loop_id: result.loopId });
            assert.ok(row !== undefined);
            const parsed = JSON.parse(row!.flags) as { auto: boolean };
            assert.equal(parsed.auto, true);
        } finally { ws.close(); }
    });
});

test("loop.run without flags leaves loops.flags at default ({})", async () => {
    const dsl = "<<EDIT(worker:///x):body:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "no-flags" });
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "test" });
            const result = response.result as { loopId: number };

            const row = await db.engine_get_loop_flags.get<{ flags: string }>({ loop_id: result.loopId });
            assert.equal(row?.flags, "{}");
        } finally { ws.close(); }
    });
});

test("loop.run with flags.auto=true: core-owned disposition resolves proposal", async () => {
    // Model emits EDIT against the proposing-test scheme (status=202), then
    // SEND[200]. With loop auto on, the proposal resolves in-process; the
    // loop completes without any client loop.resolve. Assert: final status
    // is 200 and a proposal/resolved log row exists.
    const dsl = "<<EDIT(proposing-test://x):y:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());

        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "auto-resolve" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal", flags: { auto: true },
            });
            assert.equal(result.result.status, 200, "loop completes without external resolution (not maxed — that'd be 429)");

            // The proposed entry should have transitioned out of 'proposed'.
            const rows = await db.test_log_entries_by_loop.all<{
                op: string; status_rx: number; scheme: string;
            }>({ loop_id: result.loopId });
            const edit = rows.find((r) => r.op === "EDIT" && r.scheme === "proposing-test");
            assert.ok(edit !== undefined, "proposing-test EDIT log entry expected");
            // Post-accept the dispatch overwrites status with applyResolution's
            // final status — ProposingTest has no applyResolution so the engine
            // downgrade-on-throw path leaves the entry resolved at 200/4xx.
            // Either is acceptable here; assert it's NOT still 202.
            assert.notEqual(edit!.status_rx, 202, "auto should have resolved the 202");
        } finally { ws.close(); }
    });
});

test("loop/proposal notification carries client disposition and effective flags", async () => {
    // Without auto active: dispatch pauses awaiting resolution. We capture
    // the broadcast, confirm flags is present and auto=false, then send
    // loop.resolve to unblock the dispatch so the loop completes cleanly.
    const dsl = "<<EDIT(proposing-test://x):y:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());

        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "flags-notif" });

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
                logEntryId: number;
                workerId?: number;
                flags?: { auto?: boolean };
                disposition?: unknown;
            };
            assert.equal(typeof params.workerId, "number", "proposal identifies its owning worker for client routing");
            assert.ok(params.flags !== undefined, "flags must be on loop/proposal payload");
            assert.equal(params.flags!.auto, false, "auto defaults to false");
            assert.deepEqual(params.disposition, { owner: "client" });

            // Unblock the dispatch.
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: params.logEntryId, decision: "accept" });
            await loopPromise;
        } finally { ws.close(); }
    });
});

test("loop/proposal notification carries loop-accept disposition when auto is active", async () => {
    const dsl = "<<EDIT(proposing-test://x):y:EDIT\n<<SEND[200]:done:SEND";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });

    await withDaemon(mock, async (_db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());

        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "flags-auto-notif" });
            await runLoopToTerminal(ws, 2, { prompt: "trigger", flags: { auto: true } });
            // loop.run returns immediately now; wait for the proposal to broadcast async.
            const captured = await waitFor(
                () => proposals() as Array<{ flags?: { auto?: boolean }; disposition?: unknown }>,
                (p) => p.length > 0,
            );
            assert.ok(captured.length > 0, "loop/proposal still broadcasts under loop auto");
            const params = captured[0] as { flags?: { auto?: boolean }; disposition?: unknown };
            assert.equal(params.flags?.auto, true, "notification reflects active loop auto");
            assert.deepEqual(params.disposition, { owner: "loop", decision: "accept" });
        } finally { ws.close(); }
    });
});

test("loop.run rejects non-boolean flags.auto", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "bad-auto" });
            const response = await rpcCall(ws, 2, "loop.run", {
                prompt: "test", flags: { auto: "not-a-boolean" },
            });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/input/loop-flag-invalid");
            assert.equal(problem.field, "flags.auto");
            assert.equal(problem.retryable, false);
        } finally { ws.close(); }
    });
});

test("loop.run rejects unknown flags rather than silently ignoring policy", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "unknown-flag" });
            const response = await rpcCall(ws, 2, "loop.run", {
                prompt: "test", flags: { automatic: true },
            });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/input/loop-flag-not-supported");
            assert.equal(problem.field, "flags.automatic");
            assert.deepEqual(problem.allowedFlags, ["auto", "noProposals", "noWeb", "noInteraction", "mode"]);
        } finally { ws.close(); }
    });
});

test("loop.run rejects non-object flags", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "bad-flags" });
            const response = await rpcCall(ws, 2, "loop.run", {
                prompt: "test", flags: "auto",
            });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.dev/daemon/input/loop-flags-invalid");
            assert.equal(problem.field, "flags");
        } finally { ws.close(); }
    });
});

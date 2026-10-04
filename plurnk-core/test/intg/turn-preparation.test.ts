import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { LOOP_TIMEOUT_REASON } from "../../src/core/TurnRunner.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_db.ts";

for (const mode of ["cancel", "cancel-wrapped", "cancel-context", "deadline", "deadline-wrapped", "internal", "internal-after-cancel", "foreign-abort-after-cancel", "aggregate-after-cancel"] as const) {
    test(`{§turn-exception-outcome}: ${mode} during preparation retains its cause and performs no inference`, async (t) => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `preparation-${mode}`);
            const workerId = await insertWorker(db, workspaceId, null, "subject");
            const loopId = await insertLoop(db, workerId, 1, "prepare");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const controller = new AbortController();
            const deadline = mode.startsWith("deadline");
            const cancelled = deadline || mode.startsWith("cancel");
            const reason = deadline ? LOOP_TIMEOUT_REASON : new Error("owner cancelled preparation");
            let thrown: unknown;
            // {§context-fit} — initialization measures its own rows through the same builder; the failure under
            // test belongs to the inference turn's preparation, after initialization completed.
            const build = PacketBuilder.prototype.buildRequestPacket;
            t.mock.method(PacketBuilder.prototype, "buildRequestPacket", async function (this: PacketBuilder, args: Parameters<PacketBuilder["buildRequestPacket"]>[0]) {
                if (args.currentTurnSeq === 1) return build.call(this, args);
                if (mode !== "internal") controller.abort(reason);
                if (mode.endsWith("wrapped") || mode === "cancel-context") {
                    try {
                        await delay(1, undefined, { signal: controller.signal });
                    } catch (cause) {
                        thrown = mode === "cancel-context" ? new Error("preparation dependency failed", { cause }) : cause;
                        throw thrown;
                    }
                }
                thrown = cancelled ? reason : new Error("packet construction failed");
                if (mode === "foreign-abort-after-cancel") thrown = new DOMException("unrelated abort", "AbortError");
                if (mode === "aggregate-after-cancel") thrown = new AggregateError([reason, thrown], "preparation and cleanup failed", { cause: reason });
                throw thrown;
            });
            const provider = new Mock({ contextWindow: 100_000, responses: [] });
            const running = engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], signal: controller.signal });
            if (deadline) {
                const result = await running;
                assert.equal(result.result.status, 504);
                assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/loop-timeout");
            } else {
                await assert.rejects(running, (cause) => cause === thrown, "the original preparation cause remains intact");
            }
            const turns = await db.test_list_turns_in_loop.all<{
                status: number; completed_at: string | null; packet: string | null;
            }>({ loop_id: loopId });
            assert.deepEqual(turns.map(({ status }) => status), [200, deadline ? 504 : cancelled ? 499 : 500], "completed initialization is unchanged; only the open inference turn is settled");
            assert.ok(turns.every(({ completed_at }) => completed_at !== null));
            assert.equal(turns.at(-1)?.packet, null, "failed preparation does not fabricate a request packet");
            assert.equal(provider.received.length, 0);
            assert.deepEqual(await db.test_inference_calls_by_workspace.all({ workspace_id: workspaceId }), [], "preparation failure is not a provider call");
            assert.deepEqual(await db.test_error_rows_for_worker.all({ worker_id: workerId }), [], "no provider problem is fabricated");
        } finally { await db.close(); }
    });
}

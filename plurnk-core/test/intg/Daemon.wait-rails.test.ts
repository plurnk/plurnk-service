import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import Daemon from "../../src/server/Daemon.ts";
import { withDaemon } from "./_rpc.ts";

const invalidFind = "### FIND0 (worker:///x)\n$fC";
const response = (dsl: string) => ({
    assistant: { content: `## PLAN0\n[]\n${dsl}`, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const wake of ["timer", "message", "same-drain", "restart"] as const) {
    for (const last of ["NEXT", "WAIT"] as const) {
        test(`{§engine-rails}: ${wake} wake preserves consecutive strikes through ${last}`, async (t) => {
            const provider = new Mock({ contextWindow: 100000, responses: [
                response(`${invalidFind}\n### SEND0 (WAIT) <1,0>`),
                response(`${invalidFind}\n### SEND0 (WAIT) <1,0>`),
                response(`${invalidFind}\n### SEND0 (${last})${last === "WAIT" ? " <1,0>" : ""}`),
                response("### SEND0 (TERM)\nMust not reach a fourth model call."),
            ] });
            const seen: Array<number | undefined> = [];
            const generate = provider.generate.bind(provider);
            t.mock.method(provider, "generate", (args: Parameters<Mock["generate"]>[0]) => {
                seen.push(args.strikes);
                return generate(args);
            });
            await withDaemon(provider, async (db, daemon) => {
                let activeDaemon = daemon;
                const { workspaceId } = await daemon.createWorkspace({ name: `wait-strikes-${wake}` });
                const workerId = await daemon.ensureModelWorker(workspaceId);
                const parks = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
                const finished = Promise.withResolvers<number>();
                const schedule = DrainSupervisor.prototype.scheduleWakes;
                const park = LoopLifecycle.prototype.park;
                const finish = LoopLifecycle.prototype.finish;
                let loopId: number | undefined;
                t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
                    await schedule.apply(this, args);
                    if (args[1] === workerId) parks[seen.length - 1]?.resolve();
                });
                if (wake === "same-drain") {
                    t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, ...args: Parameters<typeof park>) {
                        const result = await park.apply(this, args);
                        if (result && args[0] === loopId) assert.equal(await this.wake(args[0]), true);
                        return result;
                    });
                }
                t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
                    const result = await finish.apply(this, args);
                    if (args[0] === loopId && result !== null) finished.resolve(result.status);
                    return result;
                });
                t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
                t.mock.method(performance, "now", () => Date.now());
                try {
                    loopId = (await daemon.runLoop({ workspaceId, workerId, prompt: "Perform valid operations after each wait." })).loopId;
                    if (wake !== "same-drain") {
                        for (const parked of parks) {
                            await parked.promise;
                            assert.equal(await new LoopLifecycle(db).status(loopId), 202);
                            if (wake === "restart") {
                                await activeDaemon.stop();
                                activeDaemon = new Daemon({ db, provider });
                                await activeDaemon.start();
                                assert.equal(await new LoopLifecycle(db).status(loopId), 202);
                            }
                            if (wake === "message") {
                                assert.equal((await activeDaemon.runLoop({ workspaceId, workerId, prompt: "Continue." })).loopId, loopId);
                            } else {
                                t.mock.timers.tick(60_000);
                            }
                        }
                    }
                    assert.equal(await finished.promise, 500, "the third consecutive hard failure ends this same task");
                    assert.deepEqual(seen, [0, 1, 2], "provider metadata retains the streak without exposing it in the packet");
                    const result = await new LoopLifecycle(db).result(loopId);
                    assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
                    const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId });
                    assert.equal(rows.filter(({ op, status_rx }) => op === "error" && status_rx === 400).length, 3,
                        "each strike corresponds to its preserved concrete failure");
                } finally {
                    await activeDaemon.cancelWorker({ workspaceId, workerId });
                    t.mock.timers.reset();
                    if (activeDaemon !== daemon) await activeDaemon.stop();
                }
            });
        });
    }
}

test("{§engine-cycle-evidence}: actual parks end repetition windows even when wakes stay in one drain", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        ...Array.from({ length: 6 }, () => response("### READ0 (worker:///missing)\n### SEND0 (WAIT) <1,0>")),
        response("### SEND0 (TERM)\nObservation complete."),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "wait-cycle-windows" });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const finished = Promise.withResolvers<number>();
        const park = LoopLifecycle.prototype.park;
        const finish = LoopLifecycle.prototype.finish;
        let loopId: number | undefined;
        let parks = 0;
        t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, ...args: Parameters<typeof park>) {
            const result = await park.apply(this, args);
            if (result && args[0] === loopId) {
                parks++;
                assert.equal(await this.wake(args[0]), true);
            }
            return result;
        });
        t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
            const result = await finish.apply(this, args);
            if (args[0] === loopId && result !== null) finished.resolve(result.status);
            return result;
        });
        try {
            loopId = (await daemon.runLoop({ workspaceId, workerId, prompt: "Check periodically, then conclude.", maxTurns: 10 })).loopId;
            assert.equal(await finished.promise, 200, "unchanged observations separated by real waits are not a spin cycle");
            assert.equal(parks, 6);
            assert.equal(provider.received.length, 7);
            const reads = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId }))
                .filter(({ op }) => op === "READ");
            assert.equal(reads.filter(({ status_rx }) => status_rx === 404).length, 6);
        } finally { await daemon.cancelWorker({ workspaceId, workerId }); }
    });
});

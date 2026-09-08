import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import Daemon from "../../src/server/Daemon.ts";
import { makeMockResponse, withDaemon } from "./_rpc.ts";

for (const wake of ["timer", "message", "same-drain", "restart"] as const) {
    test(`{§loop-execution-allowance}: ${wake} wake retains the task's remaining execution allowance`, async (t) => {
        const previous = process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
        process.env.PLURNK_SERVICE_LOOP_TIMEOUT = "60000";
        t.after(() => {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT;
            else process.env.PLURNK_SERVICE_LOOP_TIMEOUT = previous;
        });
        const provider = new Mock({ contextWindow: 65536, responses: [
            makeMockResponse("```WAIT <1,0>\nResume the same task later.\n```"),
        ] });
        await withDaemon(provider, async (db, daemon) => {
            let activeDaemon = daemon;
            const { workspaceId } = await daemon.createWorkspace({ name: `execution-${wake}` });
            const workerId = await daemon.ensureModelWorker(workspaceId);
            const parked = Promise.withResolvers<void>();
            const resumed = Promise.withResolvers<AbortSignal>();
            const completed = Promise.withResolvers<number>();
            const schedule = DrainSupervisor.prototype.scheduleWakes;
            const park = LoopLifecycle.prototype.park;
            const finish = LoopLifecycle.prototype.finish;
            let loopId: number | undefined;
            t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
                await schedule.apply(this, args);
                if (args[1] === workerId) parked.resolve();
            });
            if (wake === "same-drain") {
                t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, ...args: Parameters<typeof park>) {
                    const result = await park.apply(this, args);
                    if (result && args[0] === loopId) {
                        assert.equal(await this.wake(args[0]), true, "the wake crosses the current driver's park boundary");
                    }
                    return result;
                });
            }
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
                const result = await finish.apply(this, args);
                if (args[0] === loopId && result !== null) completed.resolve(result.status);
                return result;
            });
            const generate = provider.generate.bind(provider);
            let calls = 0;
            t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
                if (calls++ === 0) {
                    t.mock.timers.tick(40_000);
                    return generate(args);
                }
                const signal = args.signal;
                assert.ok(signal !== undefined, "the provider receives the execution cancellation scope");
                signal.throwIfAborted();
                resumed.resolve(signal);
                return await new Promise<never>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
            t.mock.method(performance, "now", () => Date.now());
            try {
                loopId = (await daemon.runLoop({ workspaceId, workerId, prompt: "Wait and finish this assignment." })).loopId;
                if (wake !== "same-drain") {
                    await parked.promise;
                    if (wake === "restart") {
                        await daemon.stop();
                        activeDaemon = new Daemon({ db, provider });
                        await activeDaemon.start();
                        assert.equal(await new LoopLifecycle(db).status(loopId), 202, "boot retains the future wait");
                    }
                    t.mock.timers.tick(wake === "message" ? 30_000 : 60_000);
                    if (wake === "message") {
                        const delivered = await daemon.runLoop({ workspaceId, workerId, prompt: "Continue now." });
                        assert.equal(delivered.loopId, loopId);
                    }
                }
                const signal = await resumed.promise;
                t.mock.timers.tick(19_999);
                assert.equal(signal.aborted, false);
                t.mock.timers.tick(1);
                assert.equal(signal.aborted, true, "one shared lifecycle owner retained the pre-WAIT execution time");
                assert.equal(await completed.promise, 504);
                assert.equal((await new LoopLifecycle(db).result(loopId))?.problem?.type,
                    "https://problems.plurnk.xyz/engine/rails/loop-timeout");
            } finally {
                await activeDaemon.cancelWorker({ workspaceId, workerId });
                t.mock.timers.reset();
                if (activeDaemon !== daemon) await activeDaemon.stop();
            }
        });
    });
}

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { Module, type SchedulerTimers } from "@plurnk/plurnk-schedule";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated } from "./_helpers.ts";
import { waitForDb } from "./_rpc.ts";

const INITIAL = Date.UTC(2026, 8, 17, 12, 0, 0, 250);

// {§schedule-delivery} — a composed daemon with one hourly rule targeting the recipient worker; the
// scheduler's timers are the test's, so an occurrence fires when the test says so.
test("{§schedule-delivery}: an occurrence runs its own loop; no WAIT holds a loop for it", { timeout: 30_000 }, async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: [
        "````SEND\nDone for now; the reminder will start its own loop.\n````",
        "````SEND\nReceived scheduled-proof.\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const timerApi: SchedulerTimers = {
        set: (callback, delay) => { const id = ++serial; timers.set(id, { callback, due: now + delay }); return id; },
        clear: (id) => { timers.delete(id as number); },
    };
    const module = Module.init({ env: { TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "[]" }, clock: () => now, timers: timerApi });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(module);
    await daemon.start();
    try {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-occurrence", projectRoot: null });
        const { workerId, workerName } = await daemon.createConversationWorker({ workspaceId, name: "recipient" });
        const added = await daemon.invokeModuleAction("workspace.schedule.add", {
            alias: "reminder", definition: { rule: "FREQ=HOURLY;COUNT=2", target: `worker://${workerName}`, prompt: "scheduled-proof" },
        }, { scope: "workspace", workspaceId }) as { status: number };
        assert.equal(added.status, 201);

        const lifecycle = new LoopLifecycle(db);
        const first = await daemon.runLoop({ workspaceId, workerId, prompt: "Reply now; the reminder is scheduled." });
        await waitForDb(() => lifecycle.status(first.loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(first.loopId), 200, "a loop with nothing live concludes; the schedule holds nothing");
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"], "the rule stays armed on its own");

        const next = [...timers.entries()].toSorted((a, b) => a[1].due - b[1].due)[0];
        assert.ok(next, "the scheduler has an armed occurrence");
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();

        await waitForDb(async () => provider.received.length, (calls) => calls >= 2);
        assert.match(JSON.stringify(provider.received[1]), /scheduled-proof/u, "the occurrence arrives as a message and runs a loop");
        const loops = await daemon.listWorkerLoops({ workspaceId, workerId });
        await waitForDb(async () => (await daemon.listWorkerLoops({ workspaceId, workerId })).filter(({ status }) => status === 200).length, (done) => done === 2);
        assert.equal(loops.length, 2, "the occurrence started a second loop on the same worker");
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"], "the next recurrence armed from the delivery");
    } finally { await daemon.stop(); await db.close(); }
});

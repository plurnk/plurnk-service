import { serverProposals } from "./_approval.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { Module, type SchedulerTimers } from "@plurnk/plurnk-schedule";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { holdChild, insertWorkspace, openMigrated } from "./_db.ts";
import { waitForDb } from "./_rpc.ts";

const INITIAL = Date.UTC(2026, 8, 17, 12, 0, 0, 250);

test("{§functionality-state} schedule startup rejects malformed persisted enabledness before arming", async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "invalid-schedule-state");
    await db.workspace_module_state_put.run({
        workspace_id: workspaceId,
        namespace_owner: "@plurnk/plurnk-schedule",
        state: JSON.stringify({ version: 1, definitions: { beat: {
            origin: "workspace", enabled: "false",
            definition: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY;COUNT=2", target: "worker://recipient", prompt: "Must not fire." },
        } } }),
    });
    const timers: SchedulerTimers = { set: () => assert.fail("malformed state must not arm a timer"), clear: () => {} };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => INITIAL, timers });
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await assert.rejects(daemon.start(), {
        name: "Error", message: "Functionality state for schedule alias 'beat' is malformed.",
    });
});

test("{§schedule-residency} restart arms the coordinator's complete definitions and per-workspace enabledness", async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const baseline = {
        rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY",
        target: "worker://recipient", prompt: "Baseline.",
    };
    const replacement = { rule: `${baseline.rule};COUNT=2`, target: "worker://alternate", prompt: "Workspace override." };
    const instances: Daemon[] = [];
    const start = async () => {
        const module = Module.init({
            env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1", PLURNK_SCHEDULE_beat: JSON.stringify(baseline) },
            clock: () => INITIAL, timers: { set: () => Symbol("occurrence"), clear: () => {} },
        });
        const daemon = new Daemon({ db, provider: null });
        instances.push(daemon);
        daemon.registerModule(module, "@plurnk/plurnk-schedule");
        await daemon.start();
        return { daemon, module };
    };
    t.after(async () => { for (const daemon of instances) await daemon.stop(); await db.close(); });
    const first = await start();
    const alice = await insertWorkspace(db, "schedule-alice");
    const bob = await insertWorkspace(db, "schedule-bob");
    const charlie = await insertWorkspace(db, "schedule-charlie");
    const invoke = (workspaceId: number, verb: string, params = {}) => first.daemon.invokeModuleAction(
        `workspace.schedule.${verb}`, params, { scope: "workspace", workspaceId },
    );
    await invoke(alice, "add", { alias: "beat", definition: replacement });
    await invoke(alice, "add", { alias: "muted", definition: replacement });
    await invoke(alice, "disable", { alias: "muted" });
    await invoke(bob, "disable", { alias: "beat" });
    await invoke(bob, "add", { alias: "private", definition: replacement });
    await first.daemon.stop();

    const restored = await start();
    for (const [workspaceId, aliases] of [[alice, ["beat"]], [bob, ["private"]], [charlie, ["beat"]]] as const) {
        const listing = await restored.daemon.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
        assert.deepEqual(listing.definitions.filter(({ state }) => state !== "disabled").map(({ alias }) => alias), aliases);
        assert.deepEqual(restored.module.functionality.scheduler.armed(workspaceId), aliases,
            "restart and passive inspection must agree without demanding workspace residency");
        assert.ok(listing.definitions.every(({ state }) => state === "disabled" || state === "dormant"),
            "arming a durable obligation does not prepare the workspace's capabilities");
        assert.deepEqual(listing.definitions.find(({ alias }) => alias === "beat")?.definition,
            workspaceId === alice ? replacement : baseline, "the local rule does not inherit baseline policy or message fields");
    }
});

// {§schedule-delivery} — a composed daemon with one hourly rule targeting the recipient worker; the
// scheduler's timers are the test's, so an occurrence fires when the test says so.
test("{§schedule-delivery}: an occurrence after conclusion starts a successor loop", { timeout: 30_000 }, async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: [
        "````SEND [200]\nDone for now; the reminder will start its own loop.\n````",
        "````SEND [200]\nReceived scheduled-proof.\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const timerApi: SchedulerTimers = {
        set: (callback, delay) => { const id = ++serial; timers.set(id, { callback, due: now + delay }); return id; },
        clear: (id) => { timers.delete(id as number); },
    };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now, timers: timerApi });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
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

test("{§schedule-delivery} {§loop-wake-identity}: an occurrence wakes a genuinely parked loop and arrives there exactly once", { timeout: 30_000 }, async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: [
        { assistant: { content: "```WAIT [600]\nWaiting for the child.\n```", reasoning: null } },
        { assistant: { content: "```NOTE\nReceived the scheduled message.\n```\n\n```WAIT [600]\nThe child is still running.\n```", reasoning: null } },
    ] });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const module = Module.init({
        env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now,
        timers: {
            set: (callback, delay) => { const id = ++serial; timers.set(id, { callback, due: now + delay }); return id; },
            clear: (id) => { timers.delete(id as number); },
        },
    });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-parked-arrival", projectRoot: null });
        const { workerId, workerName } = await daemon.createConversationWorker({ workspaceId, name: "recipient" });
        await holdChild(db, workspaceId, workerId);
        const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "Wait for the child." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        assert.equal(provider.received.length, 1, "a real parked loop, not a WAIT receipt that merely says continue");

        const added = await daemon.invokeModuleAction("workspace.schedule.add", {
            alias: "reminder", definition: { rule: "FREQ=HOURLY;COUNT=1", target: `worker://${workerName}`, prompt: "scheduled-proof" },
        }, { scope: "workspace", workspaceId }) as { status: number };
        assert.equal(added.status, 201);
        const occurrence = [...timers.entries()].toSorted((a, b) => a[1].due - b[1].due)[0];
        assert.ok(occurrence, "one occurrence is armed");
        now = occurrence[1].due;
        timers.delete(occurrence[0]);
        occurrence[1].callback();

        await waitForDb(() => db.test_log_entries_by_loop.all<{ op: string; tx: string }>({ loop_id: accepted.loopId }),
            (rows) => rows.some(({ op, tx }) => op === "NOTE" && tx.includes("Received the scheduled message.")));
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        await waitForDb(async () => module.functionality.scheduler.armed(workspaceId), (aliases) => aliases.length === 0);
        assert.equal(provider.received.length, 2, "the occurrence wakes the loop without waiting for its ten-minute deadline");
        assert.match(JSON.stringify(provider.received[1]), /scheduled-proof/u, "the resumed model sees the message");
        assert.deepEqual((await daemon.listWorkerLoops({ workspaceId, workerId })).map(({ id }) => id), [accepted.loopId],
            "the scheduler joins the existing loop rather than starting a successor");
        const arrivals = (await db.test_messages_by_loop.all<{ source: string; body: string; log_entry_id: number | null }>({ loop_id: accepted.loopId }))
            .filter(({ source }) => source === "schedule://reminder");
        assert.deepEqual(arrivals.map(({ body }) => body), ["scheduled-proof"]);
        assert.ok(arrivals[0]!.log_entry_id !== null, "the arrival has a published ordinary log receipt");
        const listing = await daemon.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
        const reminder = listing.definitions.find(({ alias }) => alias === "reminder");
        assert.ok(reminder !== undefined && reminder.state !== "unavailable", "exhaustion follows a successful delivery");
        await daemon.cancelWorker({ workspaceId, workerId });
    } finally { await daemon.stop(); await db.close(); }
});

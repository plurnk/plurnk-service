import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler, parseRule, type DeliveryPort, type ScheduledRule, type SchedulerTimers } from "@plurnk/plurnk-schedule";
import AwaitedEvents from "../../src/core/AwaitedEvents.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { waitForDb } from "./_rpc.ts";

const INITIAL = Date.UTC(2026, 8, 17, 12, 0, 0, 250);
const DUE = Date.UTC(2026, 8, 17, 12, 0, 1);
const rule: ScheduledRule = {
    alias: "reminder",
    definition: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY;COUNT=2", target: "worker://recipient", prompt: "Reminder." },
    parsed: parseRule("DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY;COUNT=2"),
};

const fixture = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "scheduled-recovery");
    const workerId = await insertWorker(db, workspaceId, null, "recipient");
    const loopId = await insertLoop(db, workerId, 1);
    const events = new AwaitedEvents(db);
    const caps = events.operation("schedule", { workspaceId, workerId, loopId });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, () => void>();
    const timerApi: SchedulerTimers = {
        set: (callback) => { const id = ++serial; timers.set(id, callback); return id; },
        clear: (id) => { timers.delete(id as number); },
    };
    const port: DeliveryPort = {
        listWorkers: async () => [{ id: workerId, name: "recipient" }],
        runLoop: async () => ({ status: 200 }),
    };
    const reports: unknown[] = [];
    const schedulers: Scheduler[] = [];
    const create = () => {
        const scheduler = new Scheduler({ clock: () => now, timers: timerApi, report: (_message, cause) => { reports.push(cause); } });
        scheduler.attach(events.producer("schedule"));
        scheduler.start(port);
        schedulers.push(scheduler);
        return scheduler;
    };
    return {
        db, workspaceId, workerId, loopId, caps, events, port, reports, create,
        rules: new Map([[rule.alias, rule]]),
        advance: (time: number) => { now = time; },
        fire: () => {
            const timer = timers.entries().next().value;
            assert.ok(timer, "an occurrence is armed");
            now = DUE;
            timers.delete(timer[0]);
            timer[1]();
            return timer[1];
        },
        close: async () => { try { for (const scheduler of schedulers) await scheduler.close(); } finally { await db.close(); } },
    };
};

for (const restoration of ["future", "overdue", "disabled", "replaced"] as const) {
    test(`{§schedule-await}: restart ${restoration} reconciles the exact occurrence without replay or retargeting`, async () => {
        const f = await fixture();
        try {
            const first = f.create();
            await first.sync(f.workspaceId, f.rules);
            const joined = await first.wait(f.workspaceId, "reminder", f.caps);
            assert.equal(joined.status, 200);
            assert.ok(typeof joined.resource === "string");
            const path = new URL(joined.resource!).pathname;
            const before = await f.caps.read(path);
            await new LoopLifecycle(f.db).park(f.loopId);
            await first.close();
            if (restoration === "overdue") f.advance(DUE + 1);
            const second = f.create();
            const rules = restoration === "disabled" ? new Map<string, ScheduledRule>()
                : restoration === "replaced" ? new Map([[rule.alias, { ...rule, definition: { ...rule.definition, prompt: "Changed message." } }]])
                    : f.rules;
            await second.sync(f.workspaceId, rules);
            await second.reconcile();
            const after = await f.caps.read(path);
            assert.equal(after!.event, before!.event, "the attachment keeps its original identity");
            if (restoration === "future") {
                assert.equal(after!.result, null);
                f.fire();
                await waitForDb(() => f.caps.read(path), (record) => record!.result !== null);
                assert.equal((await f.caps.read(path))!.result!.status, 200);
            } else {
                assert.equal(after!.result!.status, restoration === "overdue" ? 504 : 410);
                assert.match(after!.result!.problem!.type, restoration === "overdue" ? /occurrence-uncertain$/u : /occurrence-unavailable$/u);
                assert.deepEqual(await f.events.producer("schedule").pending(), [], "the next recurrence was not silently attached");
            }
            assert.deepEqual(f.reports, []);
        } finally { await f.close(); }
    });
}

test("{§schedule-await}: registration racing duplicate timer delivery cannot miss or duplicate settlement", async (t) => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    try {
        const scheduler = f.create();
        await scheduler.sync(f.workspaceId, f.rules);
        const entered = Promise.withResolvers<void>();
        const join = f.caps.join;
        t.mock.method(f.caps, "join", async (...args: Parameters<typeof join>) => {
            entered.resolve();
            await release.promise;
            return join(...args);
        });
        let deliveries = 0;
        t.mock.method(f.port, "runLoop", async () => {
            deliveries++;
            await scheduler.sync(f.workspaceId, f.rules); // admission may refresh capabilities
            return { status: 200 };
        });
        const waiting = scheduler.wait(f.workspaceId, "reminder", f.caps);
        await entered.promise;
        const duplicate = f.fire();
        duplicate();
        assert.equal(deliveries, 0, "settlement waits for attachment registration");
        release.resolve();
        const joined = await waiting;
        assert.ok(typeof joined.resource === "string");
        const path = new URL(joined.resource!).pathname;
        await waitForDb(() => f.caps.read(path), (record) => record!.result !== null);
        assert.equal((await f.caps.read(path))!.result!.status, 200);
        assert.equal(deliveries, 1, "duplicate callbacks deliver the occurrence once");
        assert.deepEqual(f.reports, []);
    } finally { release.resolve(); await f.close(); }
});

test("{§schedule-await}: failed delivery retains its factual result and close joins in-flight settlement", async (t) => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    try {
        const scheduler = f.create();
        await scheduler.sync(f.workspaceId, f.rules);
        const joined = await scheduler.wait(f.workspaceId, "reminder", f.caps);
        assert.ok(typeof joined.resource === "string");
        const entered = Promise.withResolvers<void>();
        const failure = new Error("Fixture admission failed.");
        t.mock.method(f.port, "runLoop", async () => { entered.resolve(); await release.promise; throw failure; });
        f.fire();
        await entered.promise;
        let closed = false;
        const closing = scheduler.close().then(() => { closed = true; });
        assert.equal(closed, false);
        release.resolve();
        await closing;
        const record = await f.caps.read(new URL(joined.resource!).pathname);
        assert.equal(record!.result!.status, 502);
        assert.equal(record!.result!.problem!.diagnostic, failure.message);
        assert.deepEqual(f.reports, [failure]);
    } finally { release.resolve(); await f.close(); }
});

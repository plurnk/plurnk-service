import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { Module, type SchedulerTimers } from "@plurnk/plurnk-schedule";
import Daemon from "../../src/server/Daemon.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated } from "./_helpers.ts";
import { waitForDb } from "./_rpc.ts";
import type { AwaitedEventRow } from "../../src/core/AwaitedEvents.ts";
import { OperationFailureError } from "../../src/core/results.ts";

// A client retries the one retryable refusal: 409 workspace-busy, while the turn that parked the
// loop still holds the workspace for its last moment ({§module-workspace-quiescence}). The 202 is
// durable a beat before that turn lets go, so a test that reads the database can arrive in between.
const whenSettled = async <T>(daemon: Daemon, name: string, params: Readonly<Record<string, unknown>>, workspaceId: number): Promise<T> => {
    const outcome = await waitForDb(async () => {
        try {
            return { value: await daemon.invokeModuleAction(name, params, { scope: "workspace", workspaceId }) as T };
        } catch (error) {
            if (!(error instanceof OperationFailureError) || !error.result.problem!.type.endsWith("/workspace-busy")) throw error;
            assert.equal(error.result.status, 409);
            assert.equal(error.result.problem!.retryable, true);
            return null;
        }
    }, (settled) => settled !== null);
    return outcome!.value;
};

const INITIAL = Date.UTC(2026, 8, 17, 12, 0, 0, 250);

const fixture = async (programs: string[], run: (f: {
    db: Awaited<ReturnType<typeof openMigrated>>;
    daemon: Daemon;
    provider: Mock;
    workspaceId: number;
    workerId: number;
    module: Module;
    restart(options?: { elapsed?: number; withModule?: boolean }): Promise<Daemon>;
    fire(): void;
}) => Promise<void>): Promise<void> => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: programs.map((content) => ({ assistant: { content, reasoning: null } })) });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const timerApi: SchedulerTimers = {
        set: (callback, delay) => { const id = ++serial; timers.set(id, { callback, due: now + delay }); return id; },
        clear: (id) => { timers.delete(id as number); },
    };
    const makeModule = () => Module.init({ env: { TZ: "UTC" }, clock: () => now, timers: timerApi });
    const module = makeModule();
    let daemon = new Daemon({ db, provider });
    daemon.registerModule(module);
    await daemon.start();
    try {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-waits", projectRoot: null });
        const { workerId, workerName } = await daemon.createConversationWorker({ workspaceId, name: "recipient" });
        const result = await daemon.invokeModuleAction("workspace.schedule.add", {
            alias: "reminder", definition: {
                rule: "FREQ=HOURLY;COUNT=2", target: `worker://${workerName}`, prompt: "scheduled-proof",
            },
        }, { scope: "workspace", workspaceId }) as { status: number };
        assert.equal(result.status, 201);
        await run({ db, daemon, provider, workspaceId, workerId, module, restart: async ({ elapsed = 0, withModule = true } = {}) => {
            await daemon.stop();
            now += elapsed;
            daemon = new Daemon({ db, provider });
            if (withModule) daemon.registerModule(makeModule());
            await daemon.start();
            return daemon;
        }, fire: () => {
            const next = [...timers.entries()].toSorted((a, b) => a[1].due - b[1].due)[0];
            assert.ok(next, "the scheduler has an armed occurrence");
            now = next[1].due;
            timers.delete(next[0]);
            next[1].callback();
        } });
    } finally { await daemon.stop(); await db.close(); }
};

test("{§schedule-await}: unrelated arrival and bare WAIT preserve one awaited occurrence, not its recurrence", { timeout: 30_000 }, async () => {
    await fixture([
        "````WAIT (schedule:///rules/reminder)\n````",
        "````NOTE\nAn unrelated arrival does not replace the reminder.\n````\n\n````WAIT\n````",
        "````SEND\nReceived scheduled-proof and the unrelated message.\n````",
    ], async ({ db, daemon, provider, workspaceId, workerId, fire }) => {
        const accepted = await daemon.runLoop({ workspaceId, workerId, prompt: "Wait for the scheduled proof before replying.", maxTurns: 4 });
        const status = async (): Promise<number> => (await db.test_get_loop_status.get<{ status: number }>({ id: accepted.loopId }))!.status;
        await waitForDb(status, (value) => value === 202 || value >= 400);
        assert.equal(await status(), 202, "a schedule-only loop parks instead of burning inference turns");
        const before = await db.awaited_event_packet.all<AwaitedEventRow>({ loop_id: accepted.loopId });
        assert.equal(before.length, 1);
        assert.equal(before[0]!.source, "schedule:///rules/reminder");
        assert.equal(before[0]!.due_at, "2026-09-17T12:00:01.000Z");
        const other = await daemon.runLoop({ workspaceId, workerId, prompt: "An unrelated message." });
        assert.equal(other.loopId, accepted.loopId);
        await waitForDb(async () => ({ status: await status(), calls: provider.received.length }), (value) => value.status === 202 && value.calls === 2);
        assert.equal((await db.awaited_event_packet.all<AwaitedEventRow>({ loop_id: accepted.loopId }))[0]!.id, before[0]!.id);
        assert.match(JSON.stringify(provider.received[1]), /schedule:\/\/\/rules\/reminder/u, "the packet exposes the retained obligation");
        fire();
        await waitForDb(status, (value) => value === 200 || value >= 400);
        assert.equal(await status(), 200, "the next recurrence is not automatically awaited");
        assert.equal(provider.received.length, 3);
        assert.match(JSON.stringify(provider.received[2]), /scheduled-proof/u);
        const result = await db.awaited_event_get.get<AwaitedEventRow>({ workspace_id: workspaceId, scheme: "schedule", name: before[0]!.name });
        assert.equal(JSON.parse(result!.result!).status, 200);
        assert.equal(result!.observed, 1);
    });
});

for (const recovery of ["future", "overdue", "missing-producer"] as const) {
    test(`{§awaited-event}: composed daemon restart handles ${recovery} without dropping the loop`, { timeout: 30_000 }, async () => {
        await fixture([
            "````WAIT (schedule:///rules/reminder)\n````",
            "````SEND\nObserved the scheduled occurrence's outcome.\n````",
        ], async ({ db, daemon, provider, workspaceId, workerId, restart, fire }) => {
            const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Await the reminder." });
            const lifecycle = new LoopLifecycle(db);
            await waitForDb(() => lifecycle.status(loopId), (status) => status === 202 || status >= 400);
            assert.equal(await lifecycle.status(loopId), 202);
            const [before] = await db.awaited_event_packet.all<AwaitedEventRow>({ loop_id: loopId });
            await restart({ elapsed: recovery === "overdue" ? 1_000 : 0, withModule: recovery !== "missing-producer" });
            if (recovery === "future") {
                assert.equal(await lifecycle.status(loopId), 202, "restart preserves the pending occurrence and parking");
                assert.equal(provider.received.length, 1, "no replayed inference");
                fire();
            }
            await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400);
            assert.equal(await lifecycle.status(loopId), 200);
            assert.equal(provider.received.length, 2);
            const row = await db.awaited_event_get.get<AwaitedEventRow>({ workspace_id: workspaceId, scheme: "schedule", name: before!.name });
            assert.equal(JSON.parse(row!.result!).status, recovery === "future" ? 200 : recovery === "overdue" ? 504 : 503);
            assert.equal(row!.observed, 1);
        });
    });
}

test("{§schedule-await}: namespaces fold normally and repeated WAIT attaches once after the whole program", { timeout: 30_000 }, async () => {
    await fixture([
        "````WAIT (schedule://rules/reminder)\n````\n\n````SEND\nThe reply does not drop the wait.\n````",
        "````WAIT (schedule:///rules/reminder)\n````",
        "````SEND\nReceived the occurrence.\n````",
    ], async ({ db, daemon, provider, workspaceId, workerId, fire }) => {
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Reply, then await the reminder." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 202 || status >= 400);
        assert.equal(await lifecycle.status(loopId), 202);
        assert.equal((await db.awaited_event_packet.all({ loop_id: loopId })).length, 1);
        await daemon.runLoop({ workspaceId, workerId, prompt: "Keep awaiting the same occurrence." });
        await waitForDb(async () => ({ status: await lifecycle.status(loopId), calls: provider.received.length }), (value) => value.status === 202 && value.calls === 2);
        assert.equal((await db.awaited_event_packet.all({ loop_id: loopId })).length, 1, "repeated attachment is idempotent");
        fire();
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(loopId), 200);
        assert.equal(provider.received.length, 3);
    });
});

test("{§schedule-await}: an unattached recurrence does not hold a completed loop", { timeout: 30_000 }, async () => {
    await fixture(["````SEND\nFinished; the independent reminder is still scheduled.\n````"], async ({ db, daemon, workspaceId, workerId, module }) => {
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Reply without awaiting the reminder." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(loopId), 200);
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"]);
        assert.deepEqual(await db.awaited_event_packet.all({ loop_id: loopId }), []);
    });
});

for (const verb of ["disable", "remove"] as const) {
    test(`{§schedule-await}: ${verb} settles visibly and wakes a parked loop`, { timeout: 30_000 }, async () => {
        await fixture([
            "````WAIT (schedule:///rules/reminder)\n````",
            "````SEND\nThe awaited occurrence was withdrawn.\n````",
        ], async ({ db, daemon, provider, workspaceId, workerId }) => {
            const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Await the reminder." });
            const lifecycle = new LoopLifecycle(db);
            await waitForDb(() => lifecycle.status(loopId), (status) => status === 202 || status >= 400);
            assert.equal(await lifecycle.status(loopId), 202);
            const [attachment] = await db.awaited_event_packet.all<AwaitedEventRow>({ loop_id: loopId });
            const result = await whenSettled<{ status: number }>(daemon, `workspace.schedule.${verb}`, { alias: "reminder" }, workspaceId);
            assert.ok(result.status < 400);
            await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400);
            assert.equal(await lifecycle.status(loopId), 200);
            assert.equal(provider.received.length, 2);
            assert.match(JSON.stringify(provider.received[1]), /occurrence-withdrawn/u);
            const settled = await db.awaited_event_get.get<AwaitedEventRow>({ workspace_id: workspaceId, scheme: "schedule", name: attachment!.name });
            assert.equal(JSON.parse(settled!.result!).status, 410);
            assert.equal(settled!.observed, 1);
            if (verb === "disable") {
                await whenSettled(daemon, "workspace.schedule.enable", { alias: "reminder" }, workspaceId);
                assert.deepEqual(await db.awaited_event_pending.all({ scheme: "schedule" }), [], "enable does not revive old attachments");
            }
        });
    });
}

test("{§schedule-await}: ordinary READ and KILL inspect and withdraw only the wait; log curation does not", { timeout: 30_000 }, async (t) => {
    await fixture([
        "````WAIT (schedule:///rules/reminder)\n````",
        "placeholder",
        "````SEND\nStopped awaiting this occurrence.\n````",
    ], async ({ db, daemon, provider, workspaceId, workerId, module }) => {
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Await the reminder." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 202 || status >= 400);
        assert.equal(await lifecycle.status(loopId), 202);
        const [attachment] = await db.awaited_event_packet.all<AwaitedEventRow>({ loop_id: loopId });
        assert.ok(attachment);
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (...args: Parameters<typeof generate>) => {
            const response = await generate(...args);
            if (response.assistant.content !== "placeholder") return response;
            const content = [
                "````KILL (log:///**/WAIT)\n````",
                "````READ (schedule://rules/reminder) <1,-1>\n````",
                `\`\`\`\`READ (schedule://waits/${attachment.name}) <1,-1>\n\`\`\`\``,
                `\`\`\`\`KILL (schedule://waits/${attachment.name})\n\`\`\`\``,
            ].join("\n\n");
            return { ...response, assistant: { ...response.assistant, content } };
        });
        await daemon.runLoop({ workspaceId, workerId, prompt: "Withdraw the wait, not the rule." });
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(loopId), 200);
        assert.equal(provider.received.length, 3);
        const finalPacket = JSON.stringify(provider.received[2]);
        assert.match(finalPacket, /FREQ=HOURLY/u, "READ materialized the rule through the normal entry path");
        assert.match(finalPacket, /2026-09-17T12:00:01.000Z/u, "READ retained the pending attachment after log KILL");
        assert.match(finalPacket, /This wait was withdrawn; its source is unchanged/u);
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"]);
    });
});

test("{§awaited-event}: cancelling the loop retires its attachments without cancelling the shared rule", { timeout: 30_000 }, async () => {
    await fixture(["````WAIT (schedule:///rules/reminder)\n````"], async ({ db, daemon, provider, workspaceId, workerId, module }) => {
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Await the reminder." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 202 || status >= 400);
        assert.equal(await lifecycle.status(loopId), 202);
        const [attachment] = await db.awaited_event_packet.all<AwaitedEventRow>({ loop_id: loopId });
        await daemon.cancelWorker({ workspaceId, workerId });
        assert.equal(await lifecycle.status(loopId), 499);
        assert.deepEqual(await db.awaited_event_pending.all({ scheme: "schedule" }), []);
        const row = await db.awaited_event_get.get<AwaitedEventRow>({ workspace_id: workspaceId, scheme: "schedule", name: attachment!.name });
        assert.equal(JSON.parse(row!.result!).status, 499);
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"]);
        await daemon.awaitedEvents("schedule").settle(workspaceId, attachment!.event, { status: 200 });
        assert.equal(await lifecycle.status(loopId), 499, "late settlement cannot resurrect the cancelled loop");
        assert.equal(provider.received.length, 1);
    });
});

test("{§awaited-event}: settlement wakes only the attached loop when a worker has two parked assignments", { timeout: 30_000 }, async () => {
    await fixture([
        "````WAIT (schedule:///rules/reminder)\n````",
        "````WAIT (schedule:///rules/other)\n````",
        "````SEND\nThe second assignment's occurrence was withdrawn.\n````",
    ], async ({ db, daemon, provider, workspaceId, workerId }) => {
        const added = await daemon.invokeModuleAction("workspace.schedule.add", {
            alias: "other", definition: { rule: "FREQ=DAILY;COUNT=1", target: "worker://recipient", prompt: "Other event." },
        }, { scope: "workspace", workspaceId }) as { status: number };
        assert.equal(added.status, 201);
        const common = {
            workspaceId, workerId, providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
            reasoningPolicy: "adaptive" as const, systemPrompt: "test system",
        };
        const lifecycle = new LoopLifecycle(db);
        const [first, second] = await Promise.all([
            daemon.inject({ ...common, prompt: "First assignment." }),
            daemon.inject({ ...common, prompt: "Second assignment." }),
        ]);
        await waitForDb(async () => [await lifecycle.status(first.loopId), await lifecycle.status(second.loopId)],
            (statuses) => statuses.every((status) => status === 202 || status >= 400));
        assert.equal(await lifecycle.status(first.loopId), 202);
        assert.equal(await lifecycle.status(second.loopId), 202);
        assert.notEqual(first.loopId, second.loopId);
        await whenSettled(daemon, "workspace.schedule.disable", { alias: "other" }, workspaceId);
        await waitForDb(() => lifecycle.status(second.loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(second.loopId), 200);
        assert.equal(await lifecycle.status(first.loopId), 202, "a settlement is not a worker-wide wake");
        assert.equal(provider.received.length, 3);
        await daemon.cancelWorker({ workspaceId, workerId });
    });
});

test("{§awaited-event}: settlement just before parking resumes through the ordinary drain", { timeout: 30_000 }, async (t) => {
    await fixture([
        "````WAIT (schedule:///rules/reminder)\n````",
        "````SEND\nObserved the occurrence that settled at the park boundary.\n````",
    ], async ({ db, daemon, provider, workspaceId, workerId }) => {
        const park = LoopLifecycle.prototype.park;
        let crossed = false;
        t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, loopId: number, options: { wakenBy: string | null }) {
            if (!crossed) {
                crossed = true;
                const [attachment] = await db.awaited_event_packet.all<AwaitedEventRow>({ loop_id: loopId });
                assert.ok(attachment);
                await daemon.awaitedEvents("schedule").settle(workspaceId, attachment.event, { status: 200 });
            }
            return park.call(this, loopId, options);
        });
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Await the occurrence." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(loopId), 200);
        assert.equal(crossed, true);
        assert.equal(provider.received.length, 2, "the pre-park notification was not lost");
    });
});

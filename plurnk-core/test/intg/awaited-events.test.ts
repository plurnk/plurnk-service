import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { Problems } from "@plurnk/plurnk-contracts";
import type { PacketSectionDraft } from "@plurnk/plurnk-schemes";
import AwaitedEvents from "../../src/core/AwaitedEvents.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection } from "./_helpers.ts";

test("{§awaited-event}: attachments are loop-local, idempotent, independently cancellable and terminal-immutable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "awaited-identity");
        const workerId = await insertWorker(db, workspaceId);
        const first = await insertLoop(db, workerId, 1);
        const second = await insertLoop(db, workerId, 2);
        const notifications: number[] = [];
        const owner = new AwaitedEvents(db, (_workspaceId, _workerId, loopId) => { notifications.push(loopId); });
        const a = owner.operation("schedule", { workspaceId, workerId, loopId: first });
        const b = owner.operation("schedule", { workspaceId, workerId, loopId: second });
        const event = { event: "reminder/123", source: "schedule:///rules/reminder", dueAt: "2026-09-17T12:00:01Z" };
        const one = await a.join(event);
        assert.equal(one.status, 200);
        assert.deepEqual(await a.join(event), one);
        const two = await b.join(event);
        assert.ok(typeof one.resource === "string" && typeof two.resource === "string");
        assert.notEqual(two.resource, one.resource, "each loop owns its attachment even on one worker");
        const extra = await a.join({ ...event, event: "other/456" });
        assert.notEqual(extra.resource, one.resource);
        const path = new URL(one.resource!).pathname;
        assert.equal((await b.read(path))?.event, event.event, "read access is workspace-wide");
        assert.equal((await b.cancel(path)).status, 200, "another worker context need not own the resource");
        assert.deepEqual(notifications, [first]);
        assert.equal((await a.read(path))?.result?.status, 499);
        const producer = owner.producer("schedule");
        await assert.rejects(producer.settle(workspaceId, event.event, { status: 202 }), /terminal result/u);
        const failure = { status: 502, problem: Problems.create("test:event", "delivery-failed", 502, "Fixture delivery failed.") };
        await producer.settle(workspaceId, event.event, failure);
        await producer.settle(workspaceId, event.event, { status: 200 });
        assert.deepEqual(notifications, [first, second], "only the pending attachment settled, exactly once");
        assert.equal((await a.read(path))?.result?.status, 499, "cancel result cannot be overwritten by delivery");
        assert.deepEqual((await b.read(new URL(two.resource!).pathname))?.result, failure);
        assert.deepEqual(await db.loop_live_obligations.get({ loop_id: first }), { streams: 0, workers: 0, events: 1 });
        assert.deepEqual(await db.loop_live_obligations.get({ loop_id: second }), { streams: 0, workers: 0, events: 0 });
        await new LoopLifecycle(db).finish(first, { status: 499, problem: Problems.create("test:event", "cancelled", 499, "Cancelled.") });
        assert.deepEqual(await producer.pending(), [], "loop termination retires its remaining attachment atomically");
        assert.equal((await a.join({ ...event, event: "late" })).status, 409, "a terminal loop accepts no new work");
    } finally { await db.close(); }
});

test("{§awaited-event}: packet observation and parking cannot lose a concurrently settled event", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "awaited-observation");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const owner = new AwaitedEvents(db);
        const event = { event: "reminder/123", source: "schedule:///rules/reminder" };
        await owner.operation("schedule", { workspaceId, workerId, loopId }).join(event);
        const schemes = new SchemeRegistry();
        const builder = new PacketBuilder({ db, schemes, executors: () => undefined });
        const provider = new Mock({ contextWindow: 65536, responses: [] });
        const build = () => builder.buildRequestPacket({ workspaceId, workerId, loopId, currentTurnSeq: 2, provider, initialMessages: [], gitStatus: null });
        const lifecycle = new LoopLifecycle(db);
        const pending = await build();
        assert.equal(JSON.parse(packetSection(pending, "delegation")).events[0].status, "pending");
        await owner.producer("schedule").settle(workspaceId, event.event, { status: 200 });
        await builder.recordObservations(pending);
        assert.equal((await db.awaited_event_unobserved.all({ loop_id: loopId })).length, 1, "the pending snapshot did not present the later result");
        assert.equal(await lifecycle.finish(loopId, { status: 200 }, { requireAnswered: true }), null, "completion rechecks unobserved results atomically");
        assert.equal(await lifecycle.park(loopId), true);
        assert.equal(await lifecycle.wake(loopId, { eventOnly: true }), true, "settlement before parking still wakes that exact loop");
        const transform = t.mock.method(schemes, "transformSections", async (sections: PacketSectionDraft[]) => sections.filter((section) => section.name !== "delegation"));
        const hidden = await build();
        assert.equal(packetSection(hidden, "delegation"), "");
        await builder.recordObservations(hidden);
        assert.equal((await db.awaited_event_unobserved.all({ loop_id: loopId })).length, 1, "a plugin cannot acknowledge a result it removed from the packet");
        transform.mock.restore();
        const settled = await build();
        assert.equal(JSON.parse(packetSection(settled, "delegation")).events[0].status, 200);
        assert.equal((await db.awaited_event_unobserved.all({ loop_id: loopId })).length, 1, "a speculative packet does not acknowledge results");
        await builder.recordObservations(settled);
        assert.equal((await db.awaited_event_unobserved.all({ loop_id: loopId })).length, 0);
        assert.deepEqual(await lifecycle.finish(loopId, { status: 200 }, { requireAnswered: true }), { status: 200 });
    } finally { await db.close(); }
});

test("{§awaited-event}: restart without the producer settles its attachments visibly instead of stranding them", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "awaited-absent-producer");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const owner = new AwaitedEvents(db);
        const caps = owner.operation("schedule", { workspaceId, workerId, loopId });
        const joined = await caps.join({ event: "reminder/123", source: "schedule:///rules/reminder" });
        assert.ok(typeof joined.resource === "string");
        const lifecycle = new LoopLifecycle(db);
        await lifecycle.park(loopId);
        await owner.reconcileProducers(["schedule"]);
        assert.equal(await lifecycle.wake(loopId, { eventOnly: true }), false, "an available producer keeps the pending obligation");
        await owner.reconcileProducers([]);
        assert.equal((await caps.read(new URL(joined.resource!).pathname))?.result?.problem?.type,
            "https://problems.plurnk.xyz/lifecycle/wait/producer-unavailable");
        assert.equal(await lifecycle.wake(loopId, { eventOnly: true }), true);
    } finally { await db.close(); }
});

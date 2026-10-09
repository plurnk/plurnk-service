import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Task, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import type { ApplicationEventHandler } from "@plurnk/plurnk-contracts";
import type { HostedTaskBinding } from "./HostedTasks.ts";
import TaskObservation from "./TaskObservation.ts";

const fixture = () => {
    const listeners = new Set<ApplicationEventHandler>();
    let task = Task.fromJSON({ id: "task", contextId: "context", status: { state: "TASK_STATE_WORKING" } });
    let reads = 0;
    const tasks = {
        binding: async () => ({ workspaceId: 7, worker: { id: 9 } }) as HostedTaskBinding,
        load: async () => { reads++; return structuredClone(task); },
    };
    const emit = (workspaceId = 7, workerId = 9, method = "loop/terminated", params: object = {}) => {
        for (const listener of listeners) listener(workspaceId, method, { workerId, ...params });
    };
    const observation = new TaskObservation({
        subscribeToEvents: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }, tasks);
    return {
        observation, tasks, listeners, emit,
        get reads() { return reads; },
        finish() { task = { ...task, status: { ...task.status!, state: TaskState.TASK_STATE_COMPLETED } }; emit(); },
    };
};

test("{§a2a-task-observation}: completion before admission returns is the initial durable snapshot", async () => {
    const f = fixture();
    const snapshots = [];
    for await (const task of f.observation.follow(async () => {
        assert.equal(f.listeners.size, 1, "observation starts before admission");
        f.finish();
        return "task";
    }, new ServerCallContext())) snapshots.push(task);
    assert.deepEqual(snapshots.map((task) => task.status?.state), [TaskState.TASK_STATE_COMPLETED]);
    assert.equal(f.listeners.size, 0);
});

test("{§a2a-task-observation}: a completion during a durable read is not a lost wake", async (t) => {
    const f = fixture();
    const load = f.tasks.load;
    t.mock.method(f.tasks, "load", async () => {
        const snapshot = await load();
        if (snapshot.status?.state === TaskState.TASK_STATE_WORKING) f.finish();
        return snapshot;
    });
    const states = [];
    for await (const task of f.observation.follow(async () => "task", new ServerCallContext())) states.push(task.status?.state);
    assert.deepEqual(states, [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_COMPLETED]);
    assert.equal(f.listeners.size, 0);
});

test("{§a2a-task-observation}: unrelated traffic causes no Task reads", async () => {
    const f = fixture();
    const stream = f.observation.follow(async () => "task", new ServerCallContext());
    assert.equal((await stream.next()).value?.status?.state, TaskState.TASK_STATE_WORKING);
    let resolved = false;
    const next = stream.next().then((result) => { resolved = true; return result; });
    f.emit(8);
    f.emit(7, 10);
    f.emit(7, 9, "notice/event", { notice: { kind: "provider_unavailable" } });
    f.emit(7, 9, "reasoning/event");
    await setImmediate();
    assert.equal(resolved, false);
    assert.equal(f.reads, 1);
    f.finish();
    assert.equal((await next).value?.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal((await stream.next()).done, true);
    assert.equal(f.listeners.size, 0);
});

test("{§a2a-task-observation}: ending observation only releases that request's listener", async () => {
    const f = fixture();
    const first = f.observation.follow(async () => "task", new ServerCallContext());
    const second = f.observation.follow(async () => "task", new ServerCallContext());
    await first.next();
    await second.next();
    assert.equal(f.listeners.size, 2);
    await first.return(undefined);
    assert.equal(f.listeners.size, 1);
    f.finish();
    assert.equal((await second.next()).value?.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal((await second.next()).done, true);
    assert.equal(f.listeners.size, 0);
});

test("{§a2a-task-observation}: admission and projection failures release observation without hiding the cause", async (t) => {
    for (const stage of ["admission", "projection"] as const) {
        const f = fixture();
        const cause = new Error(stage);
        if (stage === "projection") t.mock.method(f.tasks, "load", async () => { throw cause; });
        const stream = f.observation.follow(async () => { if (stage === "admission") throw cause; return "task"; }, new ServerCallContext());
        await assert.rejects(stream.next(), (error: unknown) => error === cause);
        assert.equal(f.listeners.size, 0);
    }
});

test("{§a2a-task-observation}: module close releases waiting and suspended observers without changing Task state", async () => {
    const f = fixture();
    const waiting = f.observation.follow(async () => "task", new ServerCallContext());
    const suspended = f.observation.follow(async () => "task", new ServerCallContext());
    await waiting.next();
    await suspended.next();
    const next = waiting.next();
    await f.observation.close();
    assert.equal((await next).done, true);
    assert.equal((await suspended.next()).done, true);
    assert.equal(f.listeners.size, 0);
    assert.equal((await f.tasks.load()).status?.state, TaskState.TASK_STATE_WORKING);
    assert.throws(() => f.observation.follow(async () => "task", new ServerCallContext()), /closed/u);
});

test("{§a2a-task-observation}: module close joins a projection already reading application state", async (t) => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const load = f.tasks.load;
    t.mock.method(f.tasks, "load", async () => { entered.resolve(); await release.promise; return load(); });
    const stream = f.observation.follow(async () => "task", new ServerCallContext());
    const next = stream.next();
    await entered.promise;
    let closed = false;
    const close = f.observation.close().then(() => { closed = true; });
    try {
        await setImmediate();
        assert.equal(closed, false, "application resources cannot close beneath an admitted read");
        release.resolve();
        await close;
        assert.equal((await next).done, true);
        assert.equal(f.listeners.size, 0);
        const reads = f.reads;
        f.finish();
        await setImmediate();
        assert.equal(f.reads, reads, "no later events can reopen observation");
    } finally { release.resolve(); await close; }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
    A2A_PROTOCOL_VERSION,
    Role,
    type SendMessageResult,
    TaskState,
    type StreamResponse,
    type Task,
} from "@a2a-js/sdk";
import { connectHttpJsonAgent, textRequest } from "../fixtures/DemoClient.ts";
import { startDemoAgent } from "../fixtures/DemoAgent.ts";

const asTask = (value: SendMessageResult): Task => {
    assert.ok("id" in value, "blocking response must be a Task");
    return value;
};

const payload = (event: StreamResponse): NonNullable<StreamResponse["payload"]> => {
    assert.ok(event.payload, "stream response must carry a payload");
    return event.payload;
};

test("discovers a v1 HTTP+JSON agent and completes a retrievable task", async (t) => {
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);

    const card = await client.getAgentCard();
    assert.equal(client.protocolVersion, A2A_PROTOCOL_VERSION);
    assert.equal(client.transport.protocolName, "HTTP+JSON");
    assert.deepEqual(card.supportedInterfaces, [{
        url: agent.endpoint,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        tenant: "",
    }]);

    const task = asTask(await client.sendMessage(textRequest("protocol witness")));
    assert.notEqual(task.contextId, "");
    assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.artifacts[0]?.parts[0]?.content?.$case, "text");
    assert.equal(task.artifacts[0]?.parts[0]?.content?.value, "received: protocol witness");

    const stored = await client.getTask({ tenant: "", id: task.id, historyLength: 1 });
    assert.equal(stored.id, task.id);
    assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(stored.history.length, 1);
    assert.equal(agent.executor.received.length, 1);
    const received = agent.executor.received[0]!;
    assert.equal(received.taskId, task.id);
    assert.equal(received.contextId, task.contextId);
    assert.equal(received.userMessage.taskId, task.id);
    assert.equal(received.userMessage.contextId, task.contextId);
    assert.equal(received.userMessage.role, Role.ROLE_USER);
    assert.equal(received.userMessage.parts[0]?.mediaType, "text/plain");
});

test("streams the ordered task, working, artifact, and completion lifecycle", async (t) => {
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const events: StreamResponse[] = [];

    for await (const event of client.sendMessageStream(textRequest("stream witness"))) {
        events.push(event);
    }

    assert.deepEqual(events.map((event) => payload(event).$case), [
        "task",
        "statusUpdate",
        "artifactUpdate",
        "statusUpdate",
    ]);
    const working = payload(events[1]!);
    assert.equal(working.$case, "statusUpdate");
    if (working.$case === "statusUpdate") {
        assert.equal(working.value.status?.state, TaskState.TASK_STATE_WORKING);
    }
    const completed = payload(events[3]!);
    assert.equal(completed.$case, "statusUpdate");
    if (completed.$case === "statusUpdate") {
        assert.equal(completed.value.status?.state, TaskState.TASK_STATE_COMPLETED);
    }
});

test("cancels a working task through the same HTTP+JSON binding", async (t) => {
    const agent = await startDemoAgent("wait-for-cancel");
    t.after(() => agent.close());
    const client = await connectHttpJsonAgent(agent.baseUrl);
    const states: TaskState[] = [];
    let taskId: string | undefined;
    let cancellation: Promise<Task> | undefined;

    for await (const event of client.sendMessageStream(textRequest("cancel witness"))) {
        const current = payload(event);
        if (current.$case === "task") {
            taskId = current.value.id;
        }
        if (current.$case === "statusUpdate" && current.value.status !== undefined) {
            states.push(current.value.status.state);
            if (current.value.status.state === TaskState.TASK_STATE_WORKING) {
                assert.ok(taskId, "working update must follow the Task snapshot");
                cancellation = client.cancelTask({ tenant: "", id: taskId, metadata: {} });
            }
        }
    }

    assert.ok(cancellation, "working task must issue a cancellation request");
    const cancelled = await cancellation;
    assert.equal(cancelled.id, taskId);
    assert.equal(cancelled.status?.state, TaskState.TASK_STATE_CANCELED);
    assert.deepEqual(states, [
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_CANCELED,
    ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
    TaskState,
    type StreamResponse,
    type Task,
} from "@a2a-js/sdk";
import {
    A2aMessage,
    connectHttpJsonAgent,
    Module as A2aModule,
} from "@plurnk/plurnk-a2a";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { a2aCard, streamPayload as payload } from "./_a2a.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

class BlockingMock extends Mock {
    readonly started = Promise.withResolvers<void>();

    constructor() {
        super({ contextWindow: 100_000, responses: [] });
    }

    override async generate(
        args: Parameters<Mock["generate"]>[0],
    ): Promise<Awaited<ReturnType<Mock["generate"]>>> {
        args.signal?.throwIfAborted();
        this.started.resolve();
        const signal = args.signal;
        if (signal === undefined) throw new Error("the cancellation witness requires a provider signal");
        await new Promise<void>((_resolve, reject) => {
            const abort = (): void => {
                try {
                    signal.throwIfAborted();
                } catch (cause) {
                    reject(cause);
                }
            };
            signal.addEventListener("abort", abort, { once: true });
            abort();
        });
        throw new Error("the cancellation witness provider resumed without an abort");
    }
}

const runTask = async (
    client: Awaited<ReturnType<typeof connectHttpJsonAgent>>,
    prompt: string,
    identity: { readonly contextId?: string; readonly taskId?: string } = {},
): Promise<{ task: Task; events: StreamResponse[] }> => {
    const events: StreamResponse[] = [];
    for await (const event of client.sendMessageStream(A2aMessage.request(
        prompt,
        identity,
    ))) {
        events.push(event);
    }
    const first = payload(events[0]!);
    assert.equal(first.$case, "task");
    if (first.$case !== "task") throw new Error("the composed A2A run did not create a Task");
    return { task: first.value, events };
};

test("{§a2a-inbound-exposure}: the official A2A client drives Context and Task workers through ApplicationPort", async (testContext) => {
    const db = await openMigrated();
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("## SEND0 [200]\nfirst composed result"),
            makeMockResponse("## SEND0 [200]\nsecond composed result"),
            makeMockResponse([
                "## EXEC0 [question]",
                JSON.stringify({
                    message: "Which branch should I use?",
                    requestedSchema: {
                        type: "object",
                        properties: { branch: { type: "string" } },
                        required: ["branch"],
                        additionalProperties: false,
                    },
                }),
                "## SEND0 [202]",
                "waiting for the branch selection",
            ].join("\n")),
            makeMockResponse("## SEND0 [200]\nselected branch"),
        ],
    });
    const daemon = new Daemon({ db, provider });
    const workspace = await daemon.createWorkspace({
        name: `a2a-inbound-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    const ordinaryRoot = await daemon.createConversationWorker({
        workspaceId: workspace.workspaceId,
        name: crypto.randomUUID(),
    });
    const ordinaryChild = await daemon.forkWorker({
        workspaceId: workspace.workspaceId,
        workerId: ordinaryRoot.workerId,
        name: crypto.randomUUID(),
    });
    const registration = A2aModule.init({
        workspaceId: workspace.workspaceId,
        card: a2aCard(),
        host: "127.0.0.1",
        port: 0,
    });
    let a2a: A2aModule | null = null;
    daemon.registerModule({
        start: async (port) => {
            a2a = await registration.start(port);
            return a2a;
        },
    });

    try {
        await daemon.start();
        assert.ok(a2a !== null, "daemon start activates the exterior A2A listener");
        const address = (a2a as A2aModule).address();
        const client = await connectHttpJsonAgent(`http://${address.host}:${address.port}`);
        const discovered = await client.getAgentCard();
        assert.equal(discovered.supportedInterfaces[0]?.protocolVersion, "1.0");
        assert.equal(discovered.supportedInterfaces[0]?.protocolBinding, "HTTP+JSON");
        await assert.rejects(
            client.getTask({ tenant: "", id: ordinaryChild.workerName!, historyLength: 1 }),
            /Task not found/i,
            "ordinary child workers are not A2A Tasks",
        );
        const sdkErrors: unknown[][] = [];
        const sdkWarnings: unknown[][] = [];
        const error = testContext.mock.method(console, "error", (...args: unknown[]) => { sdkErrors.push(args); });
        const warning = testContext.mock.method(console, "warn", (...args: unknown[]) => { sdkWarnings.push(args); });
        let rejectedContext: Awaited<ReturnType<typeof runTask>>;
        try {
            rejectedContext = await runTask(client, "do not adopt this worker", {
                contextId: ordinaryRoot.workerName,
            });
        } finally {
            error.mock.restore();
            warning.mock.restore();
        }
        assert.match(String(sdkErrors[0]?.[0]), /Agent execution failed/);
        assert.match(String(sdkWarnings[0]?.[0]), /unknown task/);
        const rejectedTerminal = payload(rejectedContext.events.at(-1)!);
        assert.equal(rejectedTerminal.$case, "statusUpdate");
        if (rejectedTerminal.$case === "statusUpdate") {
            assert.equal(rejectedTerminal.value.status?.state, TaskState.TASK_STATE_FAILED);
        }
        assert.equal(
            (await daemon.listWorkers(workspace.workspaceId, {
                origin: "model",
                parentWorkerId: ordinaryRoot.workerId,
            })).length,
            1,
            "an A2A caller cannot adopt an ordinary root Context",
        );

        const first = await runTask(client, "produce the first result");
        assert.deepEqual(first.events.map((event) => payload(event).$case), [
            "task",
            "statusUpdate",
            "artifactUpdate",
            "statusUpdate",
        ]);
        const firstTerminal = payload(first.events.at(-1)!);
        assert.equal(firstTerminal.$case, "statusUpdate");
        if (firstTerminal.$case === "statusUpdate") {
            assert.equal(firstTerminal.value.status?.state, TaskState.TASK_STATE_COMPLETED);
        }

        const second = await runTask(client, "produce the second result", {
            contextId: first.task.contextId,
        });
        assert.notEqual(second.task.id, first.task.id);
        assert.equal(second.task.contextId, first.task.contextId);
        const stored = await client.getTask({ tenant: "", id: second.task.id, historyLength: 1 });
        assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(stored.artifacts[0]?.parts[0]?.content?.value, "second composed result");

        const interrupted = await runTask(client, "choose a branch", {
            contextId: first.task.contextId,
        });
        assert.deepEqual(interrupted.events.map((event) => payload(event).$case), [
            "task",
            "statusUpdate",
            "statusUpdate",
        ]);
        const inputRequired = payload(interrupted.events.at(-1)!);
        assert.equal(inputRequired.$case, "statusUpdate");
        if (inputRequired.$case === "statusUpdate") {
            assert.equal(inputRequired.value.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
            assert.equal(
                inputRequired.value.status?.message?.parts[0]?.content?.value,
                "Which branch should I use?",
            );
        }

        const continued = await runTask(client, "main", {
            contextId: interrupted.task.contextId,
            taskId: interrupted.task.id,
        });
        assert.equal(continued.task.id, interrupted.task.id);
        assert.equal(continued.task.contextId, interrupted.task.contextId);
        assert.deepEqual(continued.events.map((event) => payload(event).$case), [
            "task",
            "statusUpdate",
            "artifactUpdate",
            "statusUpdate",
        ]);
        const continuedTask = await client.getTask({
            tenant: "",
            id: interrupted.task.id,
            historyLength: 10,
        });
        assert.equal(continuedTask.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(continuedTask.artifacts[0]?.parts[0]?.content?.value, "selected branch");

        const listed = await client.listTasks({
            tenant: "",
            contextId: first.task.contextId,
            status: TaskState.TASK_STATE_UNSPECIFIED,
            pageSize: 2,
            pageToken: "",
            historyLength: 0,
            statusTimestampAfter: undefined,
            includeArtifacts: false,
        });
        assert.equal(listed.totalSize, 3);
        assert.equal(listed.tasks.length, 2);
        assert.notEqual(listed.nextPageToken, "");
        assert.ok(listed.tasks.every((task) => task.contextId === first.task.contextId));

        const context = await daemon.readWorker({
            workspaceId: workspace.workspaceId,
            identity: { name: first.task.contextId },
        });
        assert.ok(context !== null && context.origin === "model" && context.parentWorkerId === null);
        const tasks = await daemon.listWorkers(workspace.workspaceId, {
            origin: "model",
            parentWorkerId: context.id,
        });
        assert.deepEqual(
            tasks.map(({ name }) => name).toSorted(),
            [first.task.id, second.task.id, interrupted.task.id].toSorted(),
            "each A2A Task is one child Worker under its Context",
        );
        const secondWorker = tasks.find(({ name }) => name === second.task.id)!;
        const secondLog = await daemon.readLog({
            workspaceId: workspace.workspaceId,
            workerId: secondWorker.id,
            limit: 1_000,
        });
        assert.ok(
            secondLog.some((row) => row.source === `worker://${first.task.id}` && row.op === "SEND"),
            "the later Task inherits the first Task's pending terminal evidence through the Context snapshot",
        );
        assert.equal(provider.remaining, 0);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§a2a-inbound-exposure}: a fresh adapter reconstructs durable Context and Task ownership", async () => {
    const db = await openMigrated();
    let daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 100_000,
            responses: [makeMockResponse("## SEND0 [200]\nfirst durable result")],
        }),
    });
    const workspace = await daemon.createWorkspace({
        name: `a2a-restart-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    let firstListener: A2aModule | null = null;
    const firstExposure = A2aModule.init({
        workspaceId: workspace.workspaceId,
        card: a2aCard(),
        host: "127.0.0.1",
        port: 0,
    });
    daemon.registerModule({
        start: async (port) => {
            firstListener = await firstExposure.start(port);
            return firstListener;
        },
    });

    try {
        await daemon.start();
        assert.ok(firstListener !== null);
        const firstAddress = (firstListener as A2aModule).address();
        const firstClient = await connectHttpJsonAgent(
            `http://${firstAddress.host}:${firstAddress.port}`,
        );
        const first = await runTask(firstClient, "persist this result");
        const firstTerminal = payload(first.events.at(-1)!);
        assert.equal(firstTerminal.$case, "statusUpdate");
        if (firstTerminal.$case === "statusUpdate") {
            assert.equal(firstTerminal.value.status?.state, TaskState.TASK_STATE_COMPLETED);
        }

        await daemon.stop();
        daemon = new Daemon({
            db,
            provider: new Mock({
                contextWindow: 100_000,
                responses: [makeMockResponse("## SEND0 [200]\nsecond durable result")],
            }),
        });
        let secondListener: A2aModule | null = null;
        const secondExposure = A2aModule.init({
            workspaceId: workspace.workspaceId,
            card: a2aCard(),
            host: "127.0.0.1",
            port: 0,
        });
        daemon.registerModule({
            start: async (port) => {
                secondListener = await secondExposure.start(port);
                return secondListener;
            },
        });
        await daemon.start();
        assert.ok(secondListener !== null);
        const secondAddress = (secondListener as A2aModule).address();
        const secondClient = await connectHttpJsonAgent(
            `http://${secondAddress.host}:${secondAddress.port}`,
        );

        const recovered = await secondClient.getTask({
            tenant: "",
            id: first.task.id,
            historyLength: 10,
        });
        assert.equal(recovered.contextId, first.task.contextId);
        assert.equal(recovered.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(recovered.artifacts[0]?.parts[0]?.content?.value, "first durable result");

        const second = await runTask(secondClient, "continue this context", {
            contextId: first.task.contextId,
        });
        assert.notEqual(second.task.id, first.task.id);
        assert.equal(second.task.contextId, first.task.contextId);
        const roots = await daemon.listWorkers(workspace.workspaceId, {
            origin: "model",
            parentWorkerId: null,
        });
        assert.equal(roots.length, 1, "restart reuses the one durable Context root");
        const tasks = await daemon.listWorkers(workspace.workspaceId, {
            origin: "model",
            parentWorkerId: roots[0]!.id,
        });
        assert.deepEqual(
            tasks.map(({ name }) => name).toSorted(),
            [first.task.id, second.task.id].toSorted(),
            "the fresh adapter adds one child Task without adopting or duplicating the Context",
        );
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§a2a-inbound-exposure}: A2A cancellation settles the ordinary Task worker lifecycle", async () => {
    const db = await openMigrated();
    const provider = new BlockingMock();
    const daemon = new Daemon({ db, provider });
    const workspace = await daemon.createWorkspace({
        name: `a2a-cancel-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    const registration = A2aModule.init({
        workspaceId: workspace.workspaceId,
        card: a2aCard(),
        host: "127.0.0.1",
        port: 0,
    });
    let a2a: A2aModule | null = null;
    daemon.registerModule({
        start: async (port) => {
            a2a = await registration.start(port);
            return a2a;
        },
    });

    try {
        await daemon.start();
        assert.ok(a2a !== null);
        const address = (a2a as A2aModule).address();
        const client = await connectHttpJsonAgent(`http://${address.host}:${address.port}`);
        const states: TaskState[] = [];
        let task: Task | null = null;
        let cancellation: Promise<Task> | null = null;

        for await (const event of client.sendMessageStream(A2aMessage.request("wait for cancellation"))) {
            const current = payload(event);
            if (current.$case === "task") task = current.value;
            if (current.$case !== "statusUpdate" || current.value.status === undefined) continue;
            states.push(current.value.status.state);
            if (current.value.status.state === TaskState.TASK_STATE_WORKING) {
                assert.ok(task !== null, "the Task snapshot precedes its working status");
                await provider.started.promise;
                cancellation = client.cancelTask({ tenant: "", id: task.id, metadata: {} });
            }
        }

        assert.ok(task !== null);
        assert.ok(cancellation !== null, "the working Task issued one cancellation request");
        const canceled = await cancellation;
        assert.equal(canceled.id, task.id);
        assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
        assert.deepEqual(states, [
            TaskState.TASK_STATE_WORKING,
            TaskState.TASK_STATE_CANCELED,
        ]);
        const worker = await daemon.readWorker({
            workspaceId: workspace.workspaceId,
            identity: { name: task.id },
        });
        assert.ok(worker !== null);
        const loops = await daemon.listWorkerLoops({
            workspaceId: workspace.workspaceId,
            workerId: worker.id,
        });
        assert.equal(loops.at(-1)?.status, 499);
        assert.equal(loops.at(-1)?.terminalResult?.status, 499);
    } finally {
        await daemon.stop();
        await db.close();
    }
});

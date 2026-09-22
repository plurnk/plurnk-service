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
    OutboundModule,
} from "@plurnk/plurnk-a2a";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { A2A_EXPOSURE, a2aCard, bindListener, serviceUrl, streamPayload as payload } from "./_a2a.ts";
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

test("{§a2a-inbound-exposure}: an unrelated addressed reply is not an A2A artifact", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "[]" }));
    const workspace = await daemon.createWorkspace({ name: "a2a-reply-audience", projectRoot: null });
    const registration = A2aModule.init({
        workspace: { name: workspace.workspaceName, projectRoot: null }, card: a2aCard(),
        ...A2A_EXPOSURE,
    });
    let exposure: A2aModule | undefined;
    daemon.registerModule({ start: async (port) => { exposure = await registration.start(port); return exposure; } });
    let calls = 0;
    let protocolAddress = "";
    let unrelatedAddress = "";
    t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
        const [task] = (await daemon.listWorkers(workspace.workspaceId, { origin: "model" }))
            .filter((worker) => worker.parentWorkerId !== null);
        assert.ok(task);
        let program: string;
        if (calls++ === 0) {
            const [request] = await daemon.readMessages({ workspaceId: workspace.workspaceId, workerId: task.id });
            assert.ok(request?.source);
            protocolAddress = request.source;
            unrelatedAddress = `message://${task.name}/abcdef12`;
            await daemon.runLoop({ workspaceId: workspace.workspaceId, workerId: task.id,
                prompt: "An unrelated native request.", messageAddress: unrelatedAddress });
            program = "````NOTE\nObserve the new request before replying.\n````";
        } else if (calls === 2) {
            program = `\`\`\`\`SEND (${protocolAddress})\nThe A2A answer.\n\`\`\`\`\n\n\`\`\`\`SEND (${unrelatedAddress})\nThe unrelated answer.\n\`\`\`\``;
        } else {
            program = "````KILL\n````";
        }
        return new Mock({ contextWindow: 100_000, responses: [makeMockResponse(program)] }).generate(args);
    });
    try {
        await daemon.start();
        assert.ok(exposure);
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const { task } = await runTask(client, "Provide the A2A answer.");
        const retrieved = await client.getTask({ tenant: "", id: task.id, historyLength: 10 });
        const binding = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: task.id } });
        assert.ok(binding);
        assert.equal(retrieved.status?.state, TaskState.TASK_STATE_COMPLETED, JSON.stringify(retrieved));
        assert.equal(retrieved.artifacts[0]?.parts[0]?.content?.value, "The A2A answer.");
        assert.doesNotMatch(JSON.stringify(retrieved), /unrelated answer/);
        const messages = await daemon.readMessages({ workspaceId: workspace.workspaceId, workerId: binding.id });
        assert.deepEqual(messages.filter(({ direction }) => direction === "outbound").map(({ body, answers }) => ({ body, answers })), [
            { body: "The A2A answer.", answers: [protocolAddress] },
            { body: "The unrelated answer.", answers: [unrelatedAddress] },
        ]);
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-inbound-exposure}: the official A2A client drives Context and Task workers through ApplicationPort", async (testContext) => {
    const db = await openMigrated();
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````KILL\nfirst composed result\n````"),
            makeMockResponse("````KILL\nsecond composed result\n````"),
            makeMockResponse([
                "````question",
                "" + (JSON.stringify({
                    message: "Which branch should I use?",
                    requestedSchema: {
                        type: "object",
                        properties: { branch: { type: "string" } },
                        required: ["branch"],
                        additionalProperties: false,
                    },
                })) + "",
                "````",
                "````WAIT",
                "Waiting for the branch selection.",
                "````",
            ].join("\n")),
            makeMockResponse("````KILL\nselected branch\n````"),
            makeMockResponse("````KILL\nuppercase context result\n````"),
            makeMockResponse("````KILL\nlowercase context result\n````"),
        ],
    });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
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
        workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
        card: a2aCard(),
        ...A2A_EXPOSURE,
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
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const discovered = await client.getAgentCard();
        assert.equal(discovered.supportedInterfaces[0]?.protocolVersion, "1.0");
        assert.equal(discovered.supportedInterfaces[0]?.protocolBinding, "HTTP+JSON");
        assert.deepEqual(discovered.securitySchemes ?? {}, {}, "an exposure without a token declares no scheme");
        assert.deepEqual(discovered.securityRequirements ?? [], [], "an exposure without a token requires none");
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
        for (const id of [first.task.contextId, first.task.id]) {
            assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "SDK UUIDs remain directly addressable worker names");
        }
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
            secondLog.some((row) => row.source === `worker://${first.task.id}` && row.op === "READ"
                && JSON.stringify(row.rx).includes("first composed result")),
            "the later Task inherits the first Task's pending terminal evidence through the Context snapshot",
        );
        const namedContexts: number[] = [];
        for (const [contextId, result] of [
            ["Approach_A", "uppercase context result"],
            ["approach_a", "lowercase context result"],
        ] as const) {
            const named = await runTask(client, "produce a named context result", { contextId });
            assert.equal(named.task.contextId, contextId);
            const stored = await client.getTask({ tenant: "", id: named.task.id, historyLength: 1 });
            assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
            assert.equal(stored.artifacts[0]?.parts[0]?.content?.value, result);
            const context = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: contextId } });
            const task = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: named.task.id } });
            assert.ok(context !== null);
            assert.equal(context.name, contextId);
            assert.equal(task?.parentWorkerId, context.id, "the protocol Context and Task identities are the worker names verbatim");
            namedContexts.push(context.id);
        }
        assert.notEqual(namedContexts[0], namedContexts[1], "A2A Context identities remain case-sensitive");
        assert.equal(provider.remaining, 0);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
});

test("{§a2a-lazy-workspace}: discovery and Task observations are passive until first admitted work", async () => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 100_000,
            responses: [makeMockResponse("````KILL\nlazy workspace result\n````")],
        }),
        http,
    });
    const workspaceName = `a2a-lazy-${crypto.randomUUID()}`;
    const registration = A2aModule.init({
        workspace: { name: workspaceName, projectRoot: null },
        card: a2aCard(),
        ...A2A_EXPOSURE,
    });
    let listener: A2aModule | null = null;
    daemon.registerModule({
        start: async (port) => {
            listener = await registration.start(port);
            return listener;
        },
    });

    try {
        await daemon.start();
        assert.ok(listener !== null);
        assert.equal(
            (await daemon.listWorkspaces()).some(({ name }) => name === workspaceName),
            false,
            "listener startup does not create or hydrate its configured workspace",
        );
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        await client.getAgentCard();
        assert.equal(
            (await daemon.listWorkspaces()).some(({ name }) => name === workspaceName),
            false,
            "public Agent Card discovery remains passive",
        );

        const endpoint = (listener as A2aModule).agentCard().supportedInterfaces[0]!.url;
        for (const [path, expectedStatus] of [["/tasks", 200], ["/tasks/missing-task", 404]] as const) {
            const response = await fetch(`${endpoint}${path}`, { headers: { "a2a-version": "1.0" } });
            const result = await response.json();
            assert.equal(response.status, expectedStatus, JSON.stringify(result));
            if (expectedStatus === 200) assert.equal(result.totalSize, 0);
            else assert.equal(result.error.details[0].reason, "TASK_NOT_FOUND");
            assert.equal((await daemon.listWorkspaces()).some(({ name }) => name === workspaceName), false,
                `${path} does not create the exposure's workspace`);
        }
        const rejected = await fetch(`${endpoint}/message:send`, {
            method: "POST",
            headers: { "content-type": "application/a2a+json", "a2a-version": "1.0" },
            body: JSON.stringify({ message: {
                messageId: "unknown-task-answer", role: "ROLE_USER", taskId: "missing-task",
                parts: [{ text: "An answer for a task which does not exist." }],
            } }),
        });
        assert.equal(rejected.status, 404);
        assert.equal((await rejected.json()).error.details[0].reason, "TASK_NOT_FOUND");
        assert.equal((await daemon.listWorkspaces()).some(({ name }) => name === workspaceName), false,
            "a rejected follow-up is not admitted work");

        const completed = await runTask(client, "create the workspace only for real work");
        assert.equal(payload(completed.events.at(-1)!).$case, "statusUpdate");
        assert.equal(
            (await daemon.listWorkspaces()).filter(({ name }) => name === workspaceName).length,
            1,
            "the first task creates exactly one durable workspace",
        );
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
});

test("{§a2a-inbound-exposure}: a fresh adapter reconstructs durable Context and Task ownership", async () => {
    const db = await openMigrated();
    let http = await bindListener();
    let daemon = new Daemon({
        db,
        provider: new Mock({
            contextWindow: 100_000,
            responses: [makeMockResponse("````KILL\nfirst durable result\n````")],
        }),
        http,
    });
    const workspace = await daemon.createWorkspace({
        name: `a2a-restart-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    let firstListener: A2aModule | null = null;
    const firstExposure = A2aModule.init({
        workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
        card: a2aCard(),
        ...A2A_EXPOSURE,
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
        const firstClient = await connectHttpJsonAgent(serviceUrl(daemon));
        const first = await runTask(firstClient, "persist this result");
        const firstTerminal = payload(first.events.at(-1)!);
        assert.equal(firstTerminal.$case, "statusUpdate");
        if (firstTerminal.$case === "statusUpdate") {
            assert.equal(firstTerminal.value.status?.state, TaskState.TASK_STATE_COMPLETED);
        }

        await daemon.stop();
        await http.close();
        http = await bindListener();
        daemon = new Daemon({
            db,
            provider: new Mock({
                contextWindow: 100_000,
                responses: [makeMockResponse("````KILL\nsecond durable result\n````")],
            }),
            http,
        });
        let secondListener: A2aModule | null = null;
        const secondExposure = A2aModule.init({
            workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
            card: a2aCard(),
            ...A2A_EXPOSURE,
        });
        daemon.registerModule({
            start: async (port) => {
                secondListener = await secondExposure.start(port);
                return secondListener;
            },
        });
        await daemon.start();
        assert.ok(secondListener !== null);
        const secondClient = await connectHttpJsonAgent(serviceUrl(daemon));

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
        await http.close();
        await db.close();
    }
});

test("{§a2a-inbound-exposure}: A2A cancellation settles the ordinary Task worker lifecycle", async () => {
    const db = await openMigrated();
    const provider = new BlockingMock();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const workspace = await daemon.createWorkspace({
        name: `a2a-cancel-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    const registration = A2aModule.init({
        workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
        card: a2aCard(),
        ...A2A_EXPOSURE,
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
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
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
        const taskLoop = loops.find(({ prompt }) => prompt === "wait for cancellation");
        assert.equal(taskLoop?.status, 499);
        assert.equal(taskLoop?.terminalResult?.status, 499);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
});

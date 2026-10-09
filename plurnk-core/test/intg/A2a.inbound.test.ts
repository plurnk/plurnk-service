import assert from "node:assert/strict";
import test from "node:test";
import {
    ListTasksRequest,
    TaskState,
    type StreamResponse,
    type Task,
} from "@a2a-js/sdk";
import {
    A2aMessage,
    connectHttpJsonAgent,
    Exposure as A2aExposure,
    OutboundModule,
} from "@plurnk/plurnk-a2a";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { A2A_EXPOSURE, a2aCard, bindListener, serviceUrl, streamPayload as payload, A2A_MOUNTS } from "./_a2a.ts";
import { openMigrated } from "./_db.ts";
import { answer, makeMockResponse } from "./_mock.ts";
import { waitForDb } from "./_rpc.ts";
import { OperationFailureError } from "../../src/core/results.ts";

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

// {§a2a-inbound-exposure} A Task is the Loop its first message started; the message source names it.
const taskOf = (source: string | null): string | undefined => /\/tasks\/([^/]+)\/messages\//u.exec(source ?? "")?.[1];

const hostedDaemon = (options: ConstructorParameters<typeof Daemon>[0]): Daemon => {
    const daemon = new Daemon(options);
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    return daemon;
};

test("{§a2a-worker-ownership}: an absent configured parent cannot create an ownerless A2A Task", async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const http = await bindListener();
    const daemon = hostedDaemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-missing-parent", projectRoot: null });
    daemon.registerModule(A2aExposure.init({
        ...A2A_EXPOSURE, parentWorker: "absent",
        workspace: { name: workspaceName, projectRoot: null }, card: a2aCard(),
    }), "test-module");
    try {
        await daemon.start();
        const workers = await daemon.listWorkers(workspaceId);
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        await assert.rejects(runTask(client, "Do not create unowned work."),
            (error: unknown) => error instanceof Error && error.name === "RequestMalformedError"
                && /Configured A2A parent Worker 'absent' does not exist/u.test(error.message));
        assert.deepEqual(await daemon.listWorkers(workspaceId), workers);
        assert.equal((await client.listTasks(ListTasksRequest.fromJSON({}))).totalSize, 0, "a refused admission fabricates no Task");
        assert.equal(provider.received.length, 0);
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-worker-ownership}: the parent owner approves operations and answers questions; the caller only converses", async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("````sh\necho approved-by-owner\n````"),
        makeMockResponse("````question\n" + JSON.stringify({ message: "Which branch?", requestedSchema: {
            type: "object", properties: { branch: { type: "string" } }, required: ["branch"], additionalProperties: false,
        } }) + "\n````"),
        answer("The owner selected main."),
    ] });
    const http = await bindListener();
    const daemon = hostedDaemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-owned-parent", projectRoot: null });
    const owner = { address: "agui://operator", tools: ["request_approval", "question"], interactive: true };
    await daemon.registerWorkerOwner(workspaceId, owner);
    const parent = await daemon.createConversationWorker({ workspaceId, name: "operator", owner: owner.address });
    daemon.registerModule(A2aExposure.init({
        ...A2A_EXPOSURE, parentWorker: parent.workerName,
        workspace: { name: workspaceName, projectRoot: null }, card: a2aCard(),
    }), "test-module");
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const running = runTask(client, "Run the command, ask which branch, and report the answer.");
        const [proposal] = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
        assert.equal(proposal!.owner, owner.address);
        await daemon.resolveProposal(proposal!.logEntryId, { decision: "accept" }, { workspaceId, address: owner.address });
        const [interaction] = await waitForDb(() => daemon.pendingClientInteractions(workspaceId), (items) => items.length === 1);
        assert.equal(interaction!.recipient, owner.address, "the Task's question goes to its owner, never the A2A caller");
        await assert.rejects(daemon.resolveClientInteraction(interaction!.interactionId,
            { status: "resolved", payload: { branch: "wrong-authority" } }, { workspaceId, address: "a2a://anonymous/caller" }),
        (error: unknown) => error instanceof OperationFailureError && error.result.problem.type.endsWith("/recipient-mismatch"));
        await daemon.resolveClientInteraction(interaction!.interactionId,
            { status: "resolved", payload: { branch: "main" } }, { workspaceId, address: owner.address });
        const answered = await running;
        const states = answered.events.flatMap((event) => {
            const update = payload(event);
            return update.$case === "statusUpdate" ? [update.value.status?.state] : [];
        });
        assert.ok(!states.includes(TaskState.TASK_STATE_INPUT_REQUIRED), "an A2A Task never asks its caller for structured input");
        assert.equal(states.at(-1), TaskState.TASK_STATE_COMPLETED);
        const taskWorker = await daemon.readWorker({ workspaceId, identity: { name: answered.task.id } });
        assert.equal(taskWorker?.parentWorkerId, parent.workerId);
        assert.equal(taskWorker?.owner, owner.address, "the Task inherits the configured parent's approval owner");
        assert.deepEqual(await daemon.pendingClientInteractions(workspaceId), []);
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-inbound-exposure}: an unrelated addressed reply is not an A2A artifact", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const http = await bindListener();
    const daemon = hostedDaemon({ db, provider, http });
    const workspace = await daemon.createWorkspace({ name: "a2a-reply-audience", projectRoot: null });
    const registration = A2aExposure.init({
        workspace: { name: workspace.workspaceName, projectRoot: null }, card: a2aCard(),
        ...A2A_EXPOSURE,
    });
    let exposure: A2aExposure | undefined;
    daemon.registerModule({ mounts: A2A_MOUNTS, start: async (port) => { exposure = await registration.start(port); return exposure; } }, "test-module");
    let calls = 0;
    let protocolAddress = "";
    let unrelatedAddress = "";
    t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
        const context = (await daemon.listWorkers(workspace.workspaceId, { origin: "model" }))
            .toSorted((left, right) => right.id - left.id)[0];
        assert.ok(context);
        let response: ReturnType<typeof makeMockResponse>;
        if (calls++ === 0) {
            const [request] = await daemon.readMessages({ workspaceId: workspace.workspaceId, workerId: context.id });
            assert.ok(request?.source);
            protocolAddress = request.source;
            unrelatedAddress = `message://${context.name}/abcdef12`;
            await daemon.runLoop({ workspaceId: workspace.workspaceId, workerId: context.id,
                prompt: "An unrelated native request.", messageAddress: unrelatedAddress });
            response = makeMockResponse("````NOTE\nObserve the new request before replying.\n````");
        } else if (calls === 2) {
            response = makeMockResponse(`\`\`\`\`SEND (${protocolAddress})\nThe A2A answer.\n\`\`\`\`\n\n\`\`\`\`SEND (${unrelatedAddress})\nThe unrelated answer.\n\`\`\`\``);
        } else {
            response = answer("");
        }
        return new Mock({ contextWindow: 100_000, responses: [response] }).generate(args);
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

test("{§a2a-inbound-exposure}: the official A2A client drives Task workers through ApplicationPort", async () => {
    const db = await openMigrated();
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            answer("first composed result"),
            answer("second composed result"),
            answer("Which branch should I use?"),
            answer("selected branch"),
            answer("uppercase context result"),
            answer("lowercase context result"),
        ],
    });
    const http = await bindListener();
    const daemon = hostedDaemon({ db, provider, http });
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
    const registration = A2aExposure.init({
        workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
        card: a2aCard(),
        ...A2A_EXPOSURE,
    });
    let a2a: A2aExposure | null = null;
    daemon.registerModule({
        mounts: A2A_MOUNTS,
        start: async (port) => {
            a2a = await registration.start(port);
            return a2a;
        },
    }, "test-module");

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
        const first = await runTask(client, "produce the first result");
        for (const id of [first.task.contextId, first.task.id]) {
            assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "server UUIDs remain directly addressable worker names");
        }
        assert.equal(first.events.filter((event) => payload(event).$case === "task").length, 1);
        assert.ok([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_COMPLETED].includes(first.task.status!.state));
        const artifact = first.events.map(payload).find((event) => event.$case === "artifactUpdate");
        const result = first.task.artifacts[0] ?? (artifact?.$case === "artifactUpdate" ? artifact.value.artifact : undefined);
        assert.equal(result?.parts[0]?.content?.value, "first composed result");
        const firstTerminal = payload(first.events.at(-1)!);
        assert.ok(firstTerminal.$case === "statusUpdate" || firstTerminal.$case === "task");
        assert.equal(firstTerminal.value.status?.state, TaskState.TASK_STATE_COMPLETED);

        const second = await runTask(client, "produce the second result", {
            contextId: first.task.contextId,
        });
        assert.notEqual(second.task.id, first.task.id);
        assert.equal(second.task.contextId, first.task.contextId);
        const stored = await client.getTask({ tenant: "", id: second.task.id, historyLength: 1 });
        assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(stored.artifacts[0]?.parts[0]?.content?.value, "second composed result");

        // {§a2a-worker-ownership} A question to the caller is a reply: its Task completes with it,
        // and the answer arrives as a later Task in the same Context.
        const asked = await runTask(client, "choose a branch", {
            contextId: first.task.contextId,
        });
        const askedTask = await client.getTask({ tenant: "", id: asked.task.id, historyLength: 1 });
        assert.equal(askedTask.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(askedTask.artifacts[0]?.parts[0]?.content?.value, "Which branch should I use?");

        const answered = await runTask(client, "main", {
            contextId: asked.task.contextId,
        });
        assert.notEqual(answered.task.id, asked.task.id);
        assert.equal(answered.task.contextId, asked.task.contextId);
        const answeredTask = await client.getTask({
            tenant: "",
            id: answered.task.id,
            historyLength: 10,
        });
        assert.equal(answeredTask.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(answeredTask.artifacts[0]?.parts[0]?.content?.value, "selected branch");

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
        assert.equal(listed.totalSize, 4);
        assert.equal(listed.tasks.length, 2);
        assert.notEqual(listed.nextPageToken, "");
        assert.ok(listed.tasks.every((task) => task.contextId === first.task.contextId));

        const firstWorker = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: first.task.id } });
        assert.ok(firstWorker?.parentWorkerId);
        const runtime = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { id: firstWorker.parentWorkerId } });
        assert.equal(runtime?.origin, "_plurnk");
        assert.equal(firstWorker.owner, "_plurnk");
        const children = await daemon.listWorkers(workspace.workspaceId, { origin: "model", parentWorkerId: runtime!.id });
        assert.deepEqual(children.map(({ name }) => name).toSorted(), [first.task.id, second.task.id, asked.task.id, answered.task.id].toSorted());
        for (const child of children) {
            const loops = await daemon.listWorkerLoops({ workspaceId: workspace.workspaceId, workerId: child.id });
            assert.deepEqual(loops.map(({ promptSource }) => taskOf(promptSource)), [child.name]);
        }
        // {§a2a-inbound-exposure} One conversation: the follow-up sees the request behind its question.
        const followUp = provider.received[3]!.map(chatMessageText).join("\n");
        assert.ok(followUp.includes("choose a branch"), "the follow-up Task sees the caller's earlier request");
        assert.ok(followUp.includes("Which branch should I use?"), "and the question it answers");
        const namedTasks: string[] = [];
        for (const [contextId, result] of [
            ["Approach_A", "uppercase context result"],
            ["approach_a", "lowercase context result"],
        ] as const) {
            const named = await runTask(client, "produce a named context result", { contextId });
            assert.equal(named.task.contextId, contextId);
            const stored = await client.getTask({ tenant: "", id: named.task.id, historyLength: 1 });
            assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
            assert.equal(stored.artifacts[0]?.parts[0]?.content?.value, result);
            const worker = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: named.task.id } });
            assert.ok(worker?.parentWorkerId);
            const loops = await daemon.listWorkerLoops({ workspaceId: workspace.workspaceId, workerId: worker.id });
            assert.deepEqual(loops.map(({ promptSource }) => taskOf(promptSource)), [named.task.id]);
            const listed = await client.listTasks(ListTasksRequest.fromJSON({ contextId }));
            assert.deepEqual(listed.tasks.map(({ id }) => id), [named.task.id], "Context filters are case-sensitive");
            namedTasks.push(named.task.id);
        }
        assert.notEqual(namedTasks[0], namedTasks[1]);
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
    const daemon = hostedDaemon({
        db,
        provider: new Mock({
            contextWindow: 100_000,
            responses: [answer("lazy workspace result")],
        }),
        http,
    });
    const workspaceName = `a2a-lazy-${crypto.randomUUID()}`;
    const registration = A2aExposure.init({
        workspace: { name: workspaceName, projectRoot: null },
        card: a2aCard(),
        ...A2A_EXPOSURE,
    });
    let listener: A2aExposure | null = null;
    daemon.registerModule({
        mounts: A2A_MOUNTS,
        start: async (port) => {
            listener = await registration.start(port);
            return listener;
        },
    }, "test-module");

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

        const endpoint = (listener as A2aExposure).agentCard().supportedInterfaces[0]!.url;
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

test("{§a2a-worker-ownership}: restart retains Tasks while a changed parent applies only to new work", async () => {
    const db = await openMigrated();
    let http = await bindListener();
    let daemon = hostedDaemon({
        db,
        provider: new Mock({
            contextWindow: 100_000,
            responses: [answer("first durable result")],
        }),
        http,
    });
    const workspace = await daemon.createWorkspace({
        name: `a2a-restart-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    const owner = { address: "agui://supervisor", tools: ["request_approval"], interactive: true };
    await daemon.registerWorkerOwner(workspace.workspaceId, owner);
    const parent = await daemon.createConversationWorker({ workspaceId: workspace.workspaceId, name: "supervisor", owner: owner.address });
    let firstListener: A2aExposure | null = null;
    const firstExposure = A2aExposure.init({
        workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
        card: a2aCard(),
        ...A2A_EXPOSURE,
    });
    daemon.registerModule({
        mounts: A2A_MOUNTS,
        start: async (port) => {
            firstListener = await firstExposure.start(port);
            return firstListener;
        },
    }, "test-module");

    try {
        await daemon.start();
        assert.ok(firstListener !== null);
        const firstClient = await connectHttpJsonAgent(serviceUrl(daemon));
        const first = await runTask(firstClient, "persist this result");
        const firstWorker = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: first.task.id } });
        assert.equal(firstWorker?.owner, "_plurnk");
        const firstTerminal = payload(first.events.at(-1)!);
        assert.equal(firstTerminal.$case, "statusUpdate");
        if (firstTerminal.$case === "statusUpdate") {
            assert.equal(firstTerminal.value.status?.state, TaskState.TASK_STATE_COMPLETED);
        }

        await daemon.stop();
        await http.close();
        http = await bindListener();
        daemon = hostedDaemon({
            db,
            provider: new Mock({
                contextWindow: 100_000,
                responses: [answer("second durable result")],
            }),
            http,
        });
        let secondListener: A2aExposure | null = null;
        const secondExposure = A2aExposure.init({
            workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
            card: a2aCard(),
            ...A2A_EXPOSURE,
            parentWorker: parent.workerName,
        });
        daemon.registerModule({
            mounts: A2A_MOUNTS,
            start: async (port) => {
                secondListener = await secondExposure.start(port);
                return secondListener;
            },
        }, "test-module");
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
        assert.deepEqual(await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: first.task.id } }), firstWorker,
            "existing Task ownership and parent survive changed configuration");
        const newWorker = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: second.task.id } });
        assert.equal(newWorker?.parentWorkerId, parent.workerId);
        assert.equal(newWorker?.owner, owner.address);
        assert.deepEqual((await daemon.listWorkers(workspace.workspaceId, { origin: "model" })).map(({ name }) => name).toSorted(),
            [parent.workerName, first.task.id, second.task.id].toSorted(), "Context continuity creates no extra Worker");
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
});

test("{§a2a-inbound-exposure}: A2A cancellation settles the Task's ordinary Loop lifecycle", async () => {
    const db = await openMigrated();
    const provider = new BlockingMock();
    const http = await bindListener();
    const daemon = hostedDaemon({ db, provider, http });
    const workspace = await daemon.createWorkspace({
        name: `a2a-cancel-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    const registration = A2aExposure.init({
        workspace: { name: workspace.workspaceName, projectRoot: workspace.projectRoot },
        card: a2aCard(),
        ...A2A_EXPOSURE,
    });
    let a2a: A2aExposure | null = null;
    daemon.registerModule({
        mounts: A2A_MOUNTS,
        start: async (port) => {
            a2a = await registration.start(port);
            return a2a;
        },
    }, "test-module");

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
            const status = current.$case === "task" || current.$case === "statusUpdate" ? current.value.status : undefined;
            if (status === undefined) continue;
            states.push(status.state);
            if (status.state === TaskState.TASK_STATE_WORKING && cancellation === null) {
                assert.ok(task !== null, "the Task snapshot precedes cancellation");
                await provider.started.promise;
                cancellation = client.cancelTask({ tenant: "", id: task.id, metadata: {} });
            }
        }

        assert.ok(task !== null);
        assert.ok(cancellation !== null, "the working Task issued one cancellation request");
        const canceled = await cancellation;
        assert.equal(canceled.id, task.id);
        assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
        assert.ok(states.includes(TaskState.TASK_STATE_WORKING));
        assert.equal(states.at(-1), TaskState.TASK_STATE_CANCELED);
        assert.ok(states.every((state) => [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_CANCELED].includes(state)));
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

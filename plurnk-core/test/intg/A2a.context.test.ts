import assert from "node:assert/strict";
import test from "node:test";
import { ListTasksRequest, SendMessageRequest, TaskState, type Task } from "@a2a-js/sdk";
import { A2aMessage, connectHttpJsonAgent, Exposure, OutboundModule } from "@plurnk/plurnk-a2a";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Daemon from "../../src/server/Daemon.ts";
import { holdChild, openMigrated } from "./_db.ts";
import { answer, makeMockResponse, parseDsl } from "./_mock.ts";
import { A2A_EXPOSURE, a2aCard, bindListener, serviceUrl, streamPayload } from "./_a2a.ts";
import { waitForDb } from "./_rpc.ts";

const observe = (client: Awaited<ReturnType<typeof connectHttpJsonAgent>>, text: string, contextId?: string) => {
    const admitted = Promise.withResolvers<Task>();
    const result = (async () => {
        let id = "";
        for await (const event of client.sendMessageStream(A2aMessage.request(text, { contextId }))) {
            const payload = streamPayload(event);
            if (payload.$case === "task") { id = payload.value.id; admitted.resolve(payload.value); }
        }
        return client.getTask({ tenant: "", id, historyLength: 100 });
    })();
    void result.catch(admitted.reject);
    return { admitted: admitted.promise, result };
};

test("{§a2a-inbound-exposure}: same-Context Tasks finish and cancel independently", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const firstCall = Promise.withResolvers<void>();
    const thirdCall = Promise.withResolvers<AbortSignal>();
    const finishThird = Promise.withResolvers<void>();
    let calls = 0;
    t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
        const call = calls++;
        if (call === 2) {
            assert.ok(args.signal);
            thirdCall.resolve(args.signal);
            await finishThird.promise;
            args.signal.throwIfAborted();
        }
        if (call > 0) return new Mock({ contextWindow: 100_000, responses: [answer("independent result")] }).generate(args);
        firstCall.resolve();
        assert.ok(args.signal);
        await new Promise<void>((_resolve, reject) => {
            args.signal!.addEventListener("abort", () => reject(args.signal!.reason), { once: true });
            args.signal!.throwIfAborted();
        });
        throw new Error("the cancelled provider call must not resume");
    });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-independent", projectRoot: null });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const first = observe(client, "Keep the first Task in flight.");
        const a = await first.admitted;
        await firstCall.promise;
        const second = observe(client, "Complete independently.", a.contextId);
        const b = await second.admitted;
        assert.notEqual(a.id, b.id);
        const completed = await second.result;
        assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(completed.artifacts[0]?.parts[0]?.content?.value, "independent result");
        assert.equal((await client.getTask({ tenant: "", id: a.id })).status?.state, TaskState.TASK_STATE_WORKING);
        const aWorker = await daemon.readWorker({ workspaceId, identity: { name: a.id } });
        const bWorker = await daemon.readWorker({ workspaceId, identity: { name: b.id } });
        assert.ok(aWorker && bWorker);
        assert.notEqual(aWorker.id, bWorker.id);
        assert.equal(aWorker.parentWorkerId, bWorker.parentWorkerId);
        assert.equal(aWorker.parentWorkerId, await daemon.ensureRuntimeWorker(workspaceId));
        assert.deepEqual((await daemon.listWorkers(workspaceId, { origin: "model" })).map(({ name }) => name).toSorted(),
            [a.id, b.id].toSorted(), "Context identity creates no extra Worker");
        const third = observe(client, "Keep another sibling in flight.", a.contextId);
        const c = await third.admitted;
        const signal = await thirdCall.promise;
        await client.cancelTask({ tenant: "", id: a.id, metadata: {} });
        assert.equal((await first.result).status?.state, TaskState.TASK_STATE_CANCELED);
        assert.equal((await client.getTask({ tenant: "", id: b.id })).status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal((await client.getTask({ tenant: "", id: c.id })).status?.state, TaskState.TASK_STATE_WORKING);
        assert.equal(signal.aborted, false, "cancellation does not abort a sibling's in-flight inference");
        finishThird.resolve();
        assert.equal((await third.result).status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(calls, 3);
    } finally { finishThird.resolve(); await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-context-resource}: a fresh Task READs the caller's request and the answer without inheriting its log", async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [answer("Which branch should I use?"), answer("main selected")] });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-conversation", projectRoot: null });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const first = await observe(client, "Please compare the deployment branches.", "session/部署 one").result;
        const second = await observe(client, "Use main.", first.contextId).result;
        assert.equal(second.status?.state, TaskState.TASK_STATE_COMPLETED);
        const packet = provider.received[1]!.map(chatMessageText).join("\n");
        assert.match(packet, /Please compare the deployment branches\./u);
        assert.match(packet, /Which branch should I use\?/u);
        assert.match(packet, /a2a:\/\/anonymous\/contexts\/session%2F%E9%83%A8%E7%BD%B2%20one/u);
        const worker = await daemon.readWorker({ workspaceId, identity: { name: second.id } });
        assert.ok(worker);
        const loops = await daemon.listWorkerLoops({ workspaceId, workerId: worker.id });
        assert.equal(loops.length, 1, "WORK does not inherit an earlier Task's execution history");
        const messages = await daemon.readMessages({ workspaceId, workerId: worker.id });
        assert.deepEqual(messages.filter(({ direction }) => direction === "inbound").map(({ body }) => body), ["Use main."], "history is READ evidence, not new inbox obligations");
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-inbound-exposure}: a parked Task's child obligation neither blocks nor wakes its sibling", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse(PlurnkParser.frame("WAIT", null)), answer("unrelated work completed"),
    ] });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-parked-sibling", projectRoot: null });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    const runLoop = daemon.runLoop.bind(daemon);
    t.mock.method(daemon, "runLoop", async (args: Parameters<Daemon["runLoop"]>[0]) => {
        if (args.prompt === "Wait for the held child.") await holdChild(db, workspaceId, args.workerId);
        return runLoop(args);
    });
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const waiting = observe(client, "Wait for the held child.");
        const first = await waiting.admitted;
        const worker = await daemon.readWorker({ workspaceId, identity: { name: first.id } });
        assert.ok(worker);
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: worker.id }),
            (loops) => loops.length === 1 && loops[0]!.status === 202);
        const sibling = await observe(client, "Complete unrelated work.", first.contextId).result;
        assert.equal(sibling.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId: worker.id }))[0]!.status, 202);
        assert.equal((await client.getTask({ tenant: "", id: first.id })).status?.state, TaskState.TASK_STATE_WORKING);
        await client.cancelTask({ tenant: "", id: first.id, metadata: {} });
        assert.equal((await waiting.result).status?.state, TaskState.TASK_STATE_CANCELED);
        assert.equal((await client.getTask({ tenant: "", id: sibling.id })).status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(provider.received.length, 2, "sibling completion does not restart the parked Task");
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-inbound-exposure}: a Context ID cannot adopt an existing model Worker", async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [answer("independent conversation")] });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-context-name", projectRoot: null });
    const existing = await daemon.createConversationWorker({ workspaceId, name: "existing" });
    const before = await daemon.readWorker({ workspaceId, identity: { id: existing.workerId } });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const task = await observe(client, "Start a separate conversation.", existing.workerName).result;
        assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
        const worker = await daemon.readWorker({ workspaceId, identity: { name: task.id } });
        assert.ok(worker?.parentWorkerId);
        assert.notEqual(worker.parentWorkerId, existing.workerId);
        assert.deepEqual(await daemon.readWorker({ workspaceId, identity: { id: existing.workerId } }), before);
        assert.deepEqual(await daemon.listWorkerLoops({ workspaceId, workerId: existing.workerId }), []);
        assert.deepEqual(await daemon.readMessages({ workspaceId, workerId: existing.workerId }), []);
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-inbound-exposure}: a continuation crossing completion cannot reopen its Task", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const firstCall = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
        if (calls++ === 0) { firstCall.resolve(); await finish.promise; }
        return new Mock({ contextWindow: 100_000, responses: [answer("original result")] }).generate(args);
    });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-terminal-admission", projectRoot: null });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    const entering = Promise.withResolvers<void>();
    const deliver = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const runLoop = daemon.runLoop.bind(daemon);
    t.mock.method(daemon, "runLoop", async (args: Parameters<Daemon["runLoop"]>[0]) => {
        if (args.prompt === "late detail") { entering.resolve(); await deliver.promise; }
        try { return await runLoop(args); }
        finally { if (args.prompt === "late detail") delivered.resolve(); }
    });
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const first = observe(client, "Finish after the controlled admission boundary.");
        const task = await first.admitted;
        await firstCall.promise;
        const continuation = (async () => {
            const events = [];
            for await (const event of client.sendMessageStream(A2aMessage.request("late detail", { taskId: task.id, contextId: task.contextId }))) events.push(event);
            return events;
        })().then((events) => ({ events }), (error: unknown) => ({ error }));
        await entering.promise;
        finish.resolve();
        assert.equal((await first.result).status?.state, TaskState.TASK_STATE_COMPLETED);
        deliver.resolve();
        await delivered.promise;
        const refused = await continuation;
        assert.ok("error" in refused, "a late continuation is a request refusal, not a fabricated failed Task");
        assert.match(String(refused.error), /terminal|finished|unfinished/u);
        const worker = await daemon.readWorker({ workspaceId, identity: { name: task.id } });
        assert.ok(worker);
        assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId: worker.id })).length, 1, "a terminal Task never acquires a second execution Loop");
        assert.equal(calls, 1, "the refused continuation invokes no model");
        const stored = await client.getTask({ tenant: "", id: task.id });
        assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
        assert.equal(stored.history.length, 1, "the refused message is not admitted history");
    } finally { finish.resolve(); deliver.resolve(); await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-task-observation}: overlapping streams continue one Task without sharing response lifecycle", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
        if (calls++ === 0) { entered.resolve(); await release.promise; }
        return new Mock({ contextWindow: 100_000, responses: [answer("combined result")] }).generate(args);
    });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-overlap", projectRoot: null });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const collect = (request: SendMessageRequest) => {
            const admitted = Promise.withResolvers<Task>();
            const done = (async () => {
                const events = [];
                for await (const event of client.sendMessageStream(request)) {
                    const payload = streamPayload(event);
                    events.push(payload);
                    if (payload.$case === "task") admitted.resolve(payload.value);
                }
                return events;
            })();
            void done.catch(admitted.reject);
            // Observe rejection immediately, including failure of the first stream while the second admits.
            const result = done.then((events) => ({ events }), (error: unknown) => ({ error }));
            return { admitted: admitted.promise, result };
        };
        const first = collect(A2aMessage.request("Initial assignment"));
        const task = await first.admitted;
        await entered.promise;
        const second = collect(A2aMessage.request("Additional detail", { taskId: task.id, contextId: task.contextId }));
        assert.equal((await second.admitted).id, task.id);
        release.resolve();
        for (const response of await Promise.all([first.result, second.result])) {
            assert.ok("events" in response, "each response remains a valid independent A2A lifecycle stream");
            assert.equal(response.events.filter(({ $case }) => $case === "task").length, 1);
            assert.equal(response.events[0]?.$case, "task");
            const final = response.events.at(-1);
            assert.equal(final?.$case, "statusUpdate");
            assert.equal(final?.$case === "statusUpdate" && final.value.status?.state, TaskState.TASK_STATE_COMPLETED);
        }
        const final = await client.getTask({ tenant: "", id: task.id });
        assert.equal(final.history.length, 2);
        assert.equal(final.artifacts[0]?.parts[0]?.content?.value, "combined result");
        const worker = await daemon.readWorker({ workspaceId, identity: { name: task.id } });
        assert.ok(worker);
        assert.equal((await daemon.listWorkerLoops({ workspaceId, workerId: worker.id })).length, 1);
        assert.equal(calls, 2, "the arrival defers completion in the same ordinary Loop");
    } finally { release.resolve(); await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-task-observation}: completion winning cancellation remains completed on the wire and in storage", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [answer("completed before cancellation")] });
    const finish = Promise.withResolvers<void>();
    const generate = provider.generate.bind(provider);
    t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
        await finish.promise;
        return generate(args);
    });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-cancel-completion", projectRoot: null });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    const entering = Promise.withResolvers<void>();
    const cancel = Promise.withResolvers<void>();
    const cancelWorker = daemon.cancelWorker.bind(daemon);
    t.mock.method(daemon, "cancelWorker", async (args: Parameters<Daemon["cancelWorker"]>[0]) => {
        entering.resolve();
        await cancel.promise;
        return cancelWorker(args);
    });
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const running = observe(client, "Complete at the controlled cancellation boundary.");
        const task = await running.admitted;
        const request = client.cancelTask({ tenant: "", id: task.id, metadata: {} })
            .then((value) => ({ value }), (error: unknown) => ({ error }));
        await entering.promise;
        finish.resolve();
        const completed = await running.result;
        assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
        cancel.resolve();
        const refused = await request;
        assert.ok("error" in refused && refused.error instanceof Error);
        assert.equal(refused.error.name, "TaskNotCancelableError");
        assert.deepEqual(await client.getTask({ tenant: "", id: task.id, historyLength: 100 }), completed);
        const worker = await daemon.readWorker({ workspaceId, identity: { name: task.id } });
        assert.ok(worker);
        assert.deepEqual((await daemon.listWorkerLoops({ workspaceId, workerId: worker.id })).map(({ status }) => status), [200]);
        assert.equal(provider.received.length, 1);
    } finally { finish.resolve(); cancel.resolve(); await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-inbound-exposure}: simultaneous first Tasks share only their opaque Context identity", async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const finish = Promise.withResolvers<void>();
    t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
        await finish.promise;
        return new Mock({ contextWindow: 100_000, responses: [answer("independent result")] }).generate(args);
    });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: "a2a-concurrent-admission", projectRoot: null } }), "test-module");
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        const pending = [observe(client, "First task", "shared"), observe(client, "Second task", "shared")];
        const tasks = await Promise.all(pending.map(({ admitted }) => admitted));
        assert.notEqual(tasks[0]!.id, tasks[1]!.id);
        const workspaces = await daemon.listWorkspaces();
        assert.equal(workspaces.length, 1, "concurrent admission resolves one workspace");
        const workspaceId = workspaces[0]!.id;
        const workers = await daemon.listWorkers(workspaceId, { origin: "model" });
        assert.deepEqual(workers.map(({ name }) => name).toSorted(), tasks.map(({ id }) => id).toSorted());
        const parentId = await daemon.ensureRuntimeWorker(workspaceId);
        assert.ok(workers.every(({ parentWorkerId }) => parentWorkerId === parentId));
        assert.equal((await client.listTasks(ListTasksRequest.fromJSON({ contextId: "shared" }))).totalSize, 2);
        finish.resolve();
        assert.deepEqual((await Promise.all(pending.map(({ result }) => result))).map(({ status }) => status?.state),
            [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_COMPLETED]);
    } finally { finish.resolve(); await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-context-resource}: conversation and exact attachment bytes survive curation without exposing working internals", async () => {
    const frame = PlurnkParser.frame;
    const contextId = "retained-evidence";
    const address = `a2a://anonymous/contexts/${contextId}`;
    const bytes = Buffer.from([0, 1, 2, 255]);
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse([frame("NOTE", "private-exploration-marker"), frame("SEND", "intermediate-retained-reply")].join("\n\n")),
        makeMockResponse([frame("KILL (log:///*/*/*/*)", null), frame("SEND [200]", "first-retained-answer")].join("\n\n")),
        makeMockResponse(frame(`READ (${address}) <1,-1>`, null)),
        answer("second-retained-answer"),
    ] });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-retained", projectRoot: null });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    try {
        await daemon.start();
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        let taskId: string | undefined;
        const request = A2aMessage.request("first-retained-request", { contextId }, [{ name: "sample.bin", mediaType: "application/octet-stream", bytes }]);
        for await (const event of client.sendMessageStream(request)) {
            const payload = streamPayload(event);
            if (payload.$case === "task") taskId = payload.value.id;
        }
        assert.ok(taskId);
        const first = await daemon.readWorker({ workspaceId, identity: { name: taskId } });
        assert.ok(first);
        assert.equal((await client.getTask({ tenant: "", id: taskId })).status?.state, TaskState.TASK_STATE_COMPLETED);
        const second = await observe(client, "second-retained-request", contextId).result;
        const worker = await daemon.readWorker({ workspaceId, identity: { name: second.id } });
        assert.ok(worker);
        const packet = provider.received.at(-1)!.map(chatMessageText).join("\n");
        assert.match(packet, /first-retained-request/u);
        assert.match(packet, /intermediate-retained-reply/u);
        assert.match(packet, /first-retained-answer/u);
        assert.doesNotMatch(packet, /private-exploration-marker/u, "a Context is conversation evidence, not an ambient log dump");
        const read = async (target: string) => daemon.look({ workspaceId, workerId: worker.id, statement: parseDsl(frame(`READ (${target}) <1,-1>`, null))[0]! });
        const context = await read(`${address}#json`);
        assert.equal(context.status, 200);
        const json = JSON.parse(context.content as string) as { tasks: Array<{ id: string; history: Array<{ role: string; parts: Array<{ raw?: string; resource?: string; bytes?: number }> }> }> };
        assert.deepEqual(json.tasks.map(({ id }) => id), [second.id, taskId], "newer Tasks come first without reordering messages within a Task");
        const attachment = json.tasks[1]!.history[0]!.parts[1]!;
        assert.equal(attachment.raw, undefined);
        assert.equal(attachment.bytes, bytes.length);
        assert.ok(attachment.resource?.startsWith(`${address}/messages/`));
        const retained = await read(`${attachment.resource}#bytes`);
        assert.equal(retained.status, 200);
        assert.equal(retained.content, "00\n01\n02\nff", "the ordinary byte channel preserves the exact retained Part");
        const refreshed = await read(address);
        assert.equal(refreshed.status, 200);
        assert.match(refreshed.content as string, /second-retained-answer/u, "READ refreshes completed replies without a second conversation store");
        const stranger = await daemon.createWorkspace({ name: "unrelated-a2a-workspace", projectRoot: null });
        const strangerWorker = await daemon.ensureModelWorker(stranger.workspaceId);
        const absent = await daemon.look({ workspaceId: stranger.workspaceId, workerId: strangerWorker, statement: parseDsl(frame(`READ (${address})`, null))[0]! });
        assert.equal(absent.status, 404, "the retained Context belongs to the hosted workspace");
        const messages = await daemon.readMessages({ workspaceId, workerId: worker.id });
        assert.deepEqual(messages.filter(({ direction }) => direction === "inbound").map(({ body }) => body), ["second-retained-request"]);
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

test("{§a2a-inbound-exposure}: retained shared-Worker Tasks stay addressable without becoming new Tasks' execution ancestors", async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [answer("earlier answer"), answer("later answer"), answer("fresh answer")] });
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http });
    const { workspaceId, workspaceName } = await daemon.createWorkspace({ name: "a2a-retained-topology", projectRoot: null });
    const parentWorkerId = await daemon.ensureRuntimeWorker(workspaceId);
    const contextId = crypto.randomUUID();
    const retained = await daemon.createConversationWorker({ workspaceId, parentWorkerId, name: contextId });
    daemon.registerModule(OutboundModule.init({ PLURNK_A2A_ENABLED: "1" }), "@plurnk/plurnk-a2a");
    daemon.registerModule(Exposure.init({ ...A2A_EXPOSURE, card: a2aCard(), workspace: { name: workspaceName, projectRoot: null } }), "test-module");
    try {
        await daemon.start();
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        for (const [index, taskId] of ids.entries()) {
            const request = A2aMessage.request(`retained request ${index}`, { contextId, taskId });
            const source = `a2a://anonymous/contexts/${contextId}/tasks/${taskId}/messages/${request.message!.messageId}`;
            const started = await daemon.runLoop({
                workspaceId, workerId: retained.workerId, prompt: `retained request ${index}`, source, messageAddress: source,
                envelope: SendMessageRequest.toJSON(request) as Record<string, unknown>, maxTurns: 1,
            });
            await waitForDb(() => daemon.listWorkerLoops({ workspaceId, workerId: retained.workerId }),
                (loops) => loops.some(({ id, status }) => id === started.loopId && status === 200));
        }
        const loops = await daemon.listWorkerLoops({ workspaceId, workerId: retained.workerId });
        const log = await daemon.readLog({ workspaceId, workerId: retained.workerId });
        const client = await connectHttpJsonAgent(serviceUrl(daemon));
        for (const [index, id] of ids.entries()) {
            const task = await client.getTask({ tenant: "", id, historyLength: 100 });
            assert.equal(task.contextId, contextId);
            assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
            assert.equal(task.history[0]!.parts[0]!.content?.value, `retained request ${index}`);
        }
        const fresh = await observe(client, "Continue the conversation in independent work.", contextId).result;
        assert.equal(fresh.status?.state, TaskState.TASK_STATE_COMPLETED, "a previous Task's exhausted one-call budget is not inherited");
        const child = await daemon.readWorker({ workspaceId, identity: { name: fresh.id } });
        assert.ok(child);
        assert.notEqual(child.parentWorkerId, retained.workerId);
        assert.equal(child.parentWorkerId, parentWorkerId);
        assert.deepEqual(await daemon.listWorkerLoops({ workspaceId, workerId: retained.workerId }), loops);
        assert.deepEqual(await daemon.readLog({ workspaceId, workerId: retained.workerId }), log, "upgrade never reparents or rewrites retained log coordinates");
        const packet = provider.received.at(-1)!.map(chatMessageText).join("\n");
        assert.match(packet, /retained request 1/u);
        assert.match(packet, /later answer/u);
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

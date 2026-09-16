import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Module as A2aModule } from "@plurnk/plurnk-a2a";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { a2aCard } from "./_a2a.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

const completed = (content: string) => makeMockResponse([
    "```SEND", content, "```",
    "```TASK", JSON.stringify([{ content, status: "completed" }]), "```",
].join("\n"));

const fixture = async (t: TestContext, responses: Mock | ReturnType<typeof makeMockResponse>[]) => {
    const db = await openMigrated();
    const daemon = new Daemon({
        db,
        provider: responses instanceof Mock ? responses : new Mock({
            contextWindow: 100_000,
            responses,
        }),
    });
    t.after(async () => {
        await daemon.stop();
        await db.close();
    });
    const workspace = await daemon.createWorkspace({
        name: `a2a-http-${randomUUID()}`,
        projectRoot: null,
    });
    let endpoint = "";
    daemon.registerModule({
        start: async (port) => {
            const adapter = await A2aModule.init({
                workspace: { name: workspace.workspaceName, projectRoot: null },
                card: a2aCard(),
            }).start(port);
            endpoint = adapter.agentCard().supportedInterfaces[0]!.url;
            return adapter;
        },
    });
    await daemon.start();

    // Deliberately use literal HTTP+JSON, not the adapter's client/request builders.
    const request = async (path: string, body?: unknown, status = 200) => {
        const response = await fetch(`${endpoint}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/a2a+json", "a2a-version": "1.0" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json();
        assert.equal(response.status, status, JSON.stringify(result));
        return result;
    };
    const send = async (text: string, identity: { contextId?: string; taskId?: string; messageId?: string } = {}) => {
        const result = await request("/message:send", {
            message: {
                messageId: randomUUID(),
                role: "ROLE_USER",
                parts: [{ text, mediaType: "text/plain" }],
                ...identity,
            },
        });
        assert.ok(result.task?.id);
        return result.task;
    };
    return { request, send, daemon, workspace, endpoint };
};

test("{§a2a-task-listing}: HTTP clients page by status-update order, not Worker creation order", async (t) => {
    const { request, send } = await fixture(t, [
        makeMockResponse([
            "```question",
            JSON.stringify({
                message: "Which branch?",
                requestedSchema: {
                    type: "object",
                    properties: { branch: { type: "string" } },
                    required: ["branch"],
                    additionalProperties: false,
                },
            }),
            "```",
            "```TASK",
            JSON.stringify([{ content: "Await the branch selection.", status: "waiting" }]),
            "```",
        ].join("\n")),
        completed("second Task"),
        completed("first Task"),
        completed("third Task"),
    ]);
    const first = await send("Choose a branch.");
    assert.equal(first.status.state, "TASK_STATE_INPUT_REQUIRED");
    const second = await send("Complete the second Task.", { contextId: first.contextId });
    const resumed = await send("main", { taskId: first.id });
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.contextId, first.contextId);
    assert.equal(resumed.status.state, "TASK_STATE_COMPLETED");
    const path = `/tasks?contextId=${encodeURIComponent(first.contextId)}&pageSize=1`;
    const page = await request(path);
    assert.deepEqual(page.tasks.map((task: { id: string }) => task.id), [first.id]);
    assert.equal(page.totalSize, 2);
    assert.ok(page.nextPageToken);
    assert.ok(page.tasks.every((task: { artifacts?: unknown[] }) => !task.artifacts?.length));

    await send("Complete the third Task.", { contextId: first.contextId });
    const next = await request(`${path}&pageToken=${encodeURIComponent(page.nextPageToken)}`);
    assert.deepEqual(next.tasks.map((task: { id: string }) => task.id), [second.id],
        "a new Task before the cursor does not duplicate the preceding page");
    assert.equal(next.nextPageToken ?? "", "");
    assert.equal(next.totalSize, 3);
    const filtered = await request(`${path}&status=TASK_STATE_COMPLETED&includeArtifacts=true&statusTimestampAfter=${encodeURIComponent(resumed.status.timestamp)}`);
    assert.equal(filtered.totalSize, 2);
    assert.equal(filtered.tasks[0].artifacts[0].parts[0].text, "third Task");
    for (const token of ["-1", "garbage", Buffer.from(JSON.stringify([0])).toString("base64url")]) {
        const problem = await request(`${path}&pageToken=${encodeURIComponent(token)}`, undefined, 400);
        assert.equal(problem.error.code, 400);
        assert.equal(problem.error.status, "INVALID_ARGUMENT");
        assert.deepEqual(problem.error.details, [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "INVALID_PARAMS",
            domain: "a2a-protocol.org",
        }]);
        assert.match(problem.error.message, /pageToken/);
    }
});

test("{§a2a-inbound-exposure}: HTTP history retains the admitted prompt identity and content", async (t) => {
    const { request, send } = await fixture(t, [completed("done")]);
    const task = await send("A prompt with \"quotes\" and a\nsecond line.", { messageId: "caller-message" });
    const stored = await request(`/tasks/${task.id}?historyLength=1`);
    assert.deepEqual(stored.history, [{
        messageId: "caller-message",
        contextId: task.contextId,
        taskId: task.id,
        role: "ROLE_USER",
        parts: [{ text: "A prompt with \"quotes\" and a\nsecond line.", mediaType: "text/markdown", metadata: {} }],
        metadata: {},
    }]);
    const without = await request(`/tasks/${task.id}?historyLength=0`);
    assert.equal(without.history?.length ?? 0, 0);
});

test("{§a2a-inbound-exposure}: foreign Task identities return protocol not-found, not a Worker validation error", async (t) => {
    const { request } = await fixture(t, []);
    for (const taskId of ["tck-missing-http_json", "X".repeat(100), "missing-task"]) {
        const problem = await request("/message:send", {
            message: { messageId: randomUUID(), role: "ROLE_USER", taskId, parts: [{ text: "Hello" }] },
        }, 404);
        assert.equal(problem.error.details[0].reason, "TASK_NOT_FOUND");
    }
});

test("{§a2a-inbound-exposure}: unsupported content fails before Worker admission in blocking and streaming requests", async (t) => {
    const { request, daemon, workspace } = await fixture(t, []);
    for (const path of ["/message:send", "/message:stream"]) {
        const problem = await request(path, {
            message: {
                messageId: randomUUID(), role: "ROLE_USER",
                parts: [{ raw: "dGNr", mediaType: "application/x-unsupported" }],
            },
        }, 400);
        assert.equal(problem.error.details[0].reason, "CONTENT_TYPE_NOT_SUPPORTED");
    }
    assert.deepEqual(await daemon.listWorkers(workspace.workspaceId, { origin: "model" }), []);
});

test("{§a2a-inbound-exposure}: a rejected answer leaves the Task awaiting a valid answer", async (t) => {
    const { request, send } = await fixture(t, [
        makeMockResponse([
            "```question",
            JSON.stringify({ message: "Choose 42.", requestedSchema: { type: "integer", const: 42 } }),
            "```",
            "```TASK", JSON.stringify([{ content: "Await input.", status: "waiting" }]), "```",
        ].join("\n")),
        completed("received 42"),
    ]);
    const task = await send("Ask for the number.");
    assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED");
    const problem = await request("/message:send", {
        message: { messageId: randomUUID(), role: "ROLE_USER", taskId: task.id, parts: [{ text: "not an integer" }] },
    }, 400);
    assert.equal(problem.error.details[0].reason, "INVALID_PARAMS");
    const waiting = await request(`/tasks/${task.id}`);
    assert.equal(waiting.status.state, "TASK_STATE_INPUT_REQUIRED");
    const resumed = await request("/message:send", {
        message: { messageId: randomUUID(), role: "ROLE_USER", taskId: task.id, parts: [{ data: 42 }] },
    });
    assert.equal(resumed.task.id, task.id);
    assert.equal(resumed.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(resumed.task.artifacts[0].parts[0].text, "received 42");
});

test("{§a2a-inbound-exposure}: a disconnected HTTP subscriber can rejoin the same live Task without repeating inference", async (t) => {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    class HeldProvider extends Mock {
        override async generate(args: Parameters<Mock["generate"]>[0]) {
            calls += 1;
            started.resolve();
            const abort = () => release.reject(args.signal?.reason);
            args.signal?.addEventListener("abort", abort, { once: true });
            try {
                await release.promise;
                return await super.generate(args);
            } finally {
                args.signal?.removeEventListener("abort", abort);
            }
        }
    }
    const provider = new HeldProvider({ contextWindow: 100_000, responses: [completed("rejoined result")] });
    const { request, endpoint } = await fixture(t, provider);
    const initial = await request("/message:send", {
        message: { messageId: "long-running", role: "ROLE_USER", parts: [{ text: "Wait for the fixture signal." }] },
        configuration: { returnImmediately: true },
    });
    await started.promise;
    const subscribe = () => fetch(`${endpoint}/tasks/${initial.task.id}:subscribe`, {
        headers: { "a2a-version": "1.0", accept: "text/event-stream" },
        signal: AbortSignal.timeout(5000),
    });
    const first = await subscribe();
    assert.equal(first.status, 200);
    const reader = first.body!.getReader();
    const snapshot = new TextDecoder().decode((await reader.read()).value);
    assert.match(snapshot, new RegExp(initial.task.id));
    await reader.cancel();
    const live = await request(`/tasks/${initial.task.id}`);
    assert.equal(live.status.state, "TASK_STATE_WORKING", "disconnect does not cancel or finish the Task");
    const rejoined = await subscribe();
    assert.equal(rejoined.status, 200);
    release.resolve();
    const events = (await rejoined.text()).split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)));
    assert.equal(events[0].task.id, initial.task.id);
    assert.equal(events.at(-1).statusUpdate.status.state, "TASK_STATE_COMPLETED");
    assert.ok(events.some((event) => event.artifactUpdate?.artifact.parts[0].text === "rejoined result"));
    const retained = await request(`/tasks/${initial.task.id}`);
    assert.equal(retained.status.state, "TASK_STATE_COMPLETED");
    assert.equal(retained.artifacts[0].parts[0].text, "rejoined result");
    assert.equal(calls, 1);
});

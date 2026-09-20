import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { Module as A2aModule } from "@plurnk/plurnk-a2a";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { A2A_LISTENER, a2aCard } from "./_a2a.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

const completed = (content: string) => makeMockResponse([
    "````SEND", content, "````",
    "````SEND", "````",
].join("\n"));

const fixture = async (t: TestContext, responses: Mock | ReturnType<typeof makeMockResponse>[]) => {
    const db = await openMigrated();
    let daemon = new Daemon({
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
    const expose = () => daemon.registerModule({
        start: async (port) => {
            const adapter = await A2aModule.init({
                workspace: { name: workspace.workspaceName, projectRoot: null },
                card: a2aCard(),
                ...A2A_LISTENER,
            }).start(port);
            endpoint = adapter.agentCard().supportedInterfaces[0]!.url;
            return adapter;
        },
    });
    expose();
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
    const restart = async () => {
        await daemon.stop();
        daemon = new Daemon({ db, provider: new Mock({ contextWindow: 100_000, responses: [] }) });
        expose();
        await daemon.start();
    };
    return { request, send, daemon, workspace, endpoint, restart };
};

test("{§a2a-task-listing}: HTTP clients page by status-update order, not Worker creation order", async (t) => {
    const { request, send } = await fixture(t, [
        makeMockResponse([
            "````question",
            JSON.stringify({
                message: "Which branch?",
                requestedSchema: {
                    type: "object",
                    properties: { branch: { type: "string" } },
                    required: ["branch"],
                    additionalProperties: false,
                },
            }),
            "````",
            "````WAIT",
            "Await the branch selection.",
            "````",
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
        parts: [{ text: "A prompt with \"quotes\" and a\nsecond line.", mediaType: "text/plain" }],
    }]);
    const without = await request(`/tasks/${task.id}?historyLength=0`);
    assert.equal(without.history?.length ?? 0, 0);
});

test("{§message-envelope-evidence} {§a2a-hosted-message-resources}: hosted A2A retains mixed Parts and metadata without injecting media before READ", async (t) => {
    let fetches = 0;
    const resource = createServer((_request, response) => { fetches++; response.end("not requested"); });
    resource.listen(0, "127.0.0.1");
    await once(resource, "listening");
    t.after(() => new Promise<void>((resolve, reject) => resource.close((error) => error ? reject(error) : resolve())));
    const address = resource.address();
    assert.ok(address && typeof address === "object");
    const provider = new Mock({ contextWindow: 100_000, inputModalities: ["image"], responses: [completed("received")] });
    const { request } = await fixture(t, provider);
    const parts = [
        { text: "Inspect this image.", mediaType: "text/plain", metadata: { position: 1 } },
        { raw: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", mediaType: "image/png", filename: "screen.png", metadata: { position: 2 } },
        { data: { subject: "screenshot" }, metadata: { position: 3 } },
        { url: `http://127.0.0.1:${address.port}/external.bin`, mediaType: "application/octet-stream", filename: "external.bin" },
    ];
    const result = await request("/message:send", {
        message: { messageId: "mixed-message", role: "ROLE_USER", parts, metadata: { caller: "independent" } },
    });
    assert.equal(result.task.status.state, "TASK_STATE_COMPLETED");
    const stored = await request(`/tasks/${result.task.id}`);
    assert.deepEqual(stored.history[0].parts, parts);
    assert.deepEqual(stored.history[0].metadata, { caller: "independent" });
    assert.equal(fetches, 0, "arrival of a URL Part does not fetch it");
    assert.ok(provider.received.length > 0);
    assert.equal(provider.received.flatMap((messages) => messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : [])).length, 0);

    // {§a2a-hosted-message-resources} — each Part's model-facing arrival: authored text, pretty JSON,
    // the literal URL, and a link for bytes. No Agent Card and no configured alias took part.
    // The packet renders each line with its navigable number ({§render-rule-line-navigable-prefix}).
    const arrival = provider.received[0]!.map(chatMessageText).join("\n").replaceAll(/^\d+:/gmu, "");
    assert.ok(arrival.includes("Inspect this image."), "text arrives as authored");
    assert.ok(arrival.includes(JSON.stringify({ subject: "screenshot" }, null, 2)), `a data Part arrives as pretty-printed JSON: ${arrival}`);
    assert.ok(arrival.includes(`http://127.0.0.1:${address.port}/external.bin`), "a URL Part arrives as its literal URL");
    const link = /<(worker:\/\/[^>]+\/attachments\/[^>]+screen\.png)>/u.exec(arrival);
    assert.ok(link, `a raw Part arrives as an addressable link, not bytes: ${arrival}`);
});

for (const modes of [undefined, [], ["application/json", "text/plain"]]) {
    test(`{§a2a-response-preferences}: HTTP request preferences ${JSON.stringify(modes)} reach the provider without changing Message history`, async (t) => {
        const provider = new Mock({ contextWindow: 100_000, responses: [completed("received")] });
        const { request, daemon, workspace, restart } = await fixture(t, provider);
        const message = {
            messageId: "format-request", role: "ROLE_USER",
            parts: [{ text: "Return a small report.", mediaType: "text/plain" }],
            metadata: { authored: true },
        };
        const configuration = modes === undefined ? undefined : { acceptedOutputModes: modes, historyLength: 4 };
        const result = await request("/message:send", {
            message, configuration, metadata: { evidence: "request-only-evidence" },
        });
        assert.equal(result.task.status.state, "TASK_STATE_COMPLETED");
        const packet = provider.received[0]!.map(chatMessageText).join("\n");
        assert.equal(packet.includes("Accepted output media types:"), (modes?.length ?? 0) > 0);
        for (const mode of modes ?? []) assert.ok(packet.includes(mode));
        assert.ok(!packet.includes("request-only-evidence"), "opaque metadata is retained, not injected as instructions");
        const admitted = { ...message, contextId: result.task.contextId, taskId: result.task.id };
        assert.deepEqual(result.task.history, [admitted]);
        const worker = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: result.task.id } });
        assert.ok(worker);
        const incoming = (await daemon.readMessages({ workspaceId: workspace.workspaceId, workerId: worker.id }))
            .find(row => row.direction === "inbound");
        assert.ok(incoming?.envelope);
        assert.deepEqual(incoming.envelope.message, admitted);
        assert.deepEqual(incoming.envelope.metadata, { evidence: "request-only-evidence" });
        if (modes === undefined) assert.equal(incoming.envelope.configuration, undefined);
        else assert.deepEqual(incoming.envelope.configuration, {
            ...(modes.length === 0 ? {} : { acceptedOutputModes: modes }), historyLength: 4,
        });
        await restart();
        assert.deepEqual((await request(`/tasks/${result.task.id}`)).history, [admitted]);
    });
}

test("{§send-resource-attachments}: attachment-only Messages and replies round-trip unnamed and opaque binary content", async (t) => {
    class Echo extends Mock {
        override async generate(...args: Parameters<Mock["generate"]>) {
            const response = await super.generate(...args);
            const packet = args[0].messages.map(chatMessageText).join("\n");
            const targets = [...packet.matchAll(/<(worker:\/\/[^>]+\/attachments\/[^>]+)>/gu)].map((match) => match[1]);
            assert.equal(targets.length, 2, "both binary Parts have independently readable addresses");
            assert.match(targets[1]!, /\/[a-f0-9]{8}$/u, "an unnamed Part receives an eight-character name");
            return { ...response, assistant: { ...response.assistant, content: [
                `\`\`\`\`SEND [${JSON.stringify({ attachments: targets })}]`, "````",
                "````SEND", "````",
            ].join("\n") } };
        }
    }
    const provider = new Echo({ contextWindow: 100_000, responses: [{ assistant: { content: "", reasoning: null } }] });
    const { request } = await fixture(t, provider);
    const parts = [
        { raw: Buffer.from([0, 255, 13, 10, 128]).toString("base64"), mediaType: "application/x-example", filename: "opaque.bin" },
        { raw: "", mediaType: "application/octet-stream" },
    ];
    const result = await request("/message:send", {
        message: { messageId: "files-only", role: "ROLE_USER", parts },
    });
    assert.equal(result.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(result.task.artifacts.length, 2);
    assert.equal(result.task.artifacts[0].parts[0].raw, parts[0]!.raw);
    assert.equal(result.task.artifacts[0].parts[0].mediaType, "application/x-example");
    assert.equal(result.task.artifacts[1].parts[0].raw, "");
    assert.deepEqual(result.task.history[0].parts, parts);
});

test("{§send-resource-attachments}: image READ and explicit report SEND preserve send-time bytes after mutation and curation", async (t) => {
    const continuing = "````NOTE\nPrepare the report.\n````";
    class Reader extends Mock {
        override async generate(...args: Parameters<Mock["generate"]>) {
            const response = await super.generate(...args);
            const packet = args[0].messages.map(chatMessageText).join("\n");
            if (!response.assistant.content.includes("$IMAGE")) return response;
            const path = /<(worker:\/\/[^>]+\/attachments\/[^>]+\/screen.png)>/u.exec(packet)?.[1];
            assert.ok(path, "the inbound SEND links to the ordinary resource");
            return { ...response, assistant: { ...response.assistant, content: response.assistant.content.replace("$IMAGE", path) } };
        }
    }
    const provider = new Reader({ contextWindow: 100_000, inputModalities: ["image"], responses: [
        { assistant: { content: `\`\`\`\`READ ($IMAGE) <1,3>\n\`\`\`\`\n${continuing}`, reasoning: null } },
        { assistant: { content: `\`\`\`\`EDIT (worker:///report.md)\nOriginal report.\n\`\`\`\`\n${continuing}`, reasoning: null } },
        { assistant: { content: `\`\`\`\`SEND [{"attachments":["worker:///report.md"]}]\nHere is the report.\n\`\`\`\`\n\`\`\`\`EDIT (worker:///report.md) <1,-1>\nChanged after sending.\n\`\`\`\`\n\`\`\`\`KILL (log:///*/*/*/SEND) <1,-1>\n\`\`\`\`\n${continuing}`, reasoning: null } },
        completed("Report delivered."),
    ] });
    const { request, restart } = await fixture(t, provider);
    const raw = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const result = await request("/message:send", { message: {
        messageId: "image-request", role: "ROLE_USER", parts: [
            { text: "Inspect the screenshot and return your report." },
            { raw, mediaType: "image/png", filename: "screen.png" },
        ],
    } });
    assert.equal(result.task.status.state, "TASK_STATE_COMPLETED");
    const native = provider.received.map((messages) => messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((part) => part.type === "file") : []));
    assert.equal(native[0]!.length, 0, "arrival does not attach the image");
    assert.equal(native[1]!.length, 1, provider.received[1]!.map(chatMessageText).join("\n"));
    assert.deepEqual(Buffer.from(native[1]![0]!.data), Buffer.from(raw, "base64"), "READ sends exact image bytes to the provider");
    const stored = await request(`/tasks/${result.task.id}`);
    const report = stored.artifacts.find((artifact: { name: string }) => artifact.name === "report.md");
    assert.ok(report, provider.received.at(-1)!.map(chatMessageText).join("\n"));
    assert.equal(Buffer.from(report.parts[0].raw, "base64").toString(), "Original report.");
    assert.equal(report.parts[0].mediaType, "text/markdown");
    assert.equal(stored.history[0].parts[1].raw, raw, "curation cannot erase the caller's image");
    await restart();
    const restored = await request(`/tasks/${result.task.id}`);
    assert.deepEqual(restored.artifacts, stored.artifacts, "a fresh daemon reconstructs immutable Artifact content and identity");
    assert.deepEqual(restored.history, stored.history, "a fresh daemon reconstructs complete Message evidence");
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

test("{§a2a-inbound-exposure}: a Part without content fails before Worker admission in blocking and streaming requests", async (t) => {
    const { request, daemon, workspace } = await fixture(t, []);
    for (const path of ["/message:send", "/message:stream"]) {
        const problem = await request(path, {
            message: {
                messageId: randomUUID(), role: "ROLE_USER",
                parts: [{ mediaType: "application/octet-stream" }],
            },
        }, 400);
        assert.equal(problem.error.details[0].reason, "CONTENT_TYPE_NOT_SUPPORTED");
    }
    assert.deepEqual(await daemon.listWorkers(workspace.workspaceId, { origin: "model" }), []);
});

test("{§a2a-inbound-exposure}: a rejected answer leaves the Task awaiting a valid answer", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse([
            "````question",
            JSON.stringify({ message: "Choose 42.", requestedSchema: { type: "integer", const: 42 } }),
            "````",
            "````WAIT", "Await input.", "````",
        ].join("\n")),
        completed("received 42"),
    ] });
    const { request, send, daemon, workspace } = await fixture(t, provider);
    const task = await send("Ask for the number.");
    assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED");
    const problem = await request("/message:send", {
        message: { messageId: "rejected-answer", role: "ROLE_USER", taskId: task.id, parts: [{ text: "not an integer" }] },
    }, 400);
    assert.equal(problem.error.details[0].reason, "INVALID_PARAMS");
    const waiting = await request(`/tasks/${task.id}`);
    assert.equal(waiting.status.state, "TASK_STATE_INPUT_REQUIRED");
    const resumed = await request("/message:send", {
        message: { messageId: "accepted-answer", role: "ROLE_USER", taskId: task.id, parts: [{ data: 42, metadata: { choice: "number" } }], metadata: { caller: "test" } },
        configuration: { acceptedOutputModes: ["text/plain"] },
    });
    assert.equal(resumed.task.id, task.id);
    assert.equal(resumed.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(resumed.task.artifacts[0].parts[0].text, "received 42");
    const history = (await request(`/tasks/${task.id}`)).history;
    assert.equal(history.length, 2);
    assert.equal(history[1].messageId, "accepted-answer");
    assert.deepEqual(history[1].parts, [{ data: 42, metadata: { choice: "number" } }]);
    assert.deepEqual(history[1].metadata, { caller: "test" });
    const last = await request(`/tasks/${task.id}?historyLength=1`);
    assert.deepEqual(last.history, [history[1]], "historyLength selects the actual last admitted message");
    const packet = provider.received.at(-1)!.map(chatMessageText).join("\n");
    assert.match(packet, /Accepted output media types:.*text\/plain/u);
    const worker = await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: task.id } });
    assert.ok(worker);
    const answer = (await daemon.readMessages({ workspaceId: workspace.workspaceId, workerId: worker.id }))
        .filter(row => row.direction === "inbound").at(-1);
    assert.deepEqual(answer?.envelope?.configuration, { acceptedOutputModes: ["text/plain"] });
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

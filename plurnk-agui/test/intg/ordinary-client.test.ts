// #1144 — the client knows only AG-UI. The host may inspect Plurnk, but never pre-creates the
// client's workspace, supplies forwarded properties, or decodes a Plurnk event to continue it.
import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, resultOf, SERVICE } from "./_helpers.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";

const conversation = (messages: readonly Message[]) => messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") && typeof message.content === "string"
        ? [{ id: message.id, role: message.role, content: message.content }]
        : []);

const client = (t: TestContext, url: string, threadId?: string): HttpAgent => {
    const agent = new HttpAgent({ url, ...(threadId === undefined ? {} : { threadId }) });
    const inputs: RunAgentInput[] = [];
    agent.subscribe({ onRunInitialized: ({ input }) => { inputs.push(structuredClone(input)); } });
    t.after(() => {
        agent.abortRun();
        for (const input of inputs) assert.deepEqual(input.forwardedProps, {}, "the ordinary client supplies no extension fields");
    });
    return agent;
};

const host = async (t: TestContext, replies: readonly string[], options: { path?: string; emissions?: readonly string[] } = {}) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const provider = new Mock({ contextWindow: 100_000, responses: (options.emissions ?? replies.map((text) => `\`\`\`\`SEND [200]\n${text}\n\`\`\`\``)).map((content) => ({
        assistant: { content, reasoning: null },
    })) });
    const db = await openTestDatabase(options.path);
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules"), http });
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        await daemon.stop();
        await http.close();
        await db.close();
    };
    t.after(stop);
    await daemon.start();
    const { host: hostname, port } = http.httpAddress();
    return { daemon, provider, stop, url: `http://${hostname}:${port}/agui` };
};

test("{§agui-official-client-conformance} an ordinary HttpAgent starts, continues and reconstructs its conversation without an overlay", { timeout: 60_000 }, async (t) => {
    const { daemon, provider, url } = await host(t, ["First answer.", "Second answer."]);
    const agent = client(t, url);
    const first = { id: "message-1", role: "user" as const, content: "First question." };
    agent.addMessage(first);
    await agent.runAgent();
    assert.deepEqual(conversation(agent.messages).map(({ role, content }) => ({ role, content })), [
        { role: "user", content: first.content },
        { role: "assistant", content: "First answer." },
    ]);

    agent.addMessage({ id: "message-2", role: "user", content: "Second question." });
    await agent.runAgent();
    const expected = conversation(agent.messages);
    assert.deepEqual(expected.map(({ content }) => content), ["First question.", "First answer.", "Second question.", "Second answer."]);
    assert.equal(new Set(expected.map(({ id }) => id)).size, 4, "each message appears once under a distinct identity");

    const refreshed = client(t, url, agent.threadId);
    await refreshed.runAgent();
    assert.deepEqual(conversation(refreshed.messages), expected, "a new client instance reconstructs the full conversation");
    await agent.runAgent();
    assert.deepEqual(conversation(agent.messages), expected, "resending the held conversation adds nothing");
    const retried = client(t, url, agent.threadId);
    retried.addMessage(first);
    await retried.runAgent();
    assert.deepEqual(conversation(retried.messages), expected, "retrying an accepted message replays rather than submitting twice");
    assert.equal(provider.received.length, 2, "replay and retries do not invoke the model");
    const workspaces = await daemon.listWorkspaces();
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.project_root, null, "a protocol thread does not silently acquire a filesystem project");
    assert.equal((await daemon.listWorkers(workspaces[0]!.id, { origin: "model" })).length, 1);
    const [worker] = await daemon.listWorkers(workspaces[0]!.id, { origin: "model" });
    const qualified = client(t, url, `${workspaces[0]!.id}#${worker.name}`);
    await qualified.runAgent();
    assert.deepEqual(conversation(qualified.messages).map(({ role, content }) => ({ role, content })), expected.map(({ role, content }) => ({ role, content })),
        "opening the worker by qualified ID retains the original client's replies as speech");
});

test("{§agui-official-client-conformance} ordinary threads isolate equal message IDs, including a non-worker-shaped thread ID", { timeout: 60_000 }, async (t) => {
    const { daemon, provider, url } = await host(t, ["Alpha answer.", "Beta answer."]);
    const alpha = client(t, url);
    const beta = client(t, url, "customer/分析 #blue?100%");
    alpha.addMessage({ id: "message-1", role: "user", content: "Alpha question." });
    await alpha.runAgent();
    beta.addMessage({ id: "message-1", role: "user", content: "Beta question." });
    await beta.runAgent();

    const reopened = client(t, url, alpha.threadId);
    await reopened.runAgent();
    assert.deepEqual(conversation(reopened.messages).map(({ content }) => content), ["Alpha question.", "Alpha answer."]);
    assert.deepEqual(conversation(beta.messages).map(({ content }) => content), ["Beta question.", "Beta answer."]);
    assert.equal(provider.received.length, 2);
    const workspaces = await daemon.listWorkspaces();
    assert.equal(workspaces.length, 2, "independent threads do not land in one implicit shared workspace");
    assert.ok(workspaces.every(({ project_root }: { project_root: string | null }) => project_root === null));
});

test("{§agui-official-client-conformance} the empty standard thread string remains an exact external identity", { timeout: 60_000 }, async (t) => {
    const { provider, url } = await host(t, ["An empty key still identifies a conversation."]);
    const first = client(t, url, "");
    assert.equal(first.threadId, "");
    first.addMessage({ id: "request", role: "user", content: "Hello." });
    await first.runAgent();
    const next = client(t, url, "");
    await next.runAgent();
    assert.deepEqual(conversation(next.messages), conversation(first.messages));
    assert.equal(conversation(next.messages).at(-1)?.content, "An empty key still identifies a conversation.");
    assert.equal(provider.received.length, 1);
});

test("{§agui-official-client-conformance} observing an unknown thread creates no workspace or worker", { timeout: 60_000 }, async (t) => {
    const { daemon, provider, url } = await host(t, []);
    const agent = client(t, url);
    await assert.rejects(agent.runAgent(), { status: 404 }, "an unknown conversation is not created by inspection");
    assert.deepEqual(await daemon.listWorkspaces(), []);
    assert.equal(provider.received.length, 0);
});

test("{§agui-official-client-conformance} an opaque conversation survives workspace rename and a new daemon", { timeout: 60_000 }, async (t) => {
    const path = join(await testArtifactDirectory("agui"), `restart-${crypto.randomUUID()}.db`);
    const firstHost = await host(t, ["Before restart."], { path });
    const first = client(t, firstHost.url);
    first.addMessage({ id: "first", role: "user", content: "Remember this conversation." });
    await first.runAgent();
    const expected = conversation(first.messages);
    const [workspace] = await firstHost.daemon.listWorkspaces();
    await firstHost.daemon.renameWorkspace(workspace.id, "Renamed # conversation");
    await firstHost.stop();
    const secondHost = await host(t, ["After restart."], { path });
    const next = client(t, secondHost.url, first.threadId);
    await next.runAgent();
    assert.deepEqual(conversation(next.messages), expected);
    assert.equal(secondHost.provider.received.length, 0);
    next.addMessage({ id: "second", role: "user", content: "Continue." });
    await next.runAgent();
    assert.deepEqual(conversation(next.messages).map(({ content }) => content), ["Remember this conversation.", "Before restart.", "Continue.", "After restart."]);
    assert.equal((await secondHost.daemon.listWorkspaces()).length, 1);
    assert.equal((await secondHost.daemon.listWorkspaces())[0]?.name, "Renamed # conversation");
});

test("{§agui-official-client-conformance} concurrent first contact retains one conversation and one accepted message", { timeout: 60_000 }, async (t) => {
    const { daemon, provider, url } = await host(t, ["Accepted once."]);
    const first = client(t, url);
    const second = client(t, url, first.threadId);
    const message = { id: "same", role: "user" as const, content: "One message." };
    first.addMessage(message);
    second.addMessage(message);
    const failures: string[] = [];
    await Promise.all([first, second].map((agent) => agent.runAgent({}, {
        onRunErrorEvent: ({ event }) => { failures.push(event.code ?? ""); },
    })));
    assert.ok(failures.every((code) => code === "https://problems.plurnk.xyz/daemon/admission/message-already-accepted"), JSON.stringify(failures));
    const refreshed = client(t, url, first.threadId);
    await refreshed.runAgent();
    assert.deepEqual(conversation(refreshed.messages).map(({ content }) => content), ["One message.", "Accepted once."]);
    assert.equal(provider.received.length, 1);
    assert.equal((await daemon.listWorkspaces()).length, 1);
});

test("{§agui-thread-address} a qualified thread selects its immutable workspace ID across rename without forwarded fields", { timeout: 60_000 }, async (t) => {
    const { daemon, provider, url } = await host(t, ["In the named worker."]);
    const workspace = await daemon.createWorkspace({ name: "folder#name" });
    const first = client(t, url, `${workspace.workspaceId}#alice`);
    first.addMessage({ id: "first", role: "user", content: "Use this existing workspace." });
    await first.runAgent();
    await daemon.renameWorkspace(workspace.workspaceId, "a different name");
    const next = client(t, url, first.threadId);
    await next.runAgent();
    assert.deepEqual(conversation(next.messages), conversation(first.messages));
    assert.equal((await daemon.listWorkers(workspace.workspaceId, { origin: "model" }))[0]?.name, "alice");
    assert.equal(provider.received.length, 1);
    const missing = client(t, url, "9007199254740991#alice");
    missing.addMessage({ id: "new", role: "user", content: "Do not create a replacement." });
    await assert.rejects(missing.runAgent(), { status: 404 });
    assert.equal((await daemon.listWorkspaces()).length, 1, "a missing qualified target never becomes an opaque allocation");
});

test("{§agui-official-client-conformance} ordinary clients observe a tool gate and resume it through standard interrupts", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const policy = process.env.PLURNK_SERVICE_PROPOSALS;
    process.env.PLURNK_SERVICE_PROPOSALS = "review";
    t.after(() => {
        if (policy === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
        else process.env.PLURNK_SERVICE_PROPOSALS = policy;
    });
    const { provider, url } = await host(t, [], { emissions: [
        "````sh\nprintf 'approved\\n'\n````\n````WAIT\n````",
        "````SEND [200]\nApproved command completed.\n````",
    ] });
    const submitter = client(t, url);
    submitter.addMessage({ id: "request", role: "user", content: "Run the command." });
    await submitter.runAgent();
    const pending = client(t, url, submitter.threadId);
    await pending.runAgent();
    assert.equal(pending.pendingInterrupts.length, 1);
    const interrupt = pending.pendingInterrupts[0];
    assert.equal(interrupt.reason, "tool_call");
    const calls = pending.messages.flatMap((message) => "toolCalls" in message ? message.toolCalls ?? [] : []);
    assert.equal(calls.find(({ id }) => id === interrupt.toolCallId)?.function.name, "sh");
    assert.equal(provider.received.length, 1, "the approval gate holds inference");
    await pending.runAgent({ resume: [{ interruptId: interrupt.id, status: "resolved", payload: { decision: "accept" } }] });
    assert.deepEqual(pending.pendingInterrupts, []);
    assert.ok(conversation(pending.messages).some(({ content }) => content === "Approved command completed."));
    const results = pending.messages.filter((message) => message.role === "tool" && message.toolCallId === interrupt.toolCallId);
    assert.equal(results.length, 1, "one standard result answers the gated call");
    assert.equal((await resultOf(results[0].content)).body, "approved\n", "{§agui-body-reference} the command's output is one fetch from its result");
    const reopened = client(t, url, submitter.threadId);
    await reopened.runAgent();
    assert.deepEqual(reopened.messages, pending.messages, "the resumed and reconstructed standard conversations agree");
});

test("{§agui-thread-address} a qualified spelling retains the same principal's pending approval", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const policy = process.env.PLURNK_SERVICE_PROPOSALS;
    process.env.PLURNK_SERVICE_PROPOSALS = "review";
    t.after(() => {
        if (policy === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
        else process.env.PLURNK_SERVICE_PROPOSALS = policy;
    });
    const { daemon, provider, url } = await host(t, [], { emissions: [
        "````sh\nprintf 'approved\\n'\n````\n````WAIT\n````",
        "````SEND [200]\nApproved through the same worker's qualified address.\n````",
    ] });
    const original = client(t, url);
    original.addMessage({ id: "request", role: "user", content: "Run the command." });
    await original.runAgent();
    assert.equal(original.pendingInterrupts.length, 1);
    const [workspace] = await daemon.listWorkspaces();
    const [worker] = await daemon.listWorkers(workspace.id, { origin: "model" });
    const qualified = client(t, url, `${workspace.id}#${worker.name}`);
    await qualified.runAgent();
    assert.equal((await daemon.readWorker({ workspaceId: workspace.id, identity: { id: worker.id } }))?.owner, worker.owner,
        "resolving the same conversation does not reassign its owner");
    assert.equal(qualified.pendingInterrupts.length, 1, "changing only the thread spelling must not hide its pending approval");
    await qualified.runAgent({ resume: [{ interruptId: qualified.pendingInterrupts[0].id, status: "resolved", payload: { decision: "accept" } }] });
    assert.equal(provider.received.length, 2);
    assert.equal(conversation(qualified.messages).at(-1)?.content, "Approved through the same worker's qualified address.");
});

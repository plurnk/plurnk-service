// {§agui-snapshot} {§agui-projection} {§agui-call-result} {§agui-official-client-conformance} — the conversation a standard AG-UI client builds from standard events
// alone, CUSTOM events ignored. The official HttpAgent and its own reducer watch one worker from every vantage: attached
// before the prompt, the client that submits it, attached mid-request, attached while a command runs, and refreshed after.
// Every view holds the same messages, in the same order, under the same identities.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { Message, RunAgentInput } from "@ag-ui/core";
import type { ApplicationLoopProjection, ApplicationWorkerProjection } from "@plurnk/plurnk-contracts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

// A passive observer is the official client's own run pipeline pointed at /agui/connect.
class Observer extends HttpAgent {
    override connect(input: RunAgentInput) { return super.run({ ...input, messages: [] }); }
}

// What a standard client shows of a message: who said what, and which operation ran.
const view = (messages: readonly Message[]) => messages.map((message) => {
    const { id, role } = message;
    const content = "content" in message ? message.content : undefined;
    const name = "name" in message ? message.name : undefined;
    const calls = "toolCalls" in message
        ? message.toolCalls?.map(({ id: callId, function: call }) => ({ callId, name: call.name, arguments: JSON.parse(call.arguments) as unknown }))
        : undefined;
    const toolCallId = "toolCallId" in message ? message.toolCallId : undefined;
    const subagentRunId = "subagentRunId" in message ? message.subagentRunId : undefined;
    return JSON.parse(JSON.stringify({ id, role, content, name, calls, toolCallId, subagentRunId })) as Record<string, unknown>;
});

const until = async (what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

const streamed = (frames: readonly object[], hold?: Promise<void>): Response => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
        const send = (frame: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        const [first, ...rest] = frames;
        if (first !== undefined) send(first);
        await hold;
        for (const frame of rest) send(frame);
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
    },
}), { headers: { "content-type": "text/event-stream" } });

test("{§agui-snapshot} {§message-arrival} {§agui-readable-reasoning} {§agui-call-result} every vantage on one worker builds the same conversation from standard events", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    const previousPolicy = process.env.PLURNK_SERVICE_PROPOSALS;
    process.env.PLURNK_SERVICE_PROPOSALS = "accept";
    t.after(() => {
        if (previousPolicy === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
        else process.env.PLURNK_SERVICE_PROPOSALS = previousPolicy;
    });

    // Turn 1 streams its reasoning, holds until released, then works and runs a command that waits for its own release;
    // turn 2 replies.
    const held = Promise.withResolvers<void>();
    const reasoningStreamed = Promise.withResolvers<void>();
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-agui-standard-"));
    const release = join(scratch, "release");
    let calls = 0;
    const frame = (delta: object, finish: string | null = null) => ({
        id: `standard-${calls}`, model: "standard-witness", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
    });
    const provider = new AiSdkProvider({
        model: "standard-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            calls++;
            if (calls === 1) {
                queueMicrotask(() => reasoningStreamed.resolve());
                return streamed([
                    frame({ reasoning_content: "Weighing the plan." }),
                    frame({ content: "````NOTE\nPlan the note.\n````\n````EDIT (worker:///notes.md)\nfirst\n````\n"
                        + "````READ (worker://user/identity.md) <1,2> /cobalt/ <!-- selected evidence -->\n````\n"
                        + "````COPY (worker:///notes.md) (worker:///copy.md)\n````\n"
                        + `\`\`\`\`sh\nwhile [ ! -e '${release}' ]; do sleep 0.02; done; printf 'hello\\n'\n\`\`\`\`\n`
                        + "````WAIT\n````" }, "stop"),
                ], held.promise);
            }
            return streamed([frame({ content: "````SEND [200]\nNoted.\n````" }, "stop")]);
        },
    });

    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        held.resolve();
        await writeFile(release, "");
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(scratch, { recursive: true, force: true });
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "standard" });
    await daemon.createWorker({ workspaceId, name: "main" });
    const { host, port } = http.httpAddress();
    const forwardedProps = { plurnk: { workspace: "standard" } };
    const observe = (): HttpAgent => {
        const agent = new Observer({ url: `http://${host}:${port}/agui/connect`, threadId: "main" });
        agents.push(agent);
        void agent.connectAgent({ forwardedProps }).catch(() => undefined);
        return agent;
    };

    const before = observe();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const submitter = new HttpAgent({ url: `http://${host}:${port}/agui`, threadId: "main" });
    agents.push(submitter);
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Note the plan." }];
    const submitted = submitter.runAgent({ forwardedProps: { plurnk: { ...forwardedProps.plurnk, maxTurns: 4 } } });
    await reasoningStreamed.promise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const late = observe();
    await new Promise((resolve) => setTimeout(resolve, 100));
    held.resolve();

    // {§agui-call-result} A command is one tool call whose result is its stream's observation, whenever that arrives.
    const command = (agent: HttpAgent): string | undefined => agent.messages.flatMap((message) => "toolCalls" in message ? message.toolCalls ?? [] : [])
        .find(({ function: call }) => call.name === "sh")?.id;
    const answered = (agent: HttpAgent, callId: string) => agent.messages.some((message) => message.role === "tool" && message.toolCallId === callId);
    await until("the command to start", () => command(submitter) !== undefined);
    const running = observe();
    await until("the running observer's snapshot", () => command(running) !== undefined);
    assert.equal(answered(running, command(running)!), false, "a running command has no result yet");
    await writeFile(release, "");
    await submitted;
    const replied = (agent: HttpAgent) => agent.messages.some((message) => message.role === "assistant" && message.content === "Noted.");
    await until("the observers to hear the reply", () => replied(before) && replied(late) && replied(running));

    const refreshed = new HttpAgent({ url: `http://${host}:${port}/agui`, threadId: "main" });
    agents.push(refreshed);
    await refreshed.runAgent({ forwardedProps: { plurnk: { ...forwardedProps.plurnk, mode: "sync" } } });

    const truth = view(refreshed.messages);
    assert.deepEqual(truth.filter(({ role }) => role === "user").map(({ id, content }) => ({ id, content })),
        [{ id: "prompt-1", content: "Note the plan." }], "the refreshed snapshot holds the prompt once, under the submitter's id");
    assert.ok(truth.some(({ role }) => role === "reasoning"), "the snapshot holds the turn's reasoning");
    // {§agui-projection} #1140 — a tool call carries the operation as authored: its host, scope, pattern and aside.
    const read = truth.flatMap(({ calls }) => (calls as Array<{ name: string; arguments: Record<string, unknown> }> | undefined) ?? [])
        .find(({ name }) => name === "READ");
    assert.equal((read?.arguments.target as { raw?: string } | undefined)?.raw, "worker://user/identity.md", "the host addresses the resource");
    assert.ok(read?.arguments.lineMarker !== null && read?.arguments.matcher !== null && read?.arguments.aside === "selected evidence",
        `the scope, pattern and aside ride the arguments: ${JSON.stringify(read?.arguments)}`);
    const copy = truth.flatMap(({ calls }) => (calls as Array<{ name: string; arguments: Record<string, unknown> }> | undefined) ?? [])
        .find(({ name }) => name === "COPY");
    assert.deepEqual([copy?.arguments.source, copy?.arguments.destination].map((operand) => (operand as { target?: { raw?: string } } | undefined)?.target?.raw),
        ["worker:///notes.md", "worker:///copy.md"], "both COPY operands ride the arguments");
    const commandId = command(refreshed)!;
    const outputs = truth.filter(({ role, toolCallId }) => role === "tool" && toolCallId === commandId);
    assert.deepEqual(outputs.map(({ content }) => {
        const { status, exitCode, terminal, content: output } = JSON.parse(content as string) as Record<string, unknown>;
        return { status, exitCode, terminal, output };
    }), [{ status: 200, exitCode: 0, terminal: true, output: "hello\n" }], "the command's result is its output and conclusion, not its start receipt");
    for (const [vantage, agent] of [["attached before the prompt", before], ["the submitting client", submitter], ["attached mid-request", late],
        ["attached while the command ran", running]] as const) {
        assert.deepEqual(view(agent.messages), truth, `${vantage} built exactly the refreshed conversation`);
    }
});

test("{§agui-snapshot} {§agui-call-result} {§worker-obligations} every vantage sees a delegation answered by its child's conclusion and a message by its reply", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    const previousPolicy = process.env.PLURNK_SERVICE_PROPOSALS;
    process.env.PLURNK_SERVICE_PROPOSALS = "accept";
    t.after(() => {
        if (previousPolicy === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
        else process.env.PLURNK_SERVICE_PROPOSALS = previousPolicy;
    });

    // The WAITs serialize the calls: main delegates, the helper concludes, main asks its peer, the peer answers, main replies.
    const script = [
        "````WORK (worker://helper)\nSay hello.\n````\n````WAIT\n````",
        "````SEND [200]\nhello from the helper\n````",
        "````SEND (worker://peer)\nWhat is the answer?\n````\n````WAIT\n````",
        "````SEND [200]\nforty-two\n````",
        "````SEND [200]\nThe helper said hello; the answer is forty-two.\n````",
    ];
    let calls = 0;
    const provider = new AiSdkProvider({
        model: "standard-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => streamed([{ id: `delegation-${calls}`, model: "standard-witness", choices: [{ index: 0,
            delta: { content: script[Math.min(calls++, script.length - 1)]! }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]),
    });

    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "delegation" });
    await daemon.createWorker({ workspaceId, name: "main" });
    await daemon.createWorker({ workspaceId, name: "peer" });
    const { host, port } = http.httpAddress();
    const forwardedProps = { plurnk: { workspace: "delegation" } };
    const before = new Observer({ url: `http://${host}:${port}/agui/connect`, threadId: "main" });
    agents.push(before);
    void before.connectAgent({ forwardedProps }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const submitter = new HttpAgent({ url: `http://${host}:${port}/agui`, threadId: "main" });
    agents.push(submitter);
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Ask the helper and the peer." }];
    await submitter.runAgent({ forwardedProps: { plurnk: { ...forwardedProps.plurnk, maxTurns: 8 } } });
    const finished = (agent: HttpAgent) => agent.messages.some((message) => message.role === "assistant" && message.content === "The helper said hello; the answer is forty-two.");
    await until("the observer to hear the reply", () => finished(before));
    const refreshed = new HttpAgent({ url: `http://${host}:${port}/agui`, threadId: "main" });
    agents.push(refreshed);
    await refreshed.runAgent({ forwardedProps: { plurnk: { ...forwardedProps.plurnk, mode: "sync" } } });

    const truth = view(refreshed.messages);
    const callOf = (name: string) => truth.flatMap(({ calls: made }) => (made as Array<{ callId: string; name: string }> | undefined) ?? [])
        .find((call) => call.name === name)?.callId;
    const answersOf = (callId: string | undefined) => truth.filter(({ role, toolCallId }) => role === "tool" && toolCallId === callId).map(({ content }) => content);
    const conclusion = answersOf(callOf("WORK"));
    assert.equal(conclusion.length, 1, "the WORK has one result: no receipt beside its child's conclusion");
    assert.equal((JSON.parse(conclusion[0] as string) as { content?: unknown }).content, "hello from the helper", "the child's conclusion answers the WORK");
    assert.deepEqual(answersOf(callOf("SEND")), ["forty-two"], "the peer's completion answers the SEND, in its own words");
    for (const [vantage, agent] of [["attached before the prompt", before], ["the submitting client", submitter]] as const) {
        assert.deepEqual(view(agent.messages), truth, `${vantage} built exactly the refreshed conversation`);
    }
});

test("{§agui-subagents} {§agui-snapshot} a Run that observes its delegation sees the child as a subagent of the WORK, live as on refresh", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    const previousPolicy = process.env.PLURNK_SERVICE_PROPOSALS;
    process.env.PLURNK_SERVICE_PROPOSALS = "accept";
    t.after(() => {
        if (previousPolicy === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
        else process.env.PLURNK_SERVICE_PROPOSALS = previousPolicy;
    });
    const script = [
        "````WORK (worker://helper)\nSay hello.\n````\n````WAIT\n````",
        "````NOTE\nGreeting the delegator.\n````\n````SEND [200]\nhello from the helper\n````",
        "````SEND [200]\nThe helper said hello.\n````",
    ];
    let calls = 0;
    const provider = new AiSdkProvider({
        model: "standard-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => streamed([{ id: `subagent-${calls}`, model: "standard-witness", choices: [{ index: 0,
            delta: { content: script[Math.min(calls++, script.length - 1)]! }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]),
    });
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "subagents" });
    await daemon.createWorker({ workspaceId, name: "main" });
    const { host, port } = http.httpAddress();
    const delegation = { plurnk: { workspace: "subagents", descendants: true } };
    const failures: unknown[] = [];
    // What a subscriber learns of each vantage's subagent runs.
    const lifecycleOf = (agent: HttpAgent): Array<Record<string, unknown>> => {
        const seen: Array<Record<string, unknown>> = [];
        agent.subscribe({ onEvent: ({ event }) => {
            if (event.type === "SUBAGENT_STARTED" || event.type === "SUBAGENT_FINISHED" || event.type === "SUBAGENT_ERROR") seen.push({ ...event });
        } });
        return seen;
    };
    const watcher = new Observer({ url: `http://${host}:${port}/agui/connect`, threadId: "main" });
    agents.push(watcher);
    const lifecycle = lifecycleOf(watcher);
    void watcher.connectAgent({ forwardedProps: delegation }).catch((error: unknown) => { failures.push(error); });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const submitter = new HttpAgent({ url: `http://${host}:${port}/agui`, threadId: "main" });
    agents.push(submitter);
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Ask the helper." }];
    await submitter.runAgent({ forwardedProps: { plurnk: { workspace: "subagents", maxTurns: 6 } } });
    await until("the watcher to hear the reply", () => watcher.messages.some((message) => message.role === "assistant" && message.content === "The helper said hello."));
    const refreshed = new HttpAgent({ url: `http://${host}:${port}/agui`, threadId: "main" });
    agents.push(refreshed);
    const presented = lifecycleOf(refreshed);
    await refreshed.runAgent({ forwardedProps: { plurnk: { ...delegation.plurnk, mode: "sync" } } });
    const helperWorker = (await daemon.listWorkers(workspaceId) as ApplicationWorkerProjection[]).find(({ name }) => name === "helper");
    const concluded = (await daemon.listWorkerLoops({ workspaceId, workerId: helperWorker!.id }) as ApplicationLoopProjection[])[0]?.terminalResult;

    assert.deepEqual(failures, [], "the official client accepts the subagent lifecycle");
    const work = view(watcher.messages).flatMap(({ calls: made }) => (made as Array<{ callId: string; name: string }> | undefined) ?? []).find(({ name }) => name === "WORK");
    const subagentRun = [
        { type: "SUBAGENT_STARTED", subagentRunId: "ops://helper/1", name: "helper", parentToolCallId: work?.callId },
        { type: "SUBAGENT_FINISHED", subagentRunId: "ops://helper/1", outcome: { type: "success" }, result: concluded },
    ];
    assert.ok(concluded?.status === 200, "the child concluded");
    assert.deepEqual(lifecycle.map(({ timestamp: _timestamp, ...event }) => event), subagentRun,
        "the child's loop is one subagent of the WORK that opened it, ended by its conclusion with its exact result");
    assert.deepEqual(presented.map(({ timestamp: _timestamp, ...event }) => event), subagentRun, "the refreshed Run presents the same subagent run, concluded");
    const helper = view(watcher.messages).filter(({ subagentRunId }) => subagentRunId === "ops://helper/1");
    assert.ok(helper.some(({ role, content, name }) => role === "user" && content === "Say hello." && name === "worker://main"), "the child's conversation begins with its task, from its delegator");
    assert.ok(helper.every(({ id }) => String(id).startsWith("worker://helper#")), `the child's identities are its own: ${JSON.stringify(helper.map(({ id }) => id))}`);
    assert.deepEqual(view(watcher.messages), view(refreshed.messages), "the watcher built exactly the refreshed conversation, its delegation included");
});

test("{§agui-run-outcome} {§agui-plurnk-metadata} a standard client reads a Run's end: its loop's result, usage and terminal record, or an action's whole outcome", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    const provider = new AiSdkProvider({
        model: "standard-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 100_000, streaming: true, fetchTimeoutMs: 20_000, operationTimeoutMs: 20_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => streamed([{ id: "outcome", model: "standard-witness", choices: [{ index: 0,
            delta: { content: "````SEND [200]\nDone.\n````" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]),
    });
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "outcomes" });
    await daemon.createWorkspace({ name: "taken" });
    const { workerId } = await daemon.createWorker({ workspaceId, name: "main" });
    const { host, port } = http.httpAddress();
    const agent = (threadId: string): HttpAgent => {
        const made = new HttpAgent({ url: `http://${host}:${port}/agui`, threadId });
        agents.push(made);
        return made;
    };

    const submitter = agent("main");
    let finished: Record<string, unknown> | undefined;
    submitter.subscribe({ onRunFinishedEvent: ({ event }) => { finished = { ...event }; } });
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Finish." }];
    const run = await submitter.runAgent({ forwardedProps: { plurnk: { workspace: "outcomes", maxTurns: 2 } } });
    const [loop] = await daemon.listWorkerLoops({ workspaceId, workerId }) as ApplicationLoopProjection[];
    assert.deepEqual(run.result, loop?.terminalResult, "the official client returns the loop's exact terminal result as the Run's result");
    assert.deepEqual(finished?.outcome, { type: "success" });
    assert.deepEqual((finished?.usage as Array<{ totalTokens?: number }> | undefined)?.map(({ totalTokens }) => totalTokens), [120], "with the tokens its request reported");
    const terminal = (finished?.metadata as { plurnk?: { terminal?: Record<string, unknown> } } | undefined)?.plurnk?.terminal;
    assert.deepEqual([terminal?.workspaceId, terminal?.workerId, terminal?.loopId, terminal?.result], [workspaceId, workerId, loop?.id, loop?.terminalResult],
        "and the loop's complete terminal record as its metadata");

    const listed = await agent("listing").runAgent({ forwardedProps: { plurnk: { workspace: "outcomes", action: { kind: "workspace.list" } } } });
    assert.deepEqual([(listed.result as { kind?: unknown }).kind, (listed.result as { ok?: unknown }).ok], ["workspace.list", true], "an action Run's result is its outcome");
    const refused = await agent("renaming").runAgent({ forwardedProps: { plurnk: { workspace: "outcomes", action: { kind: "workspace.rename", name: "taken" } } } });
    const { kind, ok, problem } = refused.result as { kind?: unknown; ok?: unknown; problem?: { status?: unknown } };
    assert.deepEqual([kind, ok, problem?.status], ["workspace.rename", false, 409], "and a refused action's outcome is its exact Problem, on a Run that finished");
});

// {§agui-snapshot} {§agui-projection} {§agui-execution-result} {§agui-official-client-conformance} — the conversation a standard AG-UI client builds from standard events
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
    return JSON.parse(JSON.stringify({ id, role, content, name, calls, toolCallId })) as Record<string, unknown>;
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

test("{§agui-snapshot} {§message-arrival} {§agui-readable-reasoning} {§agui-execution-result} every vantage on one worker builds the same conversation from standard events", { timeout: 60_000 }, async (t) => {
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

    // {§agui-execution-result} A command is one tool call whose result is its stream's observation, whenever that arrives.
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

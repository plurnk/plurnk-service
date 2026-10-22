// {§agui-history-window} {§agui-delegation-observation} — a large, deep conversation through the official HttpAgent: a
// chain of helpers whose history passes the client's event guard attaches as its window, follows the work after it, and
// an observer's departure leaves that work to finish.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

type Page = { final: boolean; messages: Message[]; older: string | null };
type History = { older: string | null };
const historyOf = (metadata: unknown): History => (metadata as { plurnk: { history: History } }).plurnk.history;
const text = (message: Message): string => typeof message.content === "string" ? message.content : "";

// @ag-ui/client 1.0 refuses an SSE event whose pending text passes 10 × 1024 × 1024 characters.
const CLIENT_EVENT_GUARD = 10 * 1024 * 1024;

// One provider for the whole tree: the chain takes its turns in this order, and a step may hold its answer.
const scripted = async (script: ReadonlyArray<{ readonly dsl: string; readonly hold?: Promise<void> }>) => {
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    let calls = 0;
    const called: Array<PromiseWithResolvers<void>> = script.map(() => Promise.withResolvers<void>());
    const frame = (delta: object, finish: string | null = null): object => ({
        id: `deep-${calls}`, model: "deep-witness", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
    });
    const provider = new AiSdkProvider({
        model: "deep-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 50_000_000, streaming: true, fetchTimeoutMs: 60_000, operationTimeoutMs: 60_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            const step = script[calls] ?? { dsl: "````SEND [200]\nDone.\n````" };
            called[calls]?.resolve();
            calls++;
            return new Response(new ReadableStream<Uint8Array>({
                async start(controller) {
                    const send = (value: object): void => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)); };
                    await step.hold;
                    send(frame({ content: step.dsl }, "stop"));
                    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                    controller.close();
                },
            }), { headers: { "content-type": "text/event-stream" } });
        },
    });
    return { provider, called: async (index: number): Promise<void> => { await called[index]?.promise; } };
};

// A helper's survey: notes each well under the window's ceiling, together far past the client's guard.
const notes = (helper: string, count: number) => Array.from({ length: count }, (_, n) => ({
    dsl: `\`\`\`\`NOTE\n${helper} note ${n + 1}: ${"what the survey found at this depth ".repeat(42_000)}\n\`\`\`\``,
}));
const delegate = (helper: string, task: string) => ({ dsl: `\`\`\`\`WORK (worker://${helper})\n${task}\n\`\`\`\`\n\`\`\`\`WAIT\nWaiting on the ${helper}.\n\`\`\`\`` });

test("{§agui-history-window} {§agui-delegation-observation}: a deep tree whose history passes the official client's event guard attaches as its window, observes the work after it, and an observer's departure leaves that work to finish", { timeout: 180_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const held = Promise.withResolvers<void>();
    // The worker delegates three generations down; each helper surveys, the deepest holds its conclusion.
    const script: ReadonlyArray<{ readonly dsl: string; readonly hold?: Promise<void> }> = [
        delegate("scout", "Survey, then hand the deeper survey on."), ...notes("Scout", 3),
        delegate("digger", "Dig, then hand the deeper dig on."), ...notes("Digger", 3),
        delegate("miner", "Mine, then say done."), ...notes("Miner", 2),
        { dsl: "````SEND [200]\nMiner done.\n````", hold: held.promise },
        { dsl: "````SEND [200]\nDigger done.\n````" },
        { dsl: "````SEND [200]\nScout done.\n````" },
        { dsl: "````SEND [200]\nAll done.\n````" },
    ];
    const { provider, called } = await scripted(script);
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider: provider as never, nodeModulesPath: join(SERVICE, "node_modules") });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        held.resolve();
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/agui`;
    const ceiling = Number(process.env.PLURNK_AGUI_HISTORY_PAGE_CHARS);
    assert.ok(ceiling > 0 && ceiling < CLIENT_EVENT_GUARD, `the shipped ceiling sits under the client's guard: ${ceiling}`);

    const submitter = new HttpAgent({ url, threadId: "main" });
    agents.push(submitter);
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Survey the site three levels down." }];
    const submitted = submitter.runAgent({ forwardedProps: { plurnk: { workspace: "deep", control: true } } });
    await called(script.findIndex(({ hold }) => hold !== undefined));

    // Attach as the official client does, delegation in view; a refusal by the client fails the witness at once.
    const attach = (agent: HttpAgent) => {
        const window = Promise.withResolvers<{ chars: number; ids: ReadonlySet<string>; history: History }>();
        const run = agent.runAgent({ forwardedProps: { plurnk: { workspace: "deep", descendants: true } } }, {
            onMessagesSnapshotEvent: ({ event }) => {
                window.resolve({ chars: JSON.stringify(event).length, ids: new Set(event.messages.map(({ id }) => id)), history: historyOf(event.metadata) });
            },
        });
        run.catch((cause: unknown) => { window.reject(cause); });
        return { window: window.promise, run };
    };

    // An observer attaches while the tree works, and departs.
    const departing = new HttpAgent({ url, threadId: "main" });
    agents.push(departing);
    const departure = attach(departing);
    await departure.window;
    departing.abortRun();
    await departure.run.catch(() => undefined);

    const reader = new HttpAgent({ url, threadId: "main" });
    agents.push(reader);
    const reading = attach(reader);
    const window = await reading.window;
    assert.ok(window.chars <= ceiling, `the window serializes within the ceiling: ${window.chars}`);
    let whole = window.chars;
    for (let link = window.history.older; link !== null;) {
        const response = await fetch(link);
        assert.equal(response.status, 200, link);
        const page = JSON.parse(await response.text()) as Page;
        whole += JSON.stringify(page.messages).length;
        link = page.older;
    }
    assert.ok(whole > CLIENT_EVENT_GUARD, `the conversation, its window and every page before it, passes the client's guard: ${whole}`);

    held.resolve();
    await Promise.all([submitted, reading.run]);
    const arrived = reader.messages.filter(({ id }) => !window.ids.has(id));
    // A helper concludes by its SEND, a call of its subagent run; the bound worker's answer is its reply.
    assert.ok(arrived.some((message) => message.role === "assistant" && "subagentRunId" in message && message.subagentRunId === "ops://miner/1"
        && message.toolCalls?.some(({ function: { name } }) => name === "SEND") === true),
    "the deepest helper's conclusion reaches the reader after it attached");
    assert.ok(arrived.some((message) => message.role === "assistant" && text(message) === "All done."), "and so does the worker's answer");
    assert.ok(submitter.messages.some((message) => message.role === "assistant" && text(message) === "All done."),
        "the work the departed observer watched finished");
});

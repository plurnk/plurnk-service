// {§agui-history-window} {§agui-history-page} {§agui-words-by-reference} {§agui-history-advance} — through the official
// HttpAgent against the real daemon: a long conversation attaches as its newest loops, and the pages before them, followed
// back, reassemble it whole; the ceiling bounds every snapshot and page, a message's words past it one fetch away; and a
// loop that outgrows the ceiling reaches its client as a fresh window at a turn boundary.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

type Page = { final: boolean; messages: Message[]; older: string | null };
type History = { older: string | null };
const historyOf = (metadata: unknown): History => (metadata as { plurnk: { history: History } }).plurnk.history;
const text = (message: Message): string => typeof message.content === "string" ? message.content : "";

// A daemon whose AG-UI module reads these history settings, and a Mock whose responses its turns consume in order.
const boot = async (t: { after(fn: () => Promise<void> | void): void }, settings: Record<string, string>, responses: readonly string[]) => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
    ]);
    const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
    Object.assign(process.env, settings);
    const provider = new Mock({ contextWindow: 4_000_000, responses: responses.map((dsl) => makeMockResponse(dsl)) });
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    t.after(async () => {
        await daemon.stop();
        await http.close();
        await db.close();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    await daemon.start();
    const { host, port } = http.httpAddress();
    return { daemon, url: `http://${host}:${port}/agui` };
};

// Every page before a window, oldest first, each fetched at the link the one after it carries.
const pagesBefore = async (older: string | null): Promise<Page[]> => {
    const pages: Page[] = [];
    for (let link = older; link !== null;) {
        const response = await fetch(link);
        assert.equal(response.status, 200, link);
        const body = await response.text();
        const page = JSON.parse(body) as Page;
        pages.unshift(page);
        link = page.older;
    }
    return pages;
};

test("{§agui-history-window} {§agui-history-page}: a long conversation attaches as its newest loops; its pages, followed back, are the rest of it, once each and in order", { timeout: 120_000 }, async (t) => {
    const prompts = [1, 2, 3, 4, 5].map((n) => `Question ${n}.`);
    const { url } = await boot(t, { PLURNK_AGUI_HISTORY_LOOPS: "2" }, prompts.map((_, n) => `\`\`\`\`SEND [200]\nAnswer ${n + 1}.\n\`\`\`\``));
    const submitter = new HttpAgent({ url, threadId: "main" });
    t.after(() => submitter.abortRun());
    for (const [n, prompt] of prompts.entries()) {
        submitter.messages = [...submitter.messages, { id: `prompt-${n + 1}`, role: "user", content: prompt }];
        await submitter.runAgent({ forwardedProps: { plurnk: { workspace: "history", control: true } } });
    }

    const reader = new HttpAgent({ url, threadId: "main" });
    t.after(() => reader.abortRun());
    let history: History | null = null;
    await reader.runAgent({ forwardedProps: { plurnk: { workspace: "history" } } }, {
        onMessagesSnapshotEvent: ({ event }) => { history = historyOf(event.metadata); },
    });
    const users = (messages: readonly Message[]): string[] => messages.filter(({ role }) => role === "user").map(text);
    assert.deepEqual(users(reader.messages), prompts.slice(3), "the official client holds the newest two loops");
    assert.ok(history !== null && typeof (history as History).older === "string", "and the link to the page before them");

    const pages = await pagesBefore((history as unknown as History).older);
    assert.deepEqual(pages.map(({ messages }) => users(messages)), [[prompts[0]], [prompts[1]], [prompts[2]]], "one loop per page, back to the first");
    assert.ok(pages.every(({ final }) => final), "every page of a concluded loop is final");
    const all = [...pages.flatMap(({ messages }) => messages), ...reader.messages];
    assert.equal(new Set(all.map(({ id }) => id)).size, all.length, "no message appears twice");
    assert.deepEqual(users(all), prompts, "every prompt, in order");
    assert.deepEqual(all.filter(({ role }) => role === "assistant").map(text).filter((words) => words.length > 0), prompts.map((_, n) => `Answer ${n + 1}.`),
        "every answer, in order");
});

test("{§agui-history-window} {§agui-words-by-reference}: the ceiling bounds every snapshot and page, and words past it are one fetch away", { timeout: 120_000 }, async (t) => {
    const ceiling = 6000;
    const long = `${"A paragraph the person pasted, long enough to pass the ceiling on its own. ".repeat(110)}End.`;
    const { url } = await boot(t, { PLURNK_AGUI_HISTORY_LOOPS: "2", PLURNK_AGUI_HISTORY_PAGE_CHARS: String(ceiling) },
        [1, 2, 3, 4].map((n) => `\`\`\`\`SEND [200]\nAnswer ${n}: ${"words of the answer ".repeat(40)}\n\`\`\`\``));
    const submitter = new HttpAgent({ url, threadId: "main" });
    t.after(() => submitter.abortRun());
    const contents = [long, "Second.", "Third.", "Fourth."];
    for (const [n, content] of contents.entries()) {
        submitter.messages = [...submitter.messages, { id: `prompt-${n + 1}`, role: "user", content }];
        await submitter.runAgent({ forwardedProps: { plurnk: { workspace: "bounded", control: true } } });
    }
    const reader = new HttpAgent({ url, threadId: "main" });
    t.after(() => reader.abortRun());
    let snapshot = 0;
    let history: History | null = null;
    await reader.runAgent({ forwardedProps: { plurnk: { workspace: "bounded" } } }, {
        onMessagesSnapshotEvent: ({ event }) => { snapshot = JSON.stringify(event).length; history = historyOf(event.metadata); },
    });
    assert.ok(snapshot > 0 && snapshot <= ceiling, `the snapshot serializes within the ceiling: ${snapshot}`);
    const pages = await pagesBefore((history as unknown as History).older);
    for (const page of pages) assert.ok(JSON.stringify(page).length <= ceiling, `a page serializes within the ceiling: ${JSON.stringify(page).length}`);
    const pasted = pages.flatMap(({ messages }) => messages).find(({ id }) => id === "prompt-1");
    assert.ok(pasted !== undefined, "the pasted message keeps its identity and place");
    const parts = pasted.content as ReadonlyArray<{ type: string; source?: { type: string; value?: string; mimeType?: string } }>;
    assert.equal(Array.isArray(parts) && parts.length === 1 && parts[0]?.type === "document" && parts[0].source?.mimeType, "text/plain", "its words, by reference");
    const fetched = await fetch(parts[0]?.source?.value ?? "");
    assert.equal(fetched.status, 200);
    assert.equal(await fetched.text(), long, "one fetch returns them exactly");
});

test("{§agui-history-advance}: a loop that outgrows the ceiling reaches its client as a fresh window at a turn boundary", { timeout: 120_000 }, async (t) => {
    const ceiling = 9000;
    const note = (n: number) => `\`\`\`\`NOTE\nObservation ${n}: ${"a long working note the worker keeps ".repeat(60)}\n\`\`\`\``;
    const { url } = await boot(t, { PLURNK_AGUI_HISTORY_LOOPS: "2", PLURNK_AGUI_HISTORY_PAGE_CHARS: String(ceiling) },
        [1, 2, 3, 4, 5, 6].map(note).concat(["````SEND [200]\nDone.\n````"]));
    const agent = new HttpAgent({ url, threadId: "main" });
    t.after(() => agent.abortRun());
    agent.messages = [{ id: "prompt-1", role: "user", content: "Work through it." }];
    const windows: number[] = [];
    await agent.runAgent({ forwardedProps: { plurnk: { workspace: "advance", control: true } } }, {
        onMessagesSnapshotEvent: ({ event }) => { windows.push(JSON.stringify(event).length); },
    });
    assert.ok(windows.length >= 1, "the Run that watched the loop received a fresh window");
    assert.ok(windows.every((chars) => chars <= ceiling), `each within the ceiling: ${windows.join(", ")}`);
    const notes = agent.messages.flatMap((message) => message.role === "assistant" ? (message.toolCalls ?? []) : []).filter(({ function: { name } }) => name === "NOTE");
    assert.ok(notes.length < 6, `the client no longer holds every turn of the loop: ${notes.length} of 6 notes`);
    assert.ok(agent.messages.some((message) => message.role === "assistant" && message.content === "Done."), "and the loop's last words reach it");
});

// A provider whose calls answer in order; a call that holds waits for its release before it finishes.
const scripted = async (script: ReadonlyArray<{ readonly dsl: string; readonly hold?: Promise<void> }>) => {
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    let calls = 0;
    const called: Array<PromiseWithResolvers<void>> = script.map(() => Promise.withResolvers<void>());
    const frame = (delta: object, finish: string | null = null): object => ({
        id: `history-${calls}`, model: "history-witness", choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }),
    });
    const provider = new AiSdkProvider({
        model: "history-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 1_000_000, streaming: true, fetchTimeoutMs: 30_000, operationTimeoutMs: 30_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            const step = script[calls] ?? { dsl: "````SEND [200]\nDone.\n````" };
            called[calls]?.resolve();
            calls++;
            return new Response(new ReadableStream<Uint8Array>({
                async start(controller) {
                    const send = (value: object): void => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)); };
                    send(frame({ reasoning_content: "Going on." }));
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

test("{§agui-history-page}: a result that lands after its call left the window updates the page that holds the call, under the ids the complete projection gives them", { timeout: 120_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const note = (n: number) => `\`\`\`\`NOTE\nHelper note ${n}: ${"the helper records what it found ".repeat(70)}\n\`\`\`\``;
    const held = Promise.withResolvers<void>();
    // The worker delegates and waits; its helper takes two long notes, holds, then concludes; the worker then answers.
    const { provider, called } = await scripted([
        { dsl: "````WORK (worker://helper)\nTake notes, then say done.\n````\n````WAIT\nWaiting on the helper.\n````" },
        { dsl: note(1) }, { dsl: note(2) }, { dsl: "````SEND [200]\nDone.\n````", hold: held.promise },
        { dsl: "````SEND [200]\nThe helper is done.\n````" },
    ]);
    const previous = { loops: process.env.PLURNK_AGUI_HISTORY_LOOPS, chars: process.env.PLURNK_AGUI_HISTORY_PAGE_CHARS };
    Object.assign(process.env, { PLURNK_AGUI_HISTORY_LOOPS: "2", PLURNK_AGUI_HISTORY_PAGE_CHARS: "5000" });
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
        Object.assign(process.env, { PLURNK_AGUI_HISTORY_LOOPS: previous.loops, PLURNK_AGUI_HISTORY_PAGE_CHARS: previous.chars });
    });
    await daemon.start();
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/agui`;
    const submitter = new HttpAgent({ url, threadId: "main" });
    agents.push(submitter);
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Have the helper take notes." }];
    const submitted = submitter.runAgent({ forwardedProps: { plurnk: { workspace: "late", control: true } } });
    await called(3);

    // The helper holds before it concludes: a reader attaches, and the worker's delegation has left its window.
    const reader = new HttpAgent({ url, threadId: "main" });
    agents.push(reader);
    const window = Promise.withResolvers<History>();
    const results: Array<{ toolCallId: string; messageId: string }> = [];
    const watched = reader.runAgent({ forwardedProps: { plurnk: { workspace: "late", descendants: true } } }, {
        onMessagesSnapshotEvent: ({ event }) => { window.resolve(historyOf(event.metadata)); },
        onToolCallResultEvent: ({ event }) => { results.push({ toolCallId: event.toolCallId, messageId: event.messageId }); },
    });
    const { older } = await window.promise;
    assert.ok(older !== null, "the window does not reach back to the delegation");
    const delegation = reader.messages.find((message) => message.role === "assistant" && message.toolCalls?.some(({ function: { name } }) => name === "WORK"));
    assert.equal(delegation, undefined, "the reader does not hold the delegation's call");
    // Back through the pages to the one that holds the delegation's call.
    const holdsWork = (page: Page) => page.messages.find((message) => message.role === "assistant" && message.toolCalls?.some(({ function: { name } }) => name === "WORK"));
    let link: string | null = older;
    let before: Page | null = null;
    let at = "";
    while (link !== null && before === null) {
        const page = JSON.parse(await (await fetch(link)).text()) as Page;
        if (holdsWork(page) !== undefined) { before = page; at = link; }
        link = page.older;
    }
    assert.ok(before !== null, "a page before the window holds the delegation's call");
    const work = holdsWork(before);
    assert.ok(work?.role === "assistant");
    const pageOf = async (): Promise<Page> => JSON.parse(await (await fetch(at)).text()) as Page;
    const callId = work.toolCalls?.[0]?.id ?? assert.fail("the delegation is a call");
    assert.equal(before.final, false, "a page whose call awaits its result is not final");
    assert.ok(!before.messages.some((message) => message.role === "tool" && message.toolCallId === callId), "and holds no result for it yet");

    held.resolve();
    await Promise.all([submitted, watched]);
    const late = results.find(({ toolCallId }) => toolCallId === callId);
    assert.ok(late !== undefined, "the result reaches the reader live, naming the call the page holds");
    const after = await pageOf();
    const index = after.messages.findIndex(({ id }) => id === work.id);
    const answer = after.messages[index + 1];
    assert.ok(answer?.role === "tool" && answer.toolCallId === callId, "fetched again, the page holds the result after its call");
    assert.equal(answer.id, late.messageId, "under the id the live result carried");
    assert.equal(after.final, true, "and is final once its loop has concluded");
});

test("{§agui-history-window} {§agui-history-page} {§agui-words-by-reference}: past the ceiling, a sender's words travel by reference and a model's call travels whole in a page of its own; every snapshot and other page stays within it", { timeout: 120_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const ceiling = 4000;
    // Model output JSON escapes twice over as a call's arguments; a person's newlines it doubles.
    const noted = `${"a \"quoted\" observation\n".repeat(220)}End of note.`;
    const pasted = `${"\n".repeat(2500)}End of paste.`;
    const held = Promise.withResolvers<void>();
    const { provider, called } = await scripted([
        { dsl: `\`\`\`\`NOTE\n${noted}\n\`\`\`\`` },
        { dsl: "````SEND [200]\nDone.\n````", hold: held.promise },
    ]);
    const previous = { loops: process.env.PLURNK_AGUI_HISTORY_LOOPS, chars: process.env.PLURNK_AGUI_HISTORY_PAGE_CHARS };
    Object.assign(process.env, { PLURNK_AGUI_HISTORY_LOOPS: "2", PLURNK_AGUI_HISTORY_PAGE_CHARS: String(ceiling) });
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
        Object.assign(process.env, { PLURNK_AGUI_HISTORY_LOOPS: previous.loops, PLURNK_AGUI_HISTORY_PAGE_CHARS: previous.chars });
    });
    await daemon.start();
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/agui`;
    const agent = (): HttpAgent => {
        const created = new HttpAgent({ url, threadId: "main" });
        agents.push(created);
        return created;
    };
    const submitter = agent();
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Note what you see." }];
    const submitted = submitter.runAgent({ forwardedProps: { plurnk: { workspace: "composed", control: true } } });
    await called(1);
    // While the loop holds, the person pastes more than the ceiling: accepted, and not yet observed.
    const paster = agent();
    paster.messages = [{ id: "prompt-2", role: "user", content: pasted }];
    // {§agui-message-acceptance} A message Run admits its message before it presents anything: once its snapshot
    // arrives, the pasted message is accepted.
    const admitted = Promise.withResolvers<void>();
    const pastedRun = paster.runAgent({ forwardedProps: { plurnk: { workspace: "composed" } } }, { onMessagesSnapshotEvent: () => { admitted.resolve(); } });
    await admitted.promise;

    const reader = agent();
    const snapshot = Promise.withResolvers<{ chars: number; history: History; messages: Message[] }>();
    const watched = reader.runAgent({ forwardedProps: { plurnk: { workspace: "composed" } } }, {
        onMessagesSnapshotEvent: ({ event }) => { snapshot.resolve({ chars: JSON.stringify(event).length, history: historyOf(event.metadata), messages: event.messages }); },
    });
    const window = await snapshot.promise;
    assert.ok(window.chars <= ceiling, `the snapshot serializes within the ceiling: ${window.chars}`);
    const accepted = window.messages.at(-1);
    assert.equal(accepted?.id, "prompt-2", "the accepted message travels last, under its sender's id");
    const parts = accepted?.content;
    const reference = Array.isArray(parts) ? parts[0] as { type: string; source?: { value?: string; mimeType?: string } } | undefined : undefined;
    assert.equal(reference?.type, "document", "its words, by reference");
    const fetched = await fetch(reference?.source?.value ?? "");
    assert.equal(fetched.status, 200);
    assert.equal(await fetched.text(), pasted, "one fetch returns them exactly");

    const pages = await pagesBefore(window.history.older);
    const isNote = (message: Message): boolean => message.role === "assistant" && message.toolCalls?.some(({ function: { name } }) => name === "NOTE") === true;
    const oversized = pages.filter(({ messages }) => messages.some(isNote));
    assert.equal(oversized.length, 1, "one page holds the model's call");
    const [alone] = oversized;
    assert.ok(alone !== undefined && alone.messages.every((message) => isNote(message) || message.role === "tool"), "the call and its result, alone");
    assert.ok(JSON.stringify(alone).length > ceiling, "the one page past the ceiling: model output, which travels whole");
    const call = alone.messages.find(isNote);
    const args = call?.role === "assistant" ? call.toolCalls?.[0]?.function.arguments : undefined;
    assert.equal((JSON.parse(args ?? "{}") as { body?: string }).body, noted, "whole: its arguments are the statement as written");
    for (const page of pages.filter((other) => other !== alone)) assert.ok(JSON.stringify(page).length <= ceiling, `every other page within the ceiling: ${JSON.stringify(page).length}`);
    const all = [...pages.flatMap(({ messages }) => messages), ...window.messages];
    assert.equal(new Set(all.map(({ id }) => id)).size, all.length, "no message appears twice");
    assert.ok(all.some(({ id }) => id === "prompt-1"), "the conversation's first message is in its first page");

    held.resolve();
    await Promise.all([submitted, pastedRun, watched]);
});

// {§agui-run-source} The client has an address. A run's user message is the causal actor
// behind the loop's message, and the module names it under the AG-UI principal the way the
// A2A adapter names its messages ({§message-causal-source}); the arrival row the model reads
// carries that source, so an operator's message is told from a worker's by address (#706).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import Module from "../../src/Module.ts";
import type { AguiEvent } from "../../src/types.ts";
import { openTestDatabase, SERVICE } from "./_helpers.ts";

const post = async (port: number, input: Readonly<Record<string, unknown>>): Promise<AguiEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: {}, messages: [], tools: [], context: [], ...input }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
};

test("{§agui-run-source}: active-loop injection keeps its source, survives curation and replays exactly once", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class PausedModel extends Mock {
        override async generate(...args: Parameters<Mock["generate"]>) {
            if (this.received.length === 0) {
                entered.resolve();
                await release.promise;
            }
            return super.generate(...args);
        }
    }
    // The injection's server-assigned address is available before the paused model resumes.
    const inspection = { assistant: { content: "", reasoning: null } };
    const provider = new PausedModel({ contextWindow: 32768, responses: [
        { assistant: { content: PlurnkParser.frame("NOTE", "Waiting for the injected requirement."), reasoning: null } },
        inspection,
        { assistant: { content: PlurnkParser.frame("NOTE", "Both messages were answered and the retained source was inspected."), reasoning: null } },
    ] });
    const db = await openTestDatabase();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    const started = Promise.withResolvers<Module>();
    const registration = Module.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({ setup: registration.setup, start: async (seam: ApplicationPort) => {
        const module = await registration.start(seam);
        started.resolve(module);
        return module;
    } });
    try {
        await daemon.start();
        const { port } = (await started.promise).address();
        const { workspaceId } = await daemon.createWorkspace({ name: "injected-source", projectRoot: null });
        const result = post(port, {
            threadId: "conversation", runId: "initial",
            messages: [{ id: "opening", role: "user", content: "Start the work." }],
            forwardedProps: { plurnk: { workspace: "injected-source", maxTurns: 4 } },
        });
        await entered.promise;
        const injected = await post(port, {
            threadId: "conversation", runId: "steering",
            forwardedProps: { plurnk: { workspace: "injected-source", action: { kind: "loop.inject", prompt: "Also check the new requirement." } } },
        });
        assert.equal(injected.at(-1)?.type, "RUN_FINISHED");
        assert.match(JSON.stringify(injected), /injected_next_turn/);
        const worker = (await daemon.listWorkers(workspaceId)).find(({ name }: { name: string }) => name === "conversation");
        assert.ok(worker);
        const messages = await daemon.readMessages({ workspaceId, workerId: worker.id });
        assert.equal(messages.length, 2, "the injection is a message in the existing loop, not another conversation");
        const message = messages.find(({ body }: { body: string }) => body === "Also check the new requirement.");
        assert.ok(message);
        assert.equal(message.loopId, messages[0]!.loopId);
        assert.match(message.source ?? "", /^agui:\/\/anonymous\/threads\/conversation\/messages\/[^/]+$/u);
        const envelope = message.envelope as { threadId: string; runId: string; message: { id: string; role: string; content: string } };
        assert.equal(envelope.runId, "steering");
        assert.equal(envelope.message.role, "user");
        assert.equal(envelope.message.content, message.body);
        inspection.assistant.content = [
            PlurnkParser.frame("KILL (log:///**/SEND)", ""),
            PlurnkParser.frame(`READ (${message.source}) <1,-1>`, ""),
            PlurnkParser.frame("SEND (agui://anonymous/threads/conversation/messages/opening)", "Initial request answered."),
            PlurnkParser.frame(`SEND (${message.source})`, "Injected requirement answered."),
        ].join("\n\n");
        release.resolve();
        const events = await result;
        assert.equal(events.at(-1)?.type, "RUN_FINISHED", JSON.stringify(events.at(-1)));
        assert.equal(provider.received.length, 3);
        const rows = await db.test_log_entries_by_loop.all({ loop_id: message.loopId }) as Array<{ op: string; origin: string; source: string; status_rx: number; rx: string }>;
        const arrival = rows.find(({ op, origin, source }) => op === "SEND" && origin === "_plurnk" && source === message.source);
        assert.ok(arrival, "the live arrival carries the conversation identity clients use to suppress their own echo");
        const model = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(model.map(({ op, status_rx }) => [op, status_rx]), [
            ["NOTE", 200], ["KILL", 200], ["READ", 200], ["SEND", 200], ["SEND", 200], ["NOTE", 200],
        ]);
        assert.equal(JSON.parse(model.find(({ op }) => op === "READ")!.rx).content, message.body);
        assert.ok(model.some(({ op, rx }) => op === "SEND" && JSON.parse(rx).answers.includes(message.source)));
        assert.deepEqual(events.filter(({ type }) => type === "TEXT_MESSAGE_CONTENT").map((event) => (event as { delta: string }).delta),
            ["Initial request answered.", "Injected requirement answered."]);
        const replay = await post(port, {
            threadId: "conversation", runId: "reconnected",
            forwardedProps: { plurnk: { workspace: "injected-source", mode: "sync" } },
        });
        const snapshot = replay.find(({ type }) => type === "MESSAGES_SNAPSHOT") as { messages: Array<{ id: string; role: string; content: string }> } | undefined;
        assert.ok(snapshot);
        assert.deepEqual(snapshot.messages.filter(({ role }) => role === "user").map(({ id, content }) => ({ id, content })), [
            { id: "opening", content: "Start the work." },
            { id: envelope.message.id, content: message.body },
        ]);
        assert.deepEqual(snapshot.messages.filter(({ role }) => role === "assistant").map(({ content }) => content),
            ["Initial request answered.", "Injected requirement answered."]);
    } finally {
        release.resolve();
        await daemon.stop();
        await db.close();
    }
});

test("{§agui-run-source}: a collaborator's exact reply reaches the assigned conversation live and on replay", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_rpc.ts")),
    ]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class PausedModel extends Mock {
        override async generate(...args: Parameters<Mock["generate"]>) {
            if (this.received.length === 0) {
                entered.resolve();
                await release.promise;
            }
            return super.generate(...args);
        }
    }
    const provider = new PausedModel({ contextWindow: 32768, responses: [
        makeMockResponse("````NOTE\nWorking on the request.\n````"),
        makeMockResponse("````NOTE\nThe collaborator's reply has answered the request.\n````"),
    ] });
    const db = await openTestDatabase();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    const started = Promise.withResolvers<Module>();
    const registration = Module.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({ setup: registration.setup, start: async (seam: ApplicationPort) => {
        const module = await registration.start(seam);
        started.resolve(module);
        return module;
    } });
    try {
        await daemon.start();
        const { port } = (await started.promise).address();
        const { workspaceId } = await daemon.createWorkspace({ name: "collaborative-reply", projectRoot: null });
        const collaborator = await daemon.createConversationWorker({ workspaceId, name: "collaborator" });
        const result = post(port, {
            threadId: "assigned", runId: "initial",
            messages: [{ id: "question", role: "user", content: "What is the result?" }],
            forwardedProps: { plurnk: { workspace: "collaborative-reply", maxTurns: 3 } },
        });
        await entered.promise;
        const address = "agui://anonymous/threads/assigned/messages/question";
        const parsed = PlurnkParser.parseStatements(PlurnkParser.frame(`SEND (${address})`, "A collaborator found 42."));
        assert.equal(parsed.items.length, 1);
        const item = parsed.items[0]!;
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement") throw new Error("The exact-reply fixture did not parse.");
        assert.equal((await daemon.dispatchAsClient({ workspaceId, workerId: collaborator.workerId, statement: item.statement })).status, 200);
        release.resolve();
        const events = await result;
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
        assert.deepEqual(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => (event as { delta: string }).delta),
            ["A collaborator found 42."], "the client-authored foreign answer is delivered once through standard AG-UI speech");
        assert.equal(provider.received.length, 2, "the assigned model observes the reply before concluding");
        const replay = await post(port, {
            threadId: "assigned", runId: "reconnect",
            forwardedProps: { plurnk: { workspace: "collaborative-reply", mode: "sync" } },
        });
        const snapshot = replay.find((event) => event.type === "MESSAGES_SNAPSHOT") as { messages?: Array<{ role: string; content: string }> } | undefined;
        assert.deepEqual(snapshot?.messages?.filter(({ role }) => role === "assistant").map(({ content }) => content), ["A collaborator found 42."]);
    } finally {
        release.resolve();
        await daemon.stop();
        await db.close();
    }
});

test("{§agui-run-source}: a curated arrival remains readable, copyable and replyable by its conversation message address", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")),
        import(join(SERVICE, "test/intg/_rpc.ts")),
    ]);
    const expected = "agui://anonymous/threads/run-source/messages/message%201";
    const provider = new Mock({
        contextWindow: 32768,
        responses: [
            makeMockResponse([
                "````KILL (log:///**/SEND)\n````",
                `\`\`\`\`READ (${expected}) <1,-1>\n\`\`\`\``,
                `\`\`\`\`COPY (${expected}) (worker:///retained-message.md)\n\`\`\`\``,
                `\`\`\`\`SEND (${expected})\nNamed.\n\`\`\`\``,
            ].join("\n\n"), 10),
            makeMockResponse("````NOTE\nThe retained message was read and copied; its reply was delivered.\n````", 10),
        ],
    });
    const db = await openTestDatabase();
    const root = await mkdtemp(join(tmpdir(), "plurnk-run-source-"));
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    let module: Module | null = null;
    const registration = Module.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({
        setup: registration.setup,
        start: async (seam: ApplicationPort) => {
            module = await registration.start(seam);
            return module;
        },
    });
    await daemon.start({ host: "127.0.0.1", port: 0 });

    try {
        const port = (module as unknown as Module).address().port;
        const events = await post(port, {
            threadId: "run-source",
            runId: "run-1",
            messages: [{ id: "message 1", role: "user", content: "Name your sender." }],
            forwardedProps: { plurnk: { workspace: "run-source", projectRoot: root, policy: { proposals: "accept" }, maxTurns: 3 } },
        });
        const terminal = events.at(-1) as { type?: string; outcome?: { type?: string } } | undefined;
        assert.equal(terminal?.type, "RUN_FINISHED", JSON.stringify(terminal));
        assert.equal(terminal?.outcome?.type, "success");

        const loops = (await db.test_all_loops.all()) as Array<{ id: number }>;
        const prompts = (await Promise.all(loops.map(async ({ id }) => {
            const rows = (await db.test_log_entries_by_loop.all({ loop_id: id })) as Array<{ op: string; origin: string; source: string | null; attrs: string }>;
            return rows.filter((row) => row.op === "SEND" && row.origin === "_plurnk").map((row) => ({ ...row, loopId: id }));
        }))).flat();
        assert.equal(prompts.length, 1, "the run published exactly one arrival row");
        const [prompt] = prompts;
        assert.equal(prompt!.origin, "_plurnk", "the harness published the row");
        assert.equal(prompt!.source, expected, "the row's causal actor is the AG-UI message, URI-encoded per segment");

        const turns = (await db.test_list_turns_in_loop.all({ loop_id: prompt!.loopId })) as Array<{ packet: string | null }>;
        const logSections = turns.flatMap(({ packet }) => packet === null ? [] : (JSON.parse(packet) as {
            sections?: Array<{ name: string; content: string }>;
        }).sections?.filter((section) => section.name === "log") ?? []);
        assert.ok(
            logSections.some(({ content }) => content.includes(`"source":"${expected}"`)),
            "the packet renders the source on the arrival row, so the model reads the sender by address",
        );
        const promptSections = turns.flatMap(({ packet }) => packet === null ? [] : (JSON.parse(packet) as {
            sections?: Array<{ name: string; content: string }>;
        }).sections?.filter((section) => section.name === "messages") ?? []);
        assert.ok(
            promptSections.some(({ content }) => JSON.parse(content).some((message: { path: string }) => message.path === expected)),
            "Open Messages names the immutable message rather than the curatable arrival",
        );
        assert.ok(
            !logSections.some(({ content }) => /### log:\/\/\/\d+\/\d+\/\d+\/SEND\n\{[^\n]*"origin":"_plurnk"/.test(content)),
            "the arrival row carries no constant origin",
        );
        const rows = await db.test_log_entries_by_loop.all({ loop_id: prompt!.loopId }) as Array<{ op: string; origin: string; status_rx: number; rx: string }>;
        const model = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(model.map(({ op, status_rx }) => [op, status_rx]), [
            ["KILL", 200], ["READ", 200], ["COPY", 201], ["SEND", 200], ["NOTE", 200],
        ], "curation does not destroy the source and observation completes without another reply");
        assert.equal(JSON.parse(model.find(({ op }) => op === "READ")!.rx).content, "Name your sender.");
        assert.deepEqual(JSON.parse(model.find(({ op }) => op === "SEND")!.rx).answers, [expected]);
        assert.equal(events.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => (event as { delta: string }).delta).join(""), "Named.");

        const replay = await post(port, {
            threadId: "run-source", runId: "reconnect",
            forwardedProps: { plurnk: { workspace: "run-source", mode: "sync" } },
        });
        const snapshot = replay.find((event) => event.type === "MESSAGES_SNAPSHOT") as { messages?: Array<{ id: string; role: string; content: string }> } | undefined;
        assert.ok(snapshot, "reconnecting obtains standard AG-UI message history");
        assert.deepEqual(snapshot.messages?.filter(({ role }) => role === "user").map(({ id, content }) => ({ id, content })),
            [{ id: "message 1", content: "Name your sender." }], "curation preserves the original client message and its ID");
        assert.deepEqual(snapshot.messages?.filter(({ role }) => role === "assistant").map(({ content }) => content), ["Named."],
            "the exact-address response replays once");

        const duplicate = await post(port, {
            threadId: "run-source", runId: "different-run-same-message",
            messages: [{ id: "message 1", role: "user", content: "Replace the original." }],
            forwardedProps: { plurnk: { workspace: "run-source" } },
        });
        assert.ok(duplicate.some((event) => event.type === "RUN_ERROR"));
        assert.match(JSON.stringify(duplicate), /message-already-accepted/);
        assert.equal(provider.received.length, 2, "a conflicting message identity cannot launch another inference");
        const workspace = (await daemon.listWorkspaces()).find(({ name }: { name: string }) => name === "run-source");
        assert.ok(workspace);
        const retained = await db.message_source_by_address.get({ workspace_id: workspace.id, path: expected });
        assert.equal(retained?.body, "Name your sender.");
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

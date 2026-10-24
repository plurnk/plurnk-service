import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

interface Frame {
    type: string;
    delta?: string;
    toolCallId?: string;
    content?: string;
    outcome?: { type: string; interrupts?: Array<{ id: string; toolCallId?: string }> };
}
const frames = (body: string): Frame[] => body.split("\n\n")
    .filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as Frame);

test("{§acp-owner-connection}: an idle owner receives a later child gate; observers cannot resolve it", { timeout: 30000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }, { waitForDb }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")), import(join(SERVICE, "test/intg/_rpc.ts")),
    ]);
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, nodeModulesPath: join(SERVICE, "node_modules"), provider: new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````sh\necho owner-reviewed\n````"), makeMockResponse("````SEND [200]\nReviewed work complete.\n````"),
    ] }) });
    const cancellation = new AbortController();
    const post = (path: string, threadId: string, input: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${http.httpAddress().port}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: cancellation.signal,
        body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
            forwardedProps: { plurnk: { workspace: "ownership", control: true } }, ...input }),
    });
    try {
        await daemon.start();
        // {§acp-owner-connection} The owner's connection creates the worker its thread names.
        const listening = await post("/acp/connect", "operator");
        assert.equal(listening.status, 200);
        const pendingEvents = listening.text();
        const [workspace] = await daemon.listWorkspaces();
        const parent = await daemon.readWorker({ workspaceId: workspace.id, identity: { name: "operator" } });
        assert.equal(parent.owner, "acp://operator");
        assert.deepEqual(await daemon.listWorkerLoops({ workspaceId: workspace.id, workerId: parent.id }), [], "connection admits no inference");
        const child = await daemon.createWorker({ workspaceId: workspace.id, parentWorkerId: parent.id, name: "background" });
        await daemon.runLoop({ workspaceId: workspace.id, workerId: child.workerId, prompt: "Run the shell command." });
        const events = frames(await pendingEvents);
        const terminal = events.at(-1);
        assert.equal(terminal?.outcome?.type, "interrupt");
        const interruptId = terminal?.outcome?.interrupts?.[0]?.id;
        assert.ok(interruptId);
        // {§acp-proposal-resolve} The owner's Run holds no call of the child: the gate names none and carries the child's
        // operation as Core projects it.
        const gate = terminal?.outcome?.interrupts?.[0] as { toolCallId?: string; metadata?: { plurnk?: { proposal?: { worker?: string; op?: string } } } } | undefined;
        assert.deepEqual([gate?.toolCallId, gate?.metadata?.plurnk?.proposal?.worker, gate?.metadata?.plurnk?.proposal?.op], [undefined, "background", "sh"]);

        const answer = { resume: [{ interruptId, status: "resolved", payload: { decision: "accept" } }] };
        const wrong = frames(await (await post("/acp", "observer", answer)).text());
        assert.equal(wrong.at(-1)?.type, "RUN_ERROR");
        assert.equal((await daemon.pendingProposals(workspace.id)).length, 1);
        assert.equal((await daemon.readWorker({ workspaceId: workspace.id, identity: { id: child.workerId } })).owner, parent.owner);
        const resolved = frames(await (await post("/acp", "operator", answer)).text());
        assert.equal(resolved.at(-1)?.outcome?.type, "success", JSON.stringify(resolved));
        assert.equal(resolved.some(({ type }) => type === "TOOL_CALL_RESULT"), false, "the decision is no result of its own");
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId: workspace.id, workerId: child.workerId }),
            (loops: Array<{ terminalResult: { status: number } | null }>) => loops.some(({ terminalResult }) => terminalResult?.status === 200));
        assert.deepEqual(await daemon.pendingProposals(workspace.id), []);
        const duplicate = frames(await (await post("/acp", "operator", answer)).text());
        assert.equal(duplicate.at(-1)?.type, "RUN_ERROR", "a second connection cannot settle a consumed gate");
    } finally { cancellation.abort(); await daemon.stop(); await http.close(); await db.close(); }
});

test("{§acp-worker-owner} {§acp-held-interrupts}: concurrent clients on the same worker receive separate presentations of its gate and converge when one answers", { timeout: 30000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }, { waitForDb }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")), import(join(SERVICE, "test/intg/_rpc.ts")),
    ]);
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, nodeModulesPath: join(SERVICE, "node_modules"), provider: new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````sh\necho multi-client\n````"), makeMockResponse("````SEND [200]\nDone.\n````"),
    ] }) });
    const cancellation = new AbortController();
    const post = (path: string, threadId: string, plurnk: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
        fetch(`http://127.0.0.1:${http.httpAddress().port}${path}`, {
            method: "POST", headers: { "content-type": "application/json" }, signal: cancellation.signal,
            body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                forwardedProps: { plurnk: { workspace: "multi", control: true, ...plurnk } }, ...input }),
        });
    try {
        await daemon.start();
        // Pane 1 (named thread) creates and attaches to worker; Pane 2 (qualified thread) and Browser window (named thread) attach concurrently.
        const initial = frames(await (await post("/acp", "worker")).text());
        assert.equal(initial.at(-1)?.outcome?.type, "success");
        const [workspace] = await daemon.listWorkspaces();
        const qualifiedThread = `${workspace.id}#worker`;

        const paneA = (await post("/acp/connect", qualifiedThread)).text();
        const browserB = (await post("/acp/connect", "worker")).text();

        const worker = await daemon.readWorker({ workspaceId: workspace.id, identity: { name: "worker" } });
        await daemon.runLoop({ workspaceId: workspace.id, workerId: worker.id, prompt: "Propose a shell command." });

        const [eventsA, eventsB] = [frames(await paneA), frames(await browserB)];
        const idA = eventsA.at(-1)?.outcome?.interrupts?.[0]?.id;
        const idB = eventsB.at(-1)?.outcome?.interrupts?.[0]?.id;
        assert.ok(idA && idB && idA !== idB, "each connected client receives its own interrupt presentation ID");

        // Both clients reconnect holding their respective interrupt IDs while the operator decides.
        const heldA = (await post("/acp/connect", qualifiedThread, { interrupts: [idA] })).text();
        const heldB = (await post("/acp/connect", "worker", { interrupts: [idB] })).text();

        // Answering in Browser B resolves the gate in Core and settles both held connections ({§acp-held-interrupts}).
        const resumedB = frames(await (await post("/acp", "worker", {}, {
            resume: [{ interruptId: idB, status: "resolved", payload: { decision: "accept" } }],
        })).text());
        assert.equal(resumedB.at(-1)?.outcome?.type, "success");
        const [settledA, settledB] = [frames(await heldA), frames(await heldB)];
        assert.equal(settledA.at(-1)?.outcome?.type, "success");
        assert.equal(settledB.at(-1)?.outcome?.type, "success");

        await waitForDb(() => daemon.listWorkerLoops({ workspaceId: workspace.id, workerId: worker.id }),
            (loops: Array<{ terminalResult: { status: number } | null }>) => loops.some(({ terminalResult }) => terminalResult?.status === 200));
    } finally { cancellation.abort(); await daemon.stop(); await http.close(); await db.close(); }
});

test("{§acp-worker-owner}: switching to a spawned child worker or a client-created worker claims and resolves its proposals and interactions", { timeout: 30000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
    ]);
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, nodeModulesPath: join(SERVICE, "node_modules"), provider: new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````WORK (worker:///spawned)````"),
        makeMockResponse("````SEND [200]\nSpawned child.\n````"),
        makeMockResponse('````question\n{"message":"Proceed?","requestedSchema":{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}}\n````'),
        makeMockResponse("````SEND [200]\nChild answered.\n````"),
        makeMockResponse("````sh\necho helper-ok\n````"),
        makeMockResponse("````SEND [200]\nHelper done.\n````"),
    ] }) });
    const tools = [{ name: "question", description: "Ask the operator a question.", parameters: { type: "object" } }];
    const post = (threadId: string, plurnk: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
        fetch(`http://127.0.0.1:${http.httpAddress().port}/acp`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages: [], tools, context: [],
                forwardedProps: { plurnk: { workspace: "tabs", control: true, interactive: true, ...plurnk } }, ...input }),
        });
    try {
        await daemon.start();
        // 1. Parent spawns a child worker ("spawned"); client also creates a worker ("helper") via op.parse.
        const parentEvents = frames(await (await post("parent", {}, {
            messages: [{ id: "m-parent", role: "user", content: "Spawn a child." }],
        })).text());
        assert.equal(parentEvents.at(-1)?.outcome?.type, "success", JSON.stringify(parentEvents.at(-1)));

        const opEvents = frames(await (await post("parent", {
            control: false, action: { kind: "op.parse", text: "````WORK (worker:///helper)````" },
        })).text());
        assert.equal(opEvents.at(-1)?.type, "RUN_FINISHED");

        const [workspace] = await daemon.listWorkspaces();
        // 2. Switch to `${workspace.id}#spawned` and prompt it: it runs `question`, delivering an interaction interrupt on `${workspace.id}#spawned`.
        const childThread = `${workspace.id}#spawned`;
        const childInterrupted = frames(await (await post(childThread, {}, {
            messages: [{ id: "m-child", role: "user", content: "Ask me." }],
        })).text());
        assert.equal(childInterrupted.at(-1)?.outcome?.type, "interrupt");
        const childInterruptId = childInterrupted.at(-1)?.outcome?.interrupts?.[0]?.id;
        assert.ok(childInterruptId);
        const childResumed = frames(await (await post(childThread, {}, {
            resume: [{ interruptId: childInterruptId, status: "resolved", payload: { proceed: true } }],
        })).text());
        assert.equal(childResumed.at(-1)?.outcome?.type, "success", JSON.stringify(childResumed));

        // 3. Switch to `${workspace.id}#helper` (created by client op under `_plurnk`): control attachment claims it for `acp://operator` and delivers its proposal.
        const helperThread = `${workspace.id}#helper`;
        const helperInterrupted = frames(await (await post(helperThread, {}, {
            messages: [{ id: "m-helper", role: "user", content: "Run sh." }],
        })).text());
        assert.equal((await daemon.readWorker({ workspaceId: workspace.id, identity: { name: "helper" } })).owner, "acp://operator");
        assert.equal(helperInterrupted.at(-1)?.outcome?.type, "interrupt");
        const helperInterruptId = helperInterrupted.at(-1)?.outcome?.interrupts?.[0]?.id;
        assert.ok(helperInterruptId);
        const helperResumed = frames(await (await post(helperThread, {}, {
            resume: [{ interruptId: helperInterruptId, status: "resolved", payload: { decision: "accept" } }],
        })).text());
        assert.equal(helperResumed.at(-1)?.outcome?.type, "success");
    } finally { await daemon.stop(); await http.close(); await db.close(); }
});

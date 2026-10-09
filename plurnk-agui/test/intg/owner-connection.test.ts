import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const tools = [{ name: "request_approval", description: "Review operations", parameters: { type: "object" } }];
interface Frame {
    type: string;
    delta?: string;
    toolCallId?: string;
    content?: string;
    outcome?: { type: string; interrupts?: Array<{ id: string }> };
}
const frames = (body: string): Frame[] => body.split("\n\n")
    .filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as Frame);

test("{§agui-owner-connection}: an idle owner receives a later child gate; observers cannot resolve it", { timeout: 30000 }, async () => {
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
        body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages: [], tools, context: [],
            forwardedProps: { plurnk: { workspace: "ownership", control: true } }, ...input }),
    });
    try {
        await daemon.start();
        const listening = await post("/agui/connect", "operator");
        assert.equal(listening.status, 200);
        const pendingEvents = listening.text();
        const [workspace] = await daemon.listWorkspaces();
        const parent = await daemon.readWorker({ workspaceId: workspace.id, identity: { name: "operator" } });
        assert.equal(parent.owner, "agui://anonymous/threads/operator");
        assert.deepEqual(await daemon.listWorkerLoops({ workspaceId: workspace.id, workerId: parent.id }), [], "connection admits no inference");
        const child = await daemon.createConversationWorker({ workspaceId: workspace.id, parentWorkerId: parent.id, name: "background" });
        await daemon.runLoop({ workspaceId: workspace.id, workerId: child.workerId, prompt: "Run the shell command." });
        const events = frames(await pendingEvents);
        const terminal = events.at(-1);
        assert.equal(terminal?.outcome?.type, "interrupt");
        const interruptId = terminal?.outcome?.interrupts?.[0]?.id;
        assert.ok(interruptId);
        const args = events.find(({ type }) => type === "TOOL_CALL_ARGS");
        assert.ok(args?.delta);
        assert.equal(JSON.parse(args.delta).owner, parent.owner);

        const answer = { resume: [{ interruptId, status: "resolved", payload: { decision: "accept" } }] };
        const wrong = frames(await (await post("/agui", "observer", answer)).text());
        assert.equal(wrong.at(-1)?.type, "RUN_ERROR");
        assert.equal((await daemon.pendingProposals(workspace.id)).length, 1);
        assert.equal((await daemon.readWorker({ workspaceId: workspace.id, identity: { id: child.workerId } })).owner, parent.owner);
        const resolved = frames(await (await post("/agui", "operator", answer)).text());
        assert.equal(resolved.at(-1)?.outcome?.type, "success", JSON.stringify(resolved));
        const acknowledgement = resolved.find(({ type, toolCallId }) => type === "TOOL_CALL_RESULT" && toolCallId === interruptId);
        assert.deepEqual(JSON.parse(acknowledgement?.content ?? "null"), { status: "resolved", payload: { decision: "accept" } });
        await waitForDb(() => daemon.listWorkerLoops({ workspaceId: workspace.id, workerId: child.workerId }),
            (loops: Array<{ terminalResult: { status: number } | null }>) => loops.some(({ terminalResult }) => terminalResult?.status === 200));
        assert.deepEqual(await daemon.pendingProposals(workspace.id), []);
        const duplicate = frames(await (await post("/agui", "operator", answer)).text());
        assert.equal(duplicate.at(-1)?.type, "RUN_ERROR", "a second connection cannot settle a consumed gate");
    } finally { cancellation.abort(); await daemon.stop(); await http.close(); await db.close(); }
});

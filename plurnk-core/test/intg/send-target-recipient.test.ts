// {§send-target-recipient} — a SEND addressed to a non-recipient (an unowned prompt path,
// a file path) states the address contract without guessing what the model intended.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";

test("a SEND addressed to a prompt path that is not this loop's own is refused 400 with neutral recipient guidance", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```SEND (prompt:///1/1)\nthe answer\n```", 10),
        makeMockResponse("```SEND\nthe answer\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "answer me", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the target-less reply concluded on the second turn");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 400, "the directed SEND was refused 400, not 403");
            const problem = (JSON.parse(sends[0]!.rx) as { problem?: Record<string, unknown> }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/send-target-not-a-recipient");
            assert.equal(problem?.detail, "The addressed scheme is not a SEND recipient.");
            assert.equal(problem?.recovery, "A targetless SEND answers the active prompt; a directed SEND requires a recipient that implements SEND.");
            assert.doesNotMatch(JSON.stringify(problem), /meant|intended|wanted|tried/u);
            assert.ok(!sends.some((r) => r.status_rx === 403), "the writer rule never speaks first");
            assert.deepEqual(rows.filter((r) => r.op === "TASK" && r.origin === "model").map(({ status_rx }) => status_rx), [200], "omission continues silently; the explicit completed inventory concludes");
        } finally { ws.close(); }
    });
});

test("a SEND addressed to a file path preserves the scheme's factual 501", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```SEND (.)\nwaiting\n```", 10),
        makeMockResponse("```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target-file" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const first = rows.filter((r) => r.op === "SEND" && r.origin === "model")[0];
            assert.equal(first?.status_rx, 501);
            const problem = (JSON.parse(first!.rx) as { problem?: Record<string, unknown> }).problem;
            assert.equal(problem?.detail, "Scheme 'file' does not implement SEND.");
            assert.equal(problem?.recovery, undefined);
        } finally { ws.close(); }
    });
});

// {§send-prompt-acceptance} — the model addresses the prompt the packet showed it under
// Active Prompts; the mock follows that real address the way StreamMock follows a stream's.
class PromptMock extends Mock {
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$PROMPT")) return response;
        const text = args[0].messages.map(chatMessageText).join("\n");
        const prompt = /(prompt:\/\/[a-z0-9-]+\/\d+\/[a-f0-9]{8})/.exec(text)?.[1];
        assert.ok(prompt, "the packet lists the prompt address the program addresses");
        const { ops: _ops, ...assistant } = response.assistant;
        return { ...response, assistant: { ...assistant, content: assistant.content.replaceAll("$PROMPT", prompt) } };
    }
}

test("{§send-prompt-acceptance}: a SEND to this loop's own prompt is the response, and joins the result", async () => {
    const mock = new PromptMock({ contextWindow: 16384, responses: [
        makeMockResponse("```SEND ($PROMPT)\nthe addressed answer\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-own-prompt" });
            const { finalStatus, loopId, result } = await runLoopToTerminal(ws, 2, { prompt: "answer me", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the prompt-addressed reply completed the loop on its first turn");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string }>({ loop_id: loopId });
            const send = rows.find((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(send?.status_rx, 200, "accepted exactly as an untargeted SEND");
            assert.match((JSON.parse(send!.tx) as { target: { raw: string } }).target.raw, /^prompt:\/\//, "the row keeps the address the model wrote");
            assert.equal((result as { content?: string } | undefined)?.content, "the addressed answer", "the body is the loop's response");
        } finally { ws.close(); }
    });
});

test("{§send-prompt-acceptance}: another worker's prompt is still not a recipient", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```SEND (prompt://someone-else/1/0123abcd)\nmisdirected\n```", 10),
        makeMockResponse("```SEND\nthe answer\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-other-prompt" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "answer me", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const first = rows.filter((r) => r.op === "SEND" && r.origin === "model")[0];
            assert.equal(first?.status_rx, 400);
            assert.equal((JSON.parse(first!.rx) as { problem?: { type?: string } }).problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/send-target-not-a-recipient");
        } finally { ws.close(); }
    });
});

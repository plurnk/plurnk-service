// {§send-looks-like-operation} — a model reply whose first line is an operation heading is a
// mis-fenced operation, refused at dispatch so nothing is silently delivered as a reply.
// {§send-response-receipt} — a delivered reply names the prompts it answered.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";
import { promptLoopPrefix } from "../../src/core/plurnk-uri.ts";

const DONE = "```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";

// The 2026-09-11 dogfood, verbatim in shape: every operation on the line after its fence.
const MISFENCED = [
    "````\nsh <!-- brand presence -->\nprintf plurnk\n````",
    "````\nREAD (https://plurnk.ai/) <!-- retry; 530 was marked retryable after 120s -->\n````",
    "````\nTASK\n[{\"content\": \"Research positioning\", \"status\": \"in_progress\"}]\n````",
].join("\n\n");

test("{§send-looks-like-operation}: operations on the line after a bare fence are refused, never delivered as replies", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse(MISFENCED, 10),
        makeMockResponse(`\`\`\`SEND\nthe answer\n\`\`\`\n${DONE}`, 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-misfenced" });
            const { finalStatus, loopId, result } = await runLoopToTerminal(ws, 2, { prompt: "research plurnk", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the corrected second turn concludes");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string; turn_id: number }>({ loop_id: loopId });
            const model = rows.filter((r) => r.origin === "model");
            const refused = model.slice(0, 3);
            assert.deepEqual(refused.map(({ op, status_rx }) => ({ op, status_rx })), [
                { op: "SEND", status_rx: 400 },
                { op: "SEND", status_rx: 400 },
                { op: "SEND", status_rx: 400 },
            ], "each bare fence parsed as a SEND and each was refused");
            const problems = refused.map((r) => (JSON.parse(r.rx) as { problem: Record<string, unknown> }).problem);
            for (const problem of problems) {
                assert.equal(problem.type, "https://problems.plurnk.xyz/engine/dispatcher/send-looks-like-operation");
                assert.equal(problem.retryable, false);
                assert.doesNotMatch(String(problem.detail), /meant|intended|wanted|tried/u);
            }
            assert.deepEqual(problems.map((p) => p.heading), [
                "sh <!-- brand presence -->",
                "READ (https://plurnk.ai/) <!-- retry; 530 was marked retryable after 120s -->",
                "TASK",
            ], "the refusal names the heading it saw");
            assert.equal(problems[1]!.recovery, "An operation goes on the fence line (````READ (https://plurnk.ai/) <!-- retry; 530 was marked retryable after 120s -->); a quoted example goes inside a SEND body.");
            assert.ok(!model.some((r) => r.op === "EXEC" || r.op === "READ"), "nothing ran: the refusal is not a promotion into an operation");
            assert.equal((result as { content?: string } | undefined)?.content, "the answer", "only the real reply is the loop's response");
            const shells = await db.test_get_entry_by_pathname_scheme.get({ scheme: "sh", pathname: "/1/1/1/sh" });
            assert.equal(shells, undefined, "no shell spawned");
        } finally { ws.close(); }
    });
});

test("{§send-looks-like-operation}: prose that merely starts with an operation word, and an unregistered name, are ordinary replies", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````\nREAD (belfry.md) returned nothing because the file is empty.\n````\n\n````\nDone\n````\n\n````\nsh is the default shell here.\n````", 10),
        makeMockResponse(`\`\`\`SEND\nthe answer\n\`\`\`\n${DONE}`, 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-prose" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "explain", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.origin === "model" && r.op === "SEND");
            assert.deepEqual(sends.map(({ status_rx }) => status_rx), [200, 200, 200, 200], "a first line that does not parse alone as a known operation's heading is a reply");
        } finally { ws.close(); }
    });
});

test("{§send-response-receipt}: a delivered reply names the Active Prompts it answered", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse(`\`\`\`SEND\nthe answer\n\`\`\`\n${DONE}`, 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-receipt" });
            const { finalStatus, loopId, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "answer me", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const send = rows.find((r) => r.origin === "model" && r.op === "SEND");
            assert.equal(send?.status_rx, 200);
            const { recipients } = JSON.parse(send!.rx) as { recipients: string[] };
            const workerId = modelWorkerId!;
            const worker = await db.worker_get.get<{ name: string }>({ id: workerId });
            const prefix = promptLoopPrefix(1);
            const prompts = await db.drain_get_all_prompt_bodies_for_loop.all<{ pathname: string }>({ worker_id: workerId, pattern: `${prefix}%`, prefix_len: prefix.length });
            assert.equal(prompts.length, 1, "one prompt in the loop");
            assert.deepEqual(recipients, prompts.map((p) => `prompt://${worker!.name}${p.pathname}`), "the receipt names the prompt address the packet listed");
            assert.match(recipients[0]!, /^prompt:\/\/[a-z0-9-]+\/1\/[a-f0-9]{8}$/u);
        } finally { ws.close(); }
    });
});

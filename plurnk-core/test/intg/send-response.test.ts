// {§send-looks-like-operation} — an explicit SEND whose first line is an operation heading is a
// mis-fenced operation, refused at dispatch so nothing is silently delivered as a reply; a heading
// outside any fence is prose with the parser's advisory ({§bare-heading-advisory}).
// {§send-response-receipt} — a delivered reply names the prompts it answered.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, makeRawMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";
import { promptLoopPrefix } from "../../src/core/plurnk-uri.ts";

const DONE = "```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";

// The 2026-09-11 dogfood, verbatim in shape: every operation on the line after its fence.
const MISFENCED = [
    "````\nsh <!-- brand presence -->\nprintf plurnk\n````",
    "````\nREAD (https://plurnk.ai/) <!-- retry; 530 was marked retryable after 120s -->\n````",
    "````\nTASK\n[{\"content\": \"Research positioning\", \"status\": \"in_progress\"}]\n````",
].join("\n\n");

test("{§bare-heading-advisory}: operations on the line after a bare fence are prose; the rejection names the fence form and nothing runs", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse(MISFENCED, 10),
        makeMockResponse(`\`\`\`SEND\nthe answer\n\`\`\`\n${DONE}`, 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-misfenced" });
            const { finalStatus, loopId, result } = await runLoopToTerminal(ws, 2, { prompt: "research plurnk", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the corrected second attempt concludes");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; turn_id: number }>({ loop_id: loopId });
            const model = rows.filter((r) => r.origin === "model");
            assert.deepEqual(model.map(({ op }) => op), ["SEND", "TASK"], "only the corrected attempt produced operations");
            assert.ok(!model.some((r) => r.op === "EXEC" || r.op === "READ"), "nothing ran: prose is never promoted into an operation");
            const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: model[0]!.turn_id });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 1], "the misfenced attempt was rejected, the corrected one admitted");
            const messages = (JSON.parse(attempts[0]!.parse_errors) as Array<{ message: string }>).map(({ message }) => message);
            assert.ok(messages.some((m) => /no valid Plurnk operation/u.test(m)), "the rejection names the absence");
            for (const heading of ["sh", "READ", "TASK"]) {
                assert.ok(messages.some((m) => m.startsWith(`\`${heading}\` on line`) && /outside any fence, so it is prose and nothing ran; an operation opens with ````/u.test(m)), heading);
            }
            assert.equal((result as { content?: string } | undefined)?.content, "the answer", "only the real reply is the loop's response");
            const shells = await db.test_get_entry_by_pathname_scheme.get({ scheme: "sh", pathname: "/1/1/1/sh" });
            assert.equal(shells, undefined, "no shell spawned");
        } finally { ws.close(); }
    });
});

test("{§send-looks-like-operation}: prose that merely starts with an operation word, and an unregistered name, are ordinary replies", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND\nREAD (belfry.md) returned nothing because the file is empty.\n````\n\n````SEND\nDone\n````\n\n````SEND\nsh is the default shell here.\n````", 10),
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

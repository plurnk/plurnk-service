// {§send-looks-like-operation} — an explicit SEND whose first line is an operation heading is a
// mis-fenced operation, refused at dispatch so nothing is silently delivered as a reply; a heading
// outside any fence is prose with the parser's advisory ({§bare-heading-advisory}).
// {§send-response-receipt} — a delivered reply names the open messages it answered.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, makeRawMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";
import { lastReply } from "./_helpers.ts";

// Every operation is on the line after its fence.
const MISFENCED = [
    "````\nsh <!-- brand presence -->\nprintf plurnk\n````",
    "````\nREAD (https://example.invalid/) <!-- retry; 530 was marked retryable after 120s -->\n````",
    "````\nWAIT\nResearch positioning.\n````",
].join("\n\n");

test("{§balanced-fences}: a complete nested reply reaches the client without executing its examples", async () => {
    const body = [
        "The syntax and command are examples:",
        "```text", "````OP (path)? <scope>?", "body", "````", "```",
        "````sh", "printf must-not-execute", "````",
        "The rest of the answer survives intact. 🙂",
    ].join("\n");
    const source = `\`\`\`\`SEND\n${body}\n\`\`\`\``;
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse(source, 10),
        makeMockResponse("````SEND\nUnexpected continuation.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-nested-fences" });
            const { finalStatus, loopId, result, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "Explain with examples.", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200);
            assert.equal(result.content, undefined);
            assert.equal(await lastReply(db, loopId), body, "the client receives the entire answer, not its prefix");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["SEND", 200]], "quoted commands produce no dispatch, proposals or execution receipts");
            const turns = await db.test_list_turns_in_loop.all<{ producer: string }>({ loop_id: loopId });
            assert.equal(turns.filter(({ producer }) => producer === "model").length, 1, "no recovery turn or unnecessary continuation");
            const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: modelWorkerId! });
            assert.ok(sources.some((row) => row.kind === "ops" && row.content === source), "the original emission remains forensic evidence");
        } finally { ws.close(); }
    });
});

test("{§empty-turn}: operations on the line after a bare fence make an empty turn with the advisories as notices; nothing runs", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse(MISFENCED, 10),
        makeMockResponse("```SEND\nthe answer\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-misfenced" });
            const { finalStatus, loopId, result, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "research plurnk", policy: { proposals: "accept" } });
            assert.equal(finalStatus, 200, "the corrected second turn concludes");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; turn_id: number }>({ loop_id: loopId });
            const model = rows.filter((r) => r.origin === "model");
            assert.deepEqual(model.map(({ op }) => op), ["SEND"], "only the corrected turn produced operations");
            assert.ok(!model.some((r) => isExecutionOp(r.op) || r.op === "READ"), "nothing ran: prose is never promoted into an operation");
            const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: model[0]!.turn_id });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [1], "the corrected turn was admitted on its first attempt: the empty turn before it was never resampled");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: modelWorkerId! });
            assert.ok(sources.some((row) => row.kind === "ops" && row.content === MISFENCED), "the empty turn's text is stored as its ops source");
            assert.equal(result.content, undefined);
            assert.equal(await lastReply(db, loopId), "the answer");
            const shells = await db.test_get_entry_by_pathname_scheme.get({ scheme: "sh", pathname: "/1/1/1/sh" });
            assert.equal(shells, undefined, "no shell spawned");
        } finally { ws.close(); }
    });
});

test("{§send-looks-like-operation}: prose that merely starts with an operation word, and an unregistered name, are ordinary replies", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND\nREAD (belfry.md) returned nothing because the file is empty.\n````\n\n````SEND\nDone\n````\n\n````SEND\nsh is the default shell here.\n````", 10),
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
            assert.deepEqual(sends.map(({ status_rx }) => status_rx), [200, 200, 200], "a first line that does not parse alone as a known operation's heading is a reply");
        } finally { ws.close(); }
    });
});

test("{§send-response-receipt}: a delivered reply names the open messages it answered", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("```SEND\nthe answer\n```", 10),
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
            const receipt = JSON.parse(send!.rx) as { answers: string[]; recipients?: unknown };
            assert.ok(Array.isArray(receipt.answers), "a reply names answered message addresses in answers");
            assert.equal(Object.hasOwn(receipt, "recipients"), false, "answered messages are not mislabeled as recipient actors");
            const { answers } = receipt;
            assert.ok(modelWorkerId !== undefined);
            const arrivals = rows.filter((r) => r.origin === "_plurnk" && r.op === "SEND");
            assert.equal(arrivals.length, 1, "one message in the loop");
            assert.equal(answers.length, 1, "the receipt names the one open message");
            const source = await db.message_source_by_address.get<{ body: string }>({ workspace_id: (await db.drain_get_worker_workspace.get<{ workspace_id: number }>({ worker_id: modelWorkerId }))!.workspace_id, path: answers[0]! });
            assert.equal(source?.body, "answer me", "the receipt names the durable message source");
        } finally { ws.close(); }
    });
});

import { serverProposals } from "./_approval.ts";
// {§send-response-receipt} — a delivered reply names the open messages it answered.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, flush } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { lastReply, logEntries } from "./_packet.ts";

// Every operation is on the line after its fence.
const MISFENCED = [
    "````\nsh <!-- brand presence -->\nprintf plurnk\n````",
    "````\nREAD (worker:///notes.md) <!-- retry the notes -->\n````",
    "````\nWAIT\nResearch positioning.\n````",
].join("\n\n");

test("{§balanced-fences}: a complete nested reply reaches the client without executing its examples", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const body = [
        "The syntax and command are examples:",
        "```text", "````OP (path)? <scope>?", "body", "````", "```",
        "````sh", "printf must-not-execute", "````",
        "The rest of the answer survives intact. 🙂",
    ].join("\n");
    const source = `\`\`\`\`SEND\n${body}\n\`\`\`\`\n\n\`\`\`\`SEND [200]\n\`\`\`\``;
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse(source, 10),
        makeMockResponse("````SEND [200]\nUnexpected continuation.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-nested-fences" });
            const { finalStatus, loopId, result, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "Explain with examples." });
            assert.equal(finalStatus, 200);
            assert.equal(result.content, undefined);
            assert.equal(await lastReply(db, loopId), body, "the client receives the entire answer, not its prefix");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["SEND", 200], ["SEND", 200]], "quoted commands produce no dispatch, proposals or execution receipts");
            const turns = await db.test_list_turns_in_loop.all<{ producer: string }>({ loop_id: loopId });
            assert.equal(turns.filter(({ producer }) => producer === "model").length, 1, "no recovery turn or unnecessary continuation");
            const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: modelWorkerId! });
            assert.ok(sources.some((row) => row.kind === "ops" && row.content === source), "the original emission remains forensic evidence");
        } finally { ws.close(); }
    });
});

test("{§forgotten-tag}: operations on the line after a bare fence run; a bare executor name stays quoted text", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse(MISFENCED, 10),
        makeMockResponse("````SEND [200]\nthe answer\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-misfenced" });
            const { finalStatus, loopId, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "research plurnk" });
            assert.equal(finalStatus, 200, "the second turn concludes");
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; tx: string }>({ loop_id: loopId });
            const model = rows.filter((r) => r.origin === "model").map(({ op, tx }) => ({ op, tx }));
            assert.ok(model.some(({ op }) => op === "READ"), "the READ under a bare fence ran");
            assert.ok(model.some(({ op }) => op === "WAIT"), "the WAIT under a bare fence ran");
            assert.equal(model.some(({ op }) => op === "NOTE"), false, "quoted text is no row");
            const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: modelWorkerId! });
            assert.ok(sources.some((row) => row.kind === "outside" && /printf plurnk/.test(row.content)), "a bare executor name is a word: its block stays quoted text, stored outside the turn ({§outside-text})");
            assert.match(JSON.stringify(mock.received[1]), /ran, though its fence was malformed: the opening fence, OP, parameters, and aside share one line/, "the next packet states the form once");
            assert.equal(await lastReply(db, loopId), "the answer");
            const shells = await db.test_get_entry_by_pathname_scheme.get({ scheme: "sh", pathname: "/1/1/1/sh" });
            assert.equal(shells, undefined, "no shell spawned");
        } finally { ws.close(); }
    });
});

test("{§send-body}: messages that start with operation names remain literal replies", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND\nREAD (belfry.md) returned nothing because the file is empty.\n````\n\n````SEND\nDone\n````\n\n````SEND\nsh is the default shell here.\n````", 10),
        makeMockResponse("````SEND [200]\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-prose" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "explain" });
            assert.equal(finalStatus, 200);
            await flush();
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.origin === "model" && r.op === "SEND");
            assert.deepEqual(sends.map(({ status_rx }) => status_rx), [200, 200, 200, 200], "message content is never parsed as another operation");
            assert.equal(rows.filter(({ origin }) => origin === "model").length, 4);
        } finally { ws.close(); }
    });
});

test("{§send-response-receipt}: a delivered reply names the open messages it answered", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND [200]\nthe answer\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-receipt" });
            const { finalStatus, loopId, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "answer me" });
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

test("{§packet-extent-metadata} {§context-fit}: a sent reply renders whole in the next request; delivery and the retained body are unchanged", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const body = Array.from({ length: 40 }, (_, index) => `delivered line ${index + 1}`).join("\n");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse(`\`\`\`\`SEND\n${body}\n\`\`\`\`\n\n\`\`\`\`SEND [200]\n\`\`\`\``, 10),
        makeMockResponse("````SEND [200]\nNoted.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-preview" });
            const { finalStatus, loopId, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "Send the report." });
            assert.equal(finalStatus, 200);
            assert.equal(await lastReply(db, loopId), body, "the client receives every line");
            const next = await runLoopToTerminal(ws, 3, { prompt: "Thanks.", workerId: modelWorkerId });
            assert.equal(next.finalStatus, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnIds!.at(-1)! }))!.packet);
            const reply = logEntries(packet).find((row) => Array.isArray(row.answers) && String(row.logPath).endsWith("/SEND"));
            assert.ok(reply, "the next model request contains the ordinary sent-message receipt");
            assert.equal(reply.preview, undefined, JSON.stringify(reply));
            assert.equal(reply.lines, 40, "the receipt states its full extent");
            assert.match(String(reply.body), /1:delivered line 1\n/u);
            assert.match(String(reply.body), /40:delivered line 40\n$/u, "the whole reply, because it fits");
            const messages = await db.test_log_entries_by_loop.all<{ op: string; origin: string; tx: string }>({ loop_id: loopId });
            assert.ok(messages.some((row) => row.op === "SEND" && row.origin === "model" && row.tx.includes("delivered line 40")), "the complete submitted reply remains recorded");
        } finally { ws.close(); }
    });
});

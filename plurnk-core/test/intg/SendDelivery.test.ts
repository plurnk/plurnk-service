import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import MessageAbandonment from "../../src/server/MessageAbandonment.ts";
import SessionOverview from "../../src/server/SessionOverview.ts";
import { type Notice } from "@plurnk/plurnk-contracts";
import { Mock, type MockResponse, ModelProvider } from "@plurnk/plurnk-providers";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { lastReply, logEntries } from "./_packet.ts";
import { statement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { liveLoop } from "../_live-harness.ts";
import { connect, rpcCall, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { serverProposals } from "./_approval.ts";

describe("live-harness-response", () => {
for (const cancelled of [false, true]) {
    test(`{§message-completion} the live harness retains the last SEND across ${cancelled ? "cancellation" : "completion"}`, async () => {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse("await plurnk.find({\"path\":\"workspace:///\"});\n\nawait plurnk.send({\"text\":\"First answer.\"});"),
            makeMockResponse("await plurnk.find({\"path\":\"workspace:///\"});\n\nawait plurnk.send({\"text\":\"Second answer.\"});"),
            makeMockResponse(cancelled ? "await plurnk.kill({\"path\":\"session://root\"});" : "await plurnk.done({});"),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspace = await rpcCall(ws, 1, "workspace.create", { name: `live-response-${cancelled}` });
                const { sessionId } = await daemon.createSession({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
                const result = await liveLoop({ db, ws }, 2, { prompt: "Answer in two parts.", sessionId, maxTurns: 5 });
                assert.equal(result.finalStatus, cancelled ? 499 : 200);
                assert.equal(provider.received.length, 3);
                assert.equal(result.lastContent, "Second answer.",
                    "the specimen evaluates the daemon's response: the last delivered message, not the terminal packet");
            } finally { ws.close(); }
        });
    });
}

test("{§message-completion} the live harness neither invents text nor acknowledges a request for blank SEND", async () => {
    const provider = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse("await plurnk.send({});"),
    ] });
    await withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-response-silent" });
            const result = await liveLoop({ db, ws }, 2, { prompt: "What is the capital of France?", maxTurns: 2 });
            assert.equal(result.finalStatus, 429, "the unanswered request reaches the configured turn limit");
            assert.equal(result.lastContent, "", "blank SEND delivers no response text");
        } finally { ws.close(); }
    });
});
});

describe("loop-answer", () => {
test("{§message-completion}: a loop's address reads its SEND answer; running is 425, absent is 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-answer-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const first = await insertLoop(db, sessionId, 1, "What is two plus two?");
        const observer = await insertSession(db, workspaceId, null, "observer");
        const read = (address: string, reader = observer) => clientRead(engine, db, { workspaceId, sessionId: reader, statement: statement(`await plurnk.read({"path":"${address}"});`) });

        const running = await read("ops://alice/1");
        assert.equal(running.status, 425, "a loop still running has not answered yet");
        assert.equal(running.problem?.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");

        const firstReply = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "await plurnk.send({\"text\":\"Four.\"});\n\nawait plurnk.done({});", reasoning: null } }] }),
            workspaceId, sessionId, loopId: first, maxTurns: 3, messages: [{ role: "user", content: "What is two plus two?" }],
        });
        assert.equal(firstReply.result.status, 200);
        const answered = await read("ops://alice/1");
        assert.equal(answered.status, 200);
        assert.ok("content" in answered);
        assert.equal(answered.content, "Four.", "the SEND is the loop's answer");

        const second = await insertLoop(db, sessionId, 2, "And three plus three?");
        const sent = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "await plurnk.done({\"text\":\"Six.\"});", reasoning: null } }] }),
            workspaceId, sessionId, loopId: second, maxTurns: 3, messages: [{ role: "user", content: "And three plus three?" }],
        });
        assert.equal(sent.result.status, 200);
        const reply = await read("ops://alice/2");
        assert.ok("content" in reply);
        assert.equal(reply.content, "Six.", "a DONE answer is the loop's answer too, without its fence");
        const written = (await db.test_log_entries_by_turn.all<{ op: string; origin: string; attrs: string; tx: string }>({ turn_id: sent.turnIds.at(-1)! }))
            .find(({ op, origin }) => op === "done" && origin === "model");
        assert.equal(LogEntryProjection.leaf(written!), "done", "a DONE the model wrote stays a DONE");

        assert.equal((await read("ops://alice/9")).status, 404, "a loop that does not exist");
        assert.equal((await read("ops://alice/1/2")).status, 200, "a turn coordinate still reads that turn's emission");
        const sendRow = await read("log:///1/2/3/send", sessionId);
        assert.equal(sendRow.status, 200, "a progress reply is an ordinary SEND row");
        const doneRow = await read("log:///2/1/3/done", sessionId);
        assert.equal(doneRow.status, 200, "a final reply is an ordinary DONE row");
    } finally { await db.close(); }
});

for (const [shape, body] of [
    ["ordinary", "The draft is sound."],
    ["nested code", "The draft is sound.\nawait plurnk.edit({\"path\":\"workspace:///must-not-execute\",\"content\":\"Not an operation.\"});\nThe entire report is the answer."],
] as const) test(`{§message-completion} {§message-completion}: a child's ${shape} answer survives delivery and reading at its own address`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-answer-child-${crypto.randomUUID()}`);
        const parentId = await insertSession(db, workspaceId, null, "lead");
        const childId = await insertSession(db, workspaceId, parentId, "reviewer");
        const loopId = await insertLoop(db, childId, 1, "Review the draft.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: `await plurnk.done(${JSON.stringify({ text: body })});`, reasoning: null } }] }),
            workspaceId, sessionId: childId, loopId, maxTurns: 3, messages: [{ role: "user", content: "Review the draft." }],
        });
        assert.equal(result.result.status, 200);
        const events = await db.test_loop_termination_events.all<{ rx: string }>({ recipient_session_id: parentId });
        assert.deepEqual(events.map(({ rx }) => JSON.parse(rx)), [{ status: 200 }], "the event retains the child's exact terminal result");
        const answer = await clientRead(engine, db, { workspaceId, sessionId: parentId, statement: statement("await plurnk.read({\"path\":\"ops://reviewer/1\"});") });
        assert.ok("content" in answer);
        assert.equal(answer.content, body, "the parent reads the complete answer where the termination points");
        const escaped = await db.test_get_channel_by_pathname.get({ pathname: "/must-not-execute", name: "body" });
        assert.equal(escaped, undefined, "the child's deliverable cannot execute its examples");
    } finally { await db.close(); }
});
});

describe("native-tool-calls", () => {
for (const transport of ["text", "wire"] as const) {
    for (const withOperation of [false, true]) {
        test(`{§fence-pairing} {§provider-failure-normalization}: ${transport} calls withOperation=${withOperation} translate silently into Code Mode`, async () => {
            const db = await openMigrated();
            try {
                const workspaceId = await insertWorkspace(db, "native-calls");
                const sessionId = await insertSession(db, workspaceId, null, "alice");
                const loopId = await insertLoop(db, sessionId, 1, "Update the fact.");
                await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Original fact." });
                const markup = '<tool_call><function=EDIT><parameter=path>workspace:///fact.txt</parameter><parameter=old_string>Original fact.</parameter><parameter=new_string>Translated change.</parameter></function></tool_call>';
                const tool = { index: 0, id: "call-1", type: "function", function: { name: "edit", arguments: '{"path":"workspace:///fact.txt","old_string":"Original fact.","new_string":"Translated change."}' } };
                const operation = withOperation ? "await plurnk.note({\"text\":\"Preparing edit.\"});" : "";
                const content = transport === "text" ? (withOperation ? `${operation}\n\n${markup}` : markup) : operation;
                const notices: Notice[] = [];
                let requests = 0;
                const provider = new ModelProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
                    fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
                    temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "off", budget: null },
                    fetch: async () => {
                        requests += 1;
                        const first = requests === 1;
                        const delta = first ? { content, ...(transport === "wire" ? { tool_calls: [tool] } : {}) }
                            : { content: "await plurnk.done({\"text\":\"Finished.\"});" };
                        return new Response(`data: ${JSON.stringify({
                            model: "fixture", choices: [{ index: 0, delta, finish_reason: first && transport === "wire" ? "tool_calls" : "stop" }],
                        })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
                    },
                });
                const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
                    noticeNotify: (_workspaceId, { notice }) => { notices.push(notice); },
                });
                const result = await engine.runLoop({ workspaceId, sessionId, loopId, provider, maxTurns: 3,
                    messages: [{ role: "user", content: "Update the fact." }],
                });
                assert.equal(result.result.status, 200);
                assert.equal(requests, 2);
                assert.equal(result.turnIds.length, 3, "one inference per ordinary turn, not provider retries");
                const first = result.turnIds[1];
                const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first });
                assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
                const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string; status_rx: number }>({ turn_id: first });
                assert.deepEqual(rows.filter(({ op }) => op === "edit").map(({ status_rx }) => status_rx), [200]);
                assert.deepEqual(rows.filter(({ op }) => op === "error"), []);
                const emissionRow = rows.find(({ op }) => op === "read");
                assert.match(JSON.parse(emissionRow?.rx ?? "{}").content ?? "", /plurnk\.edit\(\{"path":"workspace:\/\/\/fact\.txt","pattern":<<<EOF\nOriginal fact\.\nEOF,"text":"Translated change\."\}\)/u);
                const fact = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/fact.txt", scheme: "workspace", name: "body" });
                assert.equal(fact?.content, "Translated change.");
                assert.equal(notices.filter(({ message }) =>
                    message === "The response included native tool calls, but no tools were declared."
                    || message?.includes("tool-call markup and was not executed")).length, 0);
                const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
                assert.equal(sources.find((row) => row.turn_id === first && row.kind === "ops")?.content ?? "", content);
            } finally { await db.close(); }
        });
    }
}

for (const finish of ["stop", "tool_calls"]) {
    test(`{§loop-completion} {§provider-failure-normalization}: native calls with finish=${finish} cannot conclude resolved work`, async (t) => {
        const db = await openMigrated(); t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "native-call-settlement");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Report the fact.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "The fact." });
        const tool = { index: 0, id: "call-extra", type: "function", function: { name: "read", arguments: '{"path":"workspace:///fact.txt"}' } };
        let requests = 0;
        const provider = new ModelProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "off", budget: null },
            fetch: async () => {
                requests += 1;
                const delta = requests === 1 ? { content: `await plurnk.read({"path":"workspace:///fact.txt"});\nawait plurnk.done({"text":"The fact."});` }
                    : requests === 2 ? { tool_calls: [tool] } : { content: "" };
                return new Response(`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: requests === 2 ? finish : "stop" }] })}\n\ndata: [DONE]\n\n`,
                    { headers: { "content-type": "text/event-stream" } });
            },
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const statuses: number[] = [];
        for (let index = 0; index < 3; index += 1) {
            statuses.push((await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] })).status);
        }
        assert.deepEqual(statuses, [102, 102, 200]);
        assert.equal(requests, 3);
    });
}
});

describe("send-response", () => {
// Every operation is on the line after its fence.
const MISFENCED = [
    "sh:\n```\nprintf plurnk\n```",
    "```ts\nawait plurnk.read({\"path\":\"workspace:///notes.md\"}); // retry the notes\n```",
    "````\n```ts\nawait plurnk.wait({\"text\":\"Research positioning.\"});\n```\n````",
].join("\n\n");

test("{§operation-fences}: a complete nested reply reaches the client without executing its examples", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const body = [
        "The syntax and command are examples:",
        "```ts", 'await plurnk.read({ path: "path", range: "1,50" });', "```",
        "```ts", 'await plurnk.sh({ command: "printf must-not-execute" });', "```",
        "The rest of the answer survives intact. 🙂",
    ].join("\n");
    const source = `await plurnk.send(${JSON.stringify({ text: body })});

await plurnk.done({});`;
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse(source, 10),
        makeMockResponse("await plurnk.done({\"text\":\"Unexpected continuation.\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-nested-fences" });
            const { finalStatus, loopId, result, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "Explain with examples." });
            assert.equal(finalStatus, 200);
            assert.equal(result.content, undefined);
            assert.equal(await lastReply(db, loopId), body, "the client receives the entire answer, not its prefix");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["send", 200], ["done", 200]], "quoted commands produce no dispatch, proposals or execution receipts");
            const turns = await db.test_list_turns_in_loop.all<{ producer: string }>({ loop_id: loopId });
            assert.equal(turns.filter(({ producer }) => producer === "model").length, 1, "no recovery turn or unnecessary continuation");
            const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: modelSessionId! });
            assert.ok(sources.some((row) => row.kind === "ops" && row.content === source), "the original emission remains forensic evidence");
        } finally { ws.close(); }
    });
});

test("{§fence-pairing} {§op-shapes}: recovered READ preserves nested prose; a bare executor name stays quoted text", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeRawMockResponse(MISFENCED, 10),
        makeMockResponse("await plurnk.done({\"text\":\"the answer\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-misfenced" });
            const { finalStatus, loopId, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "research plurnk" });
            assert.equal(finalStatus, 200, "the second turn concludes");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; tx: string }>({ loop_id: loopId });
            const model = rows.filter((r) => r.origin === "model").map(({ op, tx }) => ({ op, tx }));
            assert.ok(model.some(({ op }) => op === "read"), "the READ under a bare fence ran");
            assert.ok(model.every(({ op }) => op !== "wait"), "the complete nested annotation remains literal under the same rule as NOTE and log KILL");
            assert.ok(model.some(({ op, tx }) => op === "note" && JSON.parse(tx).body.includes("````\n```ts\nawait plurnk.wait({\"text\":\"Research positioning.\"});\n```\n````")),
                "the complete annotation survives rather than executing its quoted WAIT");
            assert.ok(model.some(({ op, tx }) => op === "note" && /printf plurnk/u.test(JSON.parse(tx).body)), "a bare executor name is a word: its block stays quoted text, and beside the operations that text is the turn's NOTE ({§outside-text})");
            const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: modelSessionId! });
            assert.equal(sources.some((row) => row.kind === "outside"), false, "a turn with fenced operations keeps no outside source");
            assert.equal(await lastReply(db, loopId), "the answer");
            const shells = await db.test_get_entry_by_pathname_scheme.get({ scheme: "sh", pathname: "/1/1/1/sh" });
            assert.equal(shells, undefined, "no shell spawned");
        } finally { ws.close(); }
    });
});

test("{§op-shapes}: messages that start with operation names remain literal replies", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("await plurnk.send({\"text\":\"READ (belfry.md) returned nothing because the file is empty.\"});\n\nawait plurnk.send({\"text\":\"Done\"});\n\nawait plurnk.send({\"text\":\"sh is the default shell here.\"});", 10),
        makeMockResponse("await plurnk.done({});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-prose" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "explain" });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.origin === "model" && (r.op === "send" || r.op === "done"));
            assert.deepEqual(sends.map(({ status_rx }) => status_rx), [200, 200, 200, 200], "message content is never parsed as another operation");
            assert.equal(rows.filter(({ origin }) => origin === "model").length, 4);
        } finally { ws.close(); }
    });
});

test("{§message-completion}: a delivered reply names the open messages it answered", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("await plurnk.done({\"text\":\"the answer\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-receipt" });
            const { finalStatus, loopId, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "answer me" });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const send = rows.find((r) => r.origin === "model" && r.op === "done");
            assert.equal(send?.status_rx, 200);
            const receipt = JSON.parse(send.rx) as { repliedTo: string[]; recipients?: unknown };
            assert.ok(Array.isArray(receipt.repliedTo), "a reply names answered message addresses in repliedTo");
            assert.equal(Object.hasOwn(receipt, "recipients"), false, "answered messages are not mislabeled as recipient actors");
            const { repliedTo } = receipt;
            assert.ok(modelSessionId !== undefined);
            const arrivals = rows.filter((r) => r.origin === "_plurnk" && r.op === "send");
            assert.equal(arrivals.length, 1, "one message in the loop");
            assert.equal(repliedTo.length, 1, "the receipt names the one open message");
            assert.match(repliedTo[0], /^message:\/\/[^/]+\/00$/, "the receipt names the short message:// key_path");
            const workspaceId = (await db.drain_get_session_workspace.get<{ workspace_id: number }>({ session_id: modelSessionId }))!.workspace_id;
            const source = await db.message_source_by_address.get<{ body: string }>({ workspace_id: workspaceId, path: repliedTo[0] });
            assert.equal(source?.body, "answer me", "the receipt names the durable message source");

            const nextLoopId = await insertLoop(db, modelSessionId, 2, "Next loop");
            const scoutEnqueue = await db.drain_enqueue_message.get<{ id: number; message_key: string }>({
                loop_id: nextLoopId,
                source: "acp://scoutproxy/sessions/1%23user/messages/m-scout",
                body: "Scout question",
                open_paths: "[]",
                evidence: "{}",
                address: "acp://scoutproxy/sessions/1%23user/messages/m-scout",
                opened_turn_id: null,
                opened_sequence: null,
            });
            assert.equal(scoutEnqueue?.message_key, "scoutproxy_00");

            const wikiEnqueue = await db.drain_enqueue_message.get<{ id: number; message_key: string }>({
                loop_id: nextLoopId,
                source: "acp://wikitopian/sessions/1%23user/messages/m-wiki",
                body: "Wiki question",
                open_paths: "[]",
                evidence: "{}",
                address: "acp://wikitopian/sessions/1%23user/messages/m-wiki",
                opened_turn_id: null,
                opened_sequence: null,
            });
            assert.equal(wikiEnqueue?.message_key, "wikitopian_00");

            const scoutEnqueue2 = await db.drain_enqueue_message.get<{ id: number; message_key: string }>({
                loop_id: nextLoopId,
                source: "acp://scoutproxy/sessions/1%23user/messages/m-scout-2",
                body: "Scout follow-up",
                open_paths: "[]",
                evidence: "{}",
                address: "acp://scoutproxy/sessions/1%23user/messages/m-scout-2",
                opened_turn_id: null,
                opened_sequence: null,
            });
            assert.equal(scoutEnqueue2?.message_key, "scoutproxy_01");
        } finally { ws.close(); }
    });
});

test("{§log-wire-format} {§tokenomics}: a sent reply renders whole in the next request; delivery and the retained body are unchanged", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const body = Array.from({ length: 40 }, (_, index) => `delivered line ${index + 1}`).join("\n");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeMockResponse(`await plurnk.send(${JSON.stringify({ text: body })});

await plurnk.done({});`, 10),
        makeMockResponse("await plurnk.done({\"text\":\"Noted.\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-preview" });
            const { finalStatus, loopId, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "Send the report." });
            assert.equal(finalStatus, 200);
            assert.equal(await lastReply(db, loopId), body, "the client receives every line");
            const next = await runLoopToTerminal(ws, 3, { prompt: "Thanks.", sessionId: modelSessionId });
            assert.equal(next.finalStatus, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnIds!.at(-1)! }))!.packet);
            const reply = logEntries(packet).find((row) => Array.isArray(row.repliedTo) && row.logPath.endsWith("/send"));
            assert.ok(reply, "the next model request contains the ordinary sent-message receipt");
            assert.equal(reply.preview, undefined, JSON.stringify(reply));
            assert.equal(reply.lines, 40, "the receipt states its full extent");
            assert.match(String(reply.body), /1:delivered line 1\n/u);
            assert.match(String(reply.body), /40:delivered line 40\n$/u, "the whole reply, because it fits");
            const messages = await db.test_log_entries_by_loop.all<{ op: string; origin: string; tx: string }>({ loop_id: loopId });
            assert.ok(messages.some((row) => row.op === "send" && row.origin === "model" && row.tx.includes("delivered line 40")), "the complete submitted reply remains recorded");
        } finally { ws.close(); }
    });
});
});

describe("send-target-recipient", () => {
test("{§operation-results} a SEND addressed to a turn source the model may not write is refused 400 with neutral recipient guidance", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("await plurnk.send({\"target\":\"reasoning://alice/1/1\",\"text\":\"the answer\"});", 10),
        makeMockResponse("await plurnk.done({\"text\":\"the answer\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "answer me" });
            assert.equal(finalStatus, 200, "the target-less reply concluded on the second turn");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const sends = rows.filter((r) => (r.op === "send" || r.op === "done") && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 400, "the directed SEND was refused 400, not 403");
            const problem = (JSON.parse(sends[0].rx) as { problem?: Record<string, unknown> }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/send-target-not-a-recipient");
            assert.equal(problem?.detail, "The addressed scheme is not a send recipient."); // {§operation-results}
            assert.equal(problem?.recovery, "Name a message address or a recipient that implements send."); // {§operation-results}
            assert.doesNotMatch(JSON.stringify(problem), /meant|intended|wanted|tried/u);
            assert.ok(!sends.some((r) => r.status_rx === 403), "the writer rule never speaks first");
            assert.deepEqual(sends.map(({ status_rx }) => status_rx), [400, 200]);
            const turns = await db.test_list_turns_in_loop.all<{ producer: string; status: number }>({ loop_id: loopId });
            assert.deepEqual(turns.filter(({ producer }) => producer === "model").map(({ status }) => status), [102, 200], "the next turn observes the failure and delivers the answer");
        } finally { ws.close(); }
    });
});

test("{§operation-results} a SEND addressed to a file path preserves the scheme's factual 501", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("await plurnk.send({\"target\":\".\",\"text\":\"waiting\"});", 10),
        makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target-file" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const first = rows.find((r) => r.op === "send" && r.origin === "model");
            assert.equal(first?.status_rx, 501);
            const problem = (JSON.parse(first.rx) as { problem?: Record<string, unknown> }).problem;
            assert.equal(problem?.detail, "Scheme 'file' does not implement send."); // {§operation-results}
            assert.equal(problem?.recovery, undefined);
        } finally { ws.close(); }
    });
});
});

describe("session-overview", () => {
const said = (...statements: string[]): MockResponse => ({ assistant: { content: statements.join("\n\n"), reasoning: null } });

test("{§message-completion} {§application-session-observation} a session's latest finished reply is its newest delivered completion", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `overview-${crypto.randomUUID()}`);
    const alice = await insertSession(db, workspaceId, null, "alice");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
        injectSession: async ({ sessionId, prompt }) => {
            const loops = await db.test_fork_loops.all({ session_id: sessionId });
            const loopId = await insertLoop(db, sessionId, loops.length + 1, prompt);
            return { action: "enqueued_new_loop", loopId, message: `message://fork/${loopId}` };
        } });
    const read = (scope: number | null = workspaceId, limit = 50) =>
        SessionOverview.read(db, { workspaceId: scope, limit, excerptChars: 12, pending: async () => [], projectLabel: () => null });
    const placeOf = async (sessionId: number) => (await read()).sessions.find(({ id }) => id === sessionId);
    const replyOf = async (sessionId: number) => (await placeOf(sessionId))?.reply ?? null;
    const run = async (sessionId: number, loopId: number, ...turns: MockResponse[]) => {
        const provider = new Mock({ contextWindow: 100_000, responses: turns });
        for (const _turn of turns) await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
    };
    const ask = async (sequence: number, source = `acp://operator/threads/alice/messages/q${sequence}`) => {
        const loopId = await insertLoop(db, alice, sequence);
        await engine.injectIntoLoop(loopId, `Question ${sequence}.`, [], source);
        return loopId;
    };

    assert.equal(await replyOf(alice), null, "a session that never answered has no finished reply");
    await run(alice, await ask(1), said("await plurnk.send({\"text\":\"Still working on it.\"});"));
    assert.equal(await replyOf(alice), null, "a progress reply finishes nothing");
    const first = await ask(2);
    await run(alice, first, said("await plurnk.done({\"text\":\"First answer, in full.\\nWith detail.\"});"));
    const answered = await replyOf(alice);
    assert.deepEqual([answered?.completion, answered?.excerpt, answered?.continued, answered?.coordinate.split("/")[0]], [200, "First answer", true, "2"],
        "a completion reply finishes, its excerpt cut to the setting");
    assert.ok(typeof answered?.at === "number" && answered.at > 0, "its stamp is Unix milliseconds");
    await run(alice, await ask(3), said("await plurnk.fail({\"text\":\"Stopped: the input is missing.\"});"));
    const cancelled = await replyOf(alice);
    assert.deepEqual([cancelled?.completion, cancelled?.excerpt], [499, "Stopped: the"], "a cancelling reply finishes too");
    assert.ok((cancelled?.id ?? 0) > (answered?.id ?? 0));
    await run(alice, await ask(4), said("await plurnk.done({});", "await plurnk.done({\"text\":\"Speech after the completion.\"});"));
    const empty = await replyOf(alice);
    assert.deepEqual([empty?.completion, empty?.excerpt, empty?.continued], [200, "", false],
        "an empty completion is the latest finished reply, and speech that completed nothing never replaces it");
    await run(alice, await ask(5), said("await plurnk.done({\"target\":\"acp://operator/threads/alice/messages/missing\",\"text\":\"Lost.\"});"));
    assert.equal((await replyOf(alice))?.id, empty?.id, "a failed delivery finishes nothing");
    // {§loop-completion}: a message another session sent, left open by a loop that ended.
    const abandoned = await ask(6, "session://boss");
    assert.equal(await MessageAbandonment.complete(engine, db, workspaceId, alice, abandoned, 499), 1, "the daemon answers the abandoned message");
    const after = await placeOf(alice);
    assert.equal(after?.reply?.id, empty?.id, "the daemon's own 499 is not the model's reply");
    assert.notEqual(after?.lifecycle, "completed", "the lifecycle is the newest loop's, whatever the latest reply");

    const scout = await insertSession(db, workspaceId, alice, "scout");
    await run(scout, await insertLoop(db, scout, 1, "Scout the field."), said("await plurnk.done({\"text\":\"Scouted.\"});"));
    assert.deepEqual([(await replyOf(scout))?.excerpt, (await replyOf(alice))?.id], ["Scouted.", empty?.id], "a child's reply is the child's");
    await run(alice, await ask(7), said("await plurnk.fork({\"target\":\"session://twin\",\"prompt\":\"Carry on from here.\"});"));
    const twin = (await read()).sessions.find(({ name }) => name === "twin");
    assert.deepEqual([twin?.kind, twin?.reply], ["fork", null], "a fork's copied history holds no reply of its own");
    await insertSession(db, workspaceId, null, `_bookkeeping-${crypto.randomUUID()}`, "_plurnk");
    const other = await insertWorkspace(db, `overview-other-${crypto.randomUUID()}`);
    const namesake = await insertSession(db, other, null, "alice");

    const scoped = await read();
    assert.deepEqual(new Set(scoped.sessions.map(({ name }) => name)), new Set(["alice", "scout", "twin"]), "places only, and only the workspace's");
    assert.deepEqual(scoped.workspaces.map(({ id }) => id), [workspaceId]);
    const daemon = await read(null);
    const ours = daemon.sessions.filter(({ id }) => [alice, scout, twin?.id, namesake].includes(id));
    assert.deepEqual(ours.map(({ id }) => id), [scout, alice, ...[twin?.id ?? 0, namesake].toSorted((a, b) => b - a)],
        "the daemon's places, most recently finished first, then the rest newest first");
    assert.deepEqual(daemon.sessions.filter(({ name }) => name === "alice").map(({ workspaceId: owner }) => owner).toSorted((a, b) => a - b), [workspaceId, other].toSorted((a, b) => a - b),
        "a same-named session in another workspace is a place of its own");
    assert.equal((await read(workspaceId, 1)).omitted, 2, "the bound counts what it leaves out");
    const twinId = twin?.id ?? 0;
    const gated = await SessionOverview.read(db, { workspaceId, limit: 1, excerptChars: 12, projectLabel: () => null,
        pending: async () => [{ sessionId: twinId }, { sessionId: twinId }] });
    assert.deepEqual([gated.sessions.map(({ id, gates }) => [id, gates]), gated.omitted], [[[scout, 0], [twinId, 2]], 1],
        "the first in order, and every place waiting on a gate, with its gates");
});
});

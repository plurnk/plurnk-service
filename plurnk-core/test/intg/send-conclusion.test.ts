import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import Results from "../../src/core/results.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import DispatchAsPlurnk from "../../src/server/dispatch-as-plurnk.ts";
import MessageAbandonment from "../../src/server/MessageAbandonment.ts";
import SessionOverview from "../../src/server/SessionOverview.ts";
import { type Notice, type ParsedPath, isExecutionOp } from "@plurnk/plurnk-contracts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse, AiSdkProvider } from "@plurnk/plurnk-providers";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { holdChild, insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, sendingOperation, seedEnvelope } from "./_db.ts";
import { packetSection, lastReply, logEntries } from "./_packet.ts";
import { statement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { completeStmt, noteStmt, sendStmt, urlPath, execStmt, killStmt, dispositionStmt, readStmt } from "./_dsl.ts";
import { liveLoop } from "../_live-harness.ts";
import { connect, rpcCall, withDaemon, runLoopToTerminal, subscribeNotifications, waitForDb, waitFor } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { serverProposals } from "./_approval.ts";
import { hostname } from "node:os";
import { viableWindow } from "./_provider.ts";
import { type Db } from "../../src/core/Db.ts";

describe("send-conclusion", () => {
const said = (content: string, reasoning: string | null = null): MockResponse => ({ assistant: { content, reasoning } });
const message = "message://alice/assignment";
const send = (content = "") => PlurnkParser.frame("SEND", content);
const conclude = (content = "") => PlurnkParser.frame("SEND [200]", content);
const correct = (content: string) => PlurnkParser.frame(`SEND (${message}) [200]`, content);

const setup = async (responses: MockResponse[]) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `send-conclusion-${crypto.randomUUID()}`);
    const parentId = await insertSession(db, workspaceId, null, "lead");
    // {§loop-completion} lead sends alice her messages from its own loop.
    const leadLoop = await insertLoop(db, parentId, 1, "Lead the work.");
    const sessionId = await insertSession(db, workspaceId, parentId, "alice");
    const loopId = await insertLoop(db, sessionId, 1);
    // Source identity never depends on the reader ({§turn-source-resources}); alice's turns and history are under test.
    const observer = await insertSession(db, workspaceId, null, "observer");
    const notices: Notice[] = [];
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
        noticeNotify: (_id, payload) => notices.push(payload.notice),
    });
    await engine.injectIntoLoop(loopId, "What is two plus two?", [], "session://lead", {}, message, await sendingOperation(db, leadLoop));
    const provider = new Mock({ contextWindow: 100_000, responses });
    const ids = { workspaceId, sessionId, loopId };
    return {
        db, engine, provider, ids, parentId, leadLoop, notices,
        turn: () => engine.runTurn({ provider, ...ids, messages: [] }),
        answer: () => clientRead(engine, db, { workspaceId, sessionId: observer, statement: statement("````READ (ops://alice/1)````") }),
    };
};

for (const final of ["Four, precisely.", "", " \n\t"]) {
    test(`{§message-completion}: a ${final ? "corrected" : "empty-body"} final reply retains the child's answer for its parent`, async () => {
        const { db, engine, turn, answer, ids, parentId, leadLoop } = await setup([said(send("Four.")), said(conclude(final))]);
        try {
            const sent = await turn();
            assert.equal(sent.status, 102, "a SEND answers but cannot conclude");
            assert.equal(sent.emptyTurn, false, "an explicit SEND is an authored operation");
            const firstRows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string; rx: string }>({ turn_id: sent.turnId });
            const firstSend = firstRows.find(({ op, origin }) => op === "SEND" && origin === "model");
            assert.ok(firstSend, "the answer is delivered through the authored SEND");
            assert.equal(JSON.parse(firstSend.tx).body.raw, "Four.");
            const answers: string[] = JSON.parse(firstSend.rx).answers;
            assert.equal(answers.length, 1, "the SEND answers the original message");

            const concluded = await turn();
            assert.equal(concluded.status, 200);
            const result = await answer();
            assert.equal(result.status, 200);
            assert.ok("content" in result);
            assert.equal(result.content, final.trim() ? final : "Four.");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: concluded.turnId });
            assert.deepEqual(JSON.parse(rows.find(({ op }) => op === "SEND")!.rx).answers, answers, "completion addresses the original message even without speech");
            const history = await db.message_history.all<{ direction: string; body: string }>({
                workspace_id: ids.workspaceId, session_id: ids.sessionId, loop_id: ids.loopId,
            });
            assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["Four.", ...(final.trim() ? [final] : [])], "an empty completion is evidence, not another spoken message");

            const loopId = leadLoop;
            await engine.runTurn({ workspaceId: ids.workspaceId, sessionId: parentId, loopId, messages: [],
                provider: new Mock({ contextWindow: 100_000, responses: [said(PlurnkParser.frame("NOTE", "Observed."))] }),
            });
            const parentRows = await db.engine_render_log.all<{ source: string; op: string; rx: string }>({ session_id: parentId });
            const childRows = parentRows.filter(({ source }) => source === "session://alice");
            assert.deepEqual(childRows.map(({ op }) => op), ["READ"], "the parent receives one conclusion, not a duplicate child message or activity");
            assert.equal(JSON.parse(childRows[0].rx).content, final.trim() ? final : "Four.", "the parent's actual conclusion READ contains the child's final answer");
        } finally { await db.close(); }
    });
}

test("{§slot-order} {§message-completion}: leading completion metadata resolves only its addressed Open Message", async () => {
    const followup = "message://alice/followup";
    const { db, engine, turn, answer, ids, leadLoop } = await setup([
        said(PlurnkParser.frame(`SEND [200] (${followup})`, "Follow-up deliverable.")),
        said(PlurnkParser.frame(`SEND [200] (${message})`, "Four.")),
    ]);
    try {
        await engine.injectIntoLoop(ids.loopId, "Also answer this follow-up.", [], "session://lead", {}, followup, await sendingOperation(db, leadLoop));
        const first = await turn();
        assert.equal(first.status, 102, "the original message remains unresolved");
        const second = await turn();
        assert.equal(second.status, 200, "both explicitly addressed messages are now complete");
        for (const [turnId, addressed] of [[first.turnId, followup], [second.turnId, message]] as const) {
            const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; rx: string }>({ turn_id: turnId });
            const replies = rows.filter(({ op, origin }) => op === "SEND" && origin === "model").map(({ rx }) => JSON.parse(rx));
            assert.equal(replies.length, 1);
            assert.equal(replies[0].status, 200);
            assert.deepEqual(replies[0].answers, [addressed]);
        }
        const outcome = await answer();
        assert.ok("content" in outcome);
        assert.equal(outcome.content, "Four.", "the loop's deliverable answers its original assignment");
    } finally { await db.close(); }
});

test("{§message-completion} {§message-completion}: an empty completion succeeds without a fabricated answer", async () => {
    const { db, engine, turn, answer, ids, parentId, leadLoop } = await setup([said(conclude())]);
    try {
        assert.equal((await turn()).status, 200);
        const outcome = await answer();
        assert.equal(outcome.status, 200, "the loop resource retains the successful empty outcome");
        assert.ok("content" in outcome);
        assert.equal(outcome.content, "", "READ represents successful silence as an empty body");
        const events = await db.test_loop_termination_events.all<{ rx: string }>({ recipient_session_id: parentId });
        assert.deepEqual(events.map(({ rx }) => JSON.parse(rx)), [{ status: 200 }]);
        const loopId = leadLoop;
        await engine.runTurn({ workspaceId: ids.workspaceId, sessionId: parentId, loopId, messages: [],
            provider: new Mock({ contextWindow: 100_000, responses: [said(PlurnkParser.frame("NOTE", "Observed."))] }),
        });
        const rows = await db.engine_render_log.all<{ source: string; op: string; rx: string }>({ session_id: parentId });
        const conclusions = rows.filter(({ source }) => source === "session://alice");
        assert.equal(conclusions.length, 1, "the parent receives one ordinary completion observation");
        assert.equal(conclusions[0].op, "READ");
        const result = JSON.parse(conclusions[0].rx);
        assert.equal(result.status, 200, "silence does not become a child failure");
        assert.ok(result.content === undefined || result.content === "", "no answer text is invented");
        assert.equal(result.problem, undefined);
    } finally { await db.close(); }
});

test("{§message-completion}: FIFO targeting cannot acknowledge an unpublished arrival", async (t) => {
    const { db, engine, provider, turn, answer, ids, leadLoop } = await setup([
        said("Provisional answer."), said(conclude("Four, precisely.")), said(conclude("The follow-up is answered too.")),
    ]);
    const generate = provider.generate.bind(provider);
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (provider.received.length === 1) await engine.injectIntoLoop(ids.loopId, "Also answer this follow-up.", [], "session://lead", {}, undefined, await sendingOperation(db, leadLoop));
        return generate(...args);
    });
    try {
        assert.equal((await turn()).status, 102);
        const correction = await turn();
        assert.equal(correction.status, 102, "an unseen follow-up prevents settlement");
        const correctedAnswer = await answer();
        assert.ok("content" in correctedAnswer);
        assert.equal(correctedAnswer.content, "Four, precisely.", "the published queue head receives the answer");
        assert.equal((await turn()).status, 200);
        assert.match(JSON.stringify(provider.received[2]), /Also answer this follow-up\./);
        const finalAnswer = await answer();
        assert.ok("content" in finalAnswer);
        assert.equal(finalAnswer.content, "Four, precisely.", "answering a follow-up does not replace the original task's corrected result");
    } finally { await db.close(); }
});

for (const [label, response, reasoning, expected] of [
    ["only SEND", send("Four."), null, 102],
    ["SEND with a reasoning NOTE", send("Four."), PlurnkParser.frame("NOTE", "Arithmetic checked."), 102],
    ["only final reply", conclude("Four."), null, 200],
    ["final reply with a reasoning NOTE", conclude("Four."), PlurnkParser.frame("NOTE", "Arithmetic checked."), 200],
    ["final reply with a response NOTE", `${conclude("Four.")}\n\n${PlurnkParser.frame("NOTE", "Arithmetic checked.")}`, null, 200],
    ["SEND before final reply", `${send("Four.")}\n\n${conclude()}`, null, 200],
    ["addressed SEND after final reply", `${conclude()}\n\n${PlurnkParser.frame(`SEND (${message})`, "Four.")}`, null, 200],
    ["text before final reply", `Preface.\n\n${conclude("Four.")}`, null, 200],
    ["text after final reply", `${conclude("Four.")}\n\nPostscript.`, null, 200],
    ["SEND with a response NOTE", `${send("Four.")}\n\n${PlurnkParser.frame("NOTE", "Arithmetic checked.")}`, null, 102],
    ["two SENDs", `${send("Four.")}\n\n${send("Precisely four.")}`, null, 102],
    ["text before SEND", `Preface.\n\n${send("Four.")}`, null, 102],
    ["text after SEND", `${send("Four.")}\n\nPostscript.`, null, 102],
    ["NOTE only", PlurnkParser.frame("NOTE", "Still thinking."), null, 102],
] as const) {
    test(`{§message-completion}: ${label}`, async () => {
        const { db, turn } = await setup([said(response, reasoning)]);
        try { assert.equal((await turn()).status, expected); }
        finally { await db.close(); }
    });
}

test("{§message-completion}: sequential final replies both deliver and the later correction remains the loop answer", async () => {
    const response = `${conclude("Four.")}\n\n${correct("Precisely four.")}`;
    const { db, turn, answer } = await setup([said(response)]);
    try {
        const result = await turn();
        assert.equal(result.status, 200);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["SEND", "SEND"]);
        const delivered = await answer();
        assert.ok("content" in delivered);
        assert.equal(delivered.content, "Precisely four.");
    } finally { await db.close(); }
});

test("{§message-completion}: a NOTE after progress delivery leaves messages unresolved", async () => {
    const { db, turn } = await setup([said(send("Four.")), said(PlurnkParser.frame("NOTE", "Arithmetic checked.")), said(conclude())]);
    try {
        assert.equal((await turn()).status, 102);
        assert.equal((await turn()).status, 102);
        assert.equal((await turn()).status, 200);
    } finally { await db.close(); }
});

{
    for (const obligation of ["child", "stream"] as const) {
        for (const park of ["WAIT", "SEND [200]"] as const) {
            test(`{§loop-completion}: an earlier reply does not park ordinary work before ${park} with a live ${obligation}`, async () => {
                const first = `${send("Working on it.")}\n\n${PlurnkParser.frame("NOTE", "Continue the work.")}`;
                const { db, turn, ids } = await setup([
                    said(first),
                    said(PlurnkParser.frame("NOTE", "Check the saved input.")),
                    said(PlurnkParser.frame("READ (workspace:///input.txt)", null)),
                    said(PlurnkParser.frame(park, null)),
                ]);
                try {
                    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "workspace", pathname: "/input.txt",
                        channel: "body", content: "input-witness", mimetype: "text/plain", state: "static" });
                    assert.equal((await turn()).status, 102);
                    assert.equal((await db.message_unanswered_count.get({ loop_id: ids.loopId }))?.count, 1);
                    if (obligation === "child") await holdChild(db, ids.workspaceId, ids.sessionId);
                    else {
                        const entryId = await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "js", pathname: "/12345678",
                            channel: "stdout", content: "Ready for input.", mimetype: "text/plain", state: "active" });
                        await ChannelWrite.openSubscription(db, { sessionId: ids.sessionId, entryId, scheme: "js", handle: "/12345678", publishedChannel: "stdout" });
                    }
                    const memory = await turn();
                    assert.equal(memory.status, 102, "an earlier delivery is not an instruction to park a later NOTE");
                    const read = await turn();
                    assert.equal(read.status, 102, "ordinary work continues to observe its result without a poll or external wake");
                    const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: read.turnId });
                    assert.ok(rows.some(({ op, status_rx, rx }) => op === "READ" && status_rx === 200 && JSON.parse(rx).content === "input-witness"));
                    assert.equal(await new LoopLifecycle(db).status(ids.loopId), 102);
                    assert.equal((await turn()).status, 202, `${park} still joins the live obligation`);
                    assert.equal(await new LoopLifecycle(db).status(ids.loopId), 202);
                } finally { await db.close(); }
            });
        }
    }
}

for (const response of ["200", "````markdown\nFour.\n````", "````md\nFour.\n````"]) {
    test(`{§message-completion}: ${JSON.stringify(response)} cannot confirm a previous free response`, async () => {
        const { db, turn, answer, ids } = await setup([said(send("Four.")), said(response), said(conclude("Four, precisely."))]);
        try {
            assert.equal((await turn()).status, 102);
            const token = await turn();
            assert.equal(token.status, 102, "neither a numeric token nor a Markdown envelope requests completion");
            assert.equal(token.emptyTurn, true);
            const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string }>({ turn_id: token.turnId });
            assert.equal(rows.some(({ op, origin }) => op === "SEND" && origin === "model"), false, "outside text is never delivered");
            assert.equal(rows.some(({ op, origin }) => op === "NOTE" && origin === "model"), false, "outside text is not a NOTE ({§outside-text})");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: ids.sessionId });
            assert.equal(sources.find((row) => row.turn_id === token.turnId && row.kind === "outside")?.content, response, "the text is the turn's outside source, not confirmation of completion");
            assert.equal((await turn()).status, 200);
            const result = await answer();
            assert.ok("content" in result);
            assert.equal(result.content, "Four, precisely.");
        } finally { await db.close(); }
    });
}

test("{§outside-text}: each span beside the operations is one NOTE at its position, and siblings run without a strike", async () => {
    const source = `Before.\n\n${PlurnkParser.frame("NOTE", "remember")}\n\nBetween.\n\n${send("Four.")}\n\nAfter.`;
    const { db, engine, provider, ids, notices } = await setup([said(source), said(conclude())]);
    try {
        const result = await engine.runLoop({ ...ids, provider, maxTurns: 4, maxStrikes: 1, messages: [] });
        assert.equal(result.result.status, 200, "annotation does not strike even at a one-strike threshold");
        assert.equal(provider.received.length, 2);
        const turnId = result.turnIds.at(-2)!;
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string; rx: string }>({ turn_id: turnId });
        const operations = rows.filter(({ origin, op }) => origin === "model" && ["SEND", "NOTE"].includes(op));
        assert.deepEqual(operations.map(({ op, tx }) => [op, op === "SEND" ? JSON.parse(tx).body.raw : JSON.parse(tx).body]),
            [["NOTE", "Before."], ["NOTE", "remember"], ["NOTE", "Between."], ["SEND", "Four."], ["NOTE", "After."]], "each span is the turn's NOTE at its position, in source order");
        assert.equal(rows.some(({ op }) => op === "error"), false, "annotation is not a failed operation");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: ids.sessionId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "outside"), undefined, "beside fenced operations there is no outside source");
        assert.deepEqual(notices.filter(({ level }) => level === "warn" || level === "error").map((notice) => [notice.kind, notice.message]), [], "annotation draws no notice");
    } finally { await db.close(); }
});

test("{§outside-text}: a mixed turn's text becomes its NOTEs, replayed in the model's voice, with no notice and no outside source", async () => {
    const prose = ["Let me check the input first.", "That settles it."];
    const source = `${prose[0]}\n\n${PlurnkParser.frame("READ (workspace:///input.txt)", null)}\n\n${prose[1]}`;
    const { db, turn, ids, notices } = await setup([said(source), said(conclude())]);
    try {
        await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "workspace", pathname: "/input.txt",
            channel: "body", content: "input-witness", mimetype: "text/plain", state: "static" });
        const mixed = await turn();
        assert.equal(mixed.status, 102);
        assert.equal(mixed.emptyTurn, false, "the READ is an authored operation");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string }>({ turn_id: mixed.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, tx }) => op === "NOTE" ? JSON.parse(tx).body : op), [prose[0], "READ", prose[1]], "each span is a NOTE row at its position");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string; model_call_id: number | null }>({ session_id: ids.sessionId });
        assert.equal(sources.find((row) => row.turn_id === mixed.turnId && row.kind === "outside"), undefined, "no outside source beside fenced operations");
        assert.deepEqual(notices.filter(({ kind }) => kind === "outside_text"), [], "no notice: the card's register is where the text belongs");
        const next = await turn();
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        assert.doesNotMatch(packetSection(packet, "notices"), /outside_text/u);
        assert.match(packetSection(packet, "emission-history"), /Let me check the input first\.[\s\S]*That settles it\./u, "{§emission-history}: the NOTEs replay in the model's own voice");
        assert.doesNotMatch(packetSection(packet, "log"), /Let me check the input first\./u, "their paired receipts have no duplicate bodies, not a second copy of the text");
    } finally { await db.close(); }
});

// The recorded shape (#853, run286 pytest-5103): a length-cut response repeating `Proceeding.` beside a
// fence minted 2,858 NOTE rows in one turn, one per fragment.
test("{§outside-text}: a repetitive response beside operations is one NOTE per span between them, and a prose-only repetition is one outside source", async () => {
    const fragments = Array.from({ length: 400 }, () => `Proceeding.\n\n${PlurnkParser.frame("NOTE", "waiting")}`).join("\n\n");
    const proseOnly = Array.from({ length: 400 }, () => "Proceeding.").join("\n\n");
    const { db, engine, provider, ids } = await setup([said(`${fragments}\n\n${send("Four.")}\n\nProceeding`), said(proseOnly), said(conclude())]);
    try {
        const result = await engine.runLoop({ ...ids, provider, maxTurns: 5, maxStrikes: 2, messages: [] });
        const [, mixedTurn, proseTurn] = result.turnIds;
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string }>({ turn_id: mixedTurn });
        assert.equal(rows.filter(({ origin, op, tx }) => origin === "model" && op === "NOTE" && JSON.parse(tx).body !== "waiting").length, 401, "each span between operations is its own NOTE, however repetitive");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: ids.sessionId });
        assert.deepEqual(sources.filter((row) => row.turn_id === mixedTurn && row.kind === "outside"), [], "beside operations, no outside source");
        assert.deepEqual(sources.filter((row) => row.turn_id === proseTurn && row.kind === "outside").map(({ content }) => content), [proseOnly],
            "a response with no fenced operation keeps every fragment as one outside source and mints no NOTE");
        const proseRows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: proseTurn });
        assert.equal(proseRows.some(({ origin, op }) => origin === "model" && op === "NOTE"), false);
        assert.deepEqual(proseRows.filter(({ origin, op }) => origin === "_plurnk" && op === "error").map(({ status_rx }) => status_rx), [422], "{§outside-text}: the prose-only turn strikes once");
    } finally { await db.close(); }
});

test("{§outside-text}: operations beside stray text reset the no-operation strike streak", async () => {
    const { db, engine, provider, ids } = await setup([
        said("Thinking."),
        said(`Checking the arithmetic.\n\n${PlurnkParser.frame("NOTE", "Two plus two is four.")}`),
        said("Four."),
        said(conclude("Four.")),
    ]);
    try {
        const result = await engine.runLoop({ ...ids, provider, maxTurns: 5, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 200, "the two prose-only turns do not form a consecutive strike streak");
        assert.equal(provider.received.length, 4);
    } finally { await db.close(); }
});

for (const preview of ["0", "1"]) for (const [label, response, reasoning, notes, outside] of [
    ["prose", "Four.", null, [], "Four."],
    ["prose with reasoning", "Four.", "I should verify the arithmetic.", [], "Four."],
    ["empty response", "", null, [], undefined],
] as const) {
    test(`{§outside-text} {§turn-source-resources}: ${label} preserves sources and strikes; preview=${preview} is not authored work`, async (t) => {
        const previous = process.env.PLURNK_SERVICE_REASONING_ROWS;
        process.env.PLURNK_SERVICE_REASONING_ROWS = preview;
        t.after(() => { if (previous === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS; else process.env.PLURNK_SERVICE_REASONING_ROWS = previous; });
        const { db, engine, provider, ids, notices } = await setup([said(response, reasoning)]);
        try {
            const result = await engine.runLoop({ ...ids, provider, maxTurns: 3, maxStrikes: 1, messages: [] });
            assert.equal(result.result.status, 500);
            assert.ok("problem" in result.result && result.result.problem);
            assert.equal(result.result.problem.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
            assert.match(result.result.problem.detail, /performed no operation\.$/);
            assert.deepEqual(notices.filter(({ level, kind }) => level === "warn" && kind !== "outside_text"), [], "the strike is silent; only the discarded text is weighed ({§outside-text})");
            const turns = await Promise.all(result.turnIds.map(async (id) => (await db.test_get_turn.get<{ id: number; sequence: number; producer: string }>({ id }))!));
            const { id: modelTurn, sequence } = turns.findLast(({ producer }) => producer === "model")!;
            const reads = await db.test_reasoning_reads.all<{ origin: string; pathname: string; turn_id: number; rx: string }>({ session_id: ids.sessionId });
            assert.deepEqual(reads.filter(({ origin, pathname }) => origin === "_plurnk" && pathname === `/1/${sequence}`)
                .map(({ turn_id, rx }) => [turn_id, JSON.parse(rx).content]), preview === "0" || reasoning === null ? [] : [[modelTurn, reasoning]],
                "the optional preview belongs to this turn and does not prevent its no-operation strike");
            assert.equal(provider.received.length, 1, "the preview causes no extra inference");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; source: string; origin: string; tx: string; status_rx: number }>({ turn_id: modelTurn });
            assert.equal(rows.some(({ op, source }) => op === "error" && source === "grammar"), false);
            assert.deepEqual(rows.filter(({ op, origin }) => op === "error" && origin === "_plurnk").map(({ status_rx }) => status_rx), [422], "the strike is one error row on the turn");
            assert.deepEqual(rows.filter(({ op, origin }) => op === "NOTE" && origin === "model").map(({ tx }) => JSON.parse(tx).body), [...notes],
                "a reasoning NOTE beside an empty program is a row of its own; outside text is none");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: ids.sessionId });
            assert.equal(sources.find((row) => row.turn_id === modelTurn && row.kind === "outside")?.content, outside, "a prose-only turn still records its outside source ({§outside-text})");
            assert.equal(sources.find((row) => row.turn_id === modelTurn && row.kind === "reasoning")?.content, reasoning ?? undefined,
                "the reasoning source is retained independently of its preview");
        } finally { await db.close(); }
    });
}

for (const [failure, operation, failedOp] of [
    ["parser", "````EDIT (workspace:///broken.md) <bad>\nnot a message\n````", "error"],
    ["operation", PlurnkParser.frame("SEND (reasoning://alice/1/1)", "Not a recipient."), "SEND"],
] as const) {
    test(`{§outside-text}: stray text stored outside the turn does not mask an actual ${failure} failure`, async () => {
        const source = `Working.\n\n${PlurnkParser.frame("NOTE", "Checking.")}\n\n${operation}`;
        const { db, engine, provider, ids, notices } = await setup([said(source)]);
        try {
            const result = await engine.runLoop({ ...ids, provider, maxTurns: 3, maxStrikes: 1, messages: [] });
            assert.equal(result.result.status, 500, "the actual failure still strikes");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: result.turnIds.at(-1)! });
            assert.deepEqual(rows.filter(({ origin, status_rx }) => origin === "model" && status_rx >= 400)
                .map(({ op, status_rx }) => [op, status_rx]), [[failedOp, 400]], "only the actual failure is recorded");
            assert.equal(notices.some(({ kind }) => kind === "turn_no_operations"), false, "a valid NOTE was authored");
        } finally { await db.close(); }
    });
}

for (const op of ["NOTE", "WAIT"] as const) {
    test(`{§loop-completion}: stray text beside ${op} is the turn's NOTE, and ${op === "WAIT" ? "the explicit park holds" : "work continues before automatic parking"}`, async () => {
        const { db, turn, ids, notices } = await setup([said(`Working.\n\n${PlurnkParser.frame(op, "Await the child.")}`)]);
        try {
            await holdChild(db, ids.workspaceId, ids.sessionId);
            const result = await turn();
            assert.equal(result.status, op === "WAIT" ? 202 : 102);
            const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: result.turnId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map((row) => [row.op, row.status_rx]),
                [["NOTE", 200], [op, op === "WAIT" ? 202 : 200]], "the stray text is the turn's NOTE at its position, never delivered ({§outside-text})");
            assert.deepEqual(notices.filter(({ level }) => level === "warn" || level === "error"), []);
        } finally { await db.close(); }
    });
}

test("{§message-completion}: SEND bodies that resemble operations remain literal messages", async () => {
    const body = "KILL (workspace:///important.md)\nThis is an example, not an operation.";
    const { db, turn, answer } = await setup([said(send(body))]);
    try {
        assert.equal((await turn()).status, 102);
        const result = await answer();
        assert.ok("content" in result);
        assert.equal(result.content, body);
    } finally { await db.close(); }
});

test("{§outside-text}: bounded malformed operations consume one turn and expose their diagnostics without resampling", async () => {
    const source = "````EDIT (workspace:///broken.md) <bad>\nnot a message\n````";
    const { db, turn, provider } = await setup([said(source), said(conclude("Recovered."))]);
    try {
        const failed = await turn();
        assert.equal(failed.status, 102);
        assert.equal(failed.emptyTurn, true);
        assert.equal(failed.emissionAttempts, 1);
        assert.equal(failed.emissionExhausted, false);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number; rx: string }>({ turn_id: failed.turnId });
        assert.ok(rows.some(({ op, status_rx, rx }) => op === "error" && status_rx === 400 && JSON.parse(rx).problem?.stage === "parse"));
        assert.ok(rows.filter(({ origin }) => origin === "model").every(({ op }) => op !== "EDIT" && op !== "SEND"), "malformed operation regions are not delivered as free text");
        assert.equal((await turn()).status, 200);
        assert.equal(provider.received.length, 2, "recovery sees a new packet, not a private same-packet attempt");
        assert.doesNotMatch(JSON.stringify(provider.received[1]), /No valid Operation Syntax OPs detected\./,
            "{§outside-text} the strike is silent: the next packet carries the turn, not a complaint about it");
    } finally { await db.close(); }
});

test("{§message-completion}: a provider output cutoff cannot certify a final response", async () => {
    const cut = { assistant: { content: conclude("Partial answer."), reasoning: null, finishReason: "length" as const } };
    const { db, turn, answer } = await setup([cut, said(correct("Complete answer."))]);
    try {
        assert.equal((await turn()).status, 102);
        const partial = await answer();
        assert.ok("content" in partial);
        assert.equal(partial.content, "Partial answer.", "admitted speech is delivered, but cutoff prevents loop settlement");
        assert.equal((await turn()).status, 200);
    } finally { await db.close(); }
});

for (const preview of ["0", "1"]) test(`{§outside-text} {§op-shapes}: a reasoning NOTE is the turn's work; no content program is not empty (preview=${preview})`, async (t) => {
    const previous = process.env.PLURNK_SERVICE_REASONING_ROWS;
    process.env.PLURNK_SERVICE_REASONING_ROWS = preview;
    t.after(() => { if (previous === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS; else process.env.PLURNK_SERVICE_REASONING_ROWS = previous; });
    const { db, turn, provider } = await setup([said("", PlurnkParser.frame("NOTE", "Still calculating.")), said(conclude("Four."))]);
    try {
        const noted = await turn();
        assert.equal(noted.status, 102);
        assert.equal(noted.emptyTurn, false, "an admitted reasoning NOTE is an authored operation, exactly as a content NOTE");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: noted.turnId });
        assert.deepEqual(rows.map(({ origin, op }) => `${origin}:${op}`).filter((row) => row !== "_plurnk:SEND"),
            preview === "1" ? ["_plurnk:READ", "model:NOTE"] : ["model:NOTE"], "the authored NOTE and any optional reasoning preview, with no strike row");
        assert.equal((await turn()).status, 200);
        assert.doesNotMatch(JSON.stringify(provider.received[1]), /No valid Operation Syntax OPs detected\./,
            "the next packet carries the turn, not a complaint about it");
    } finally { await db.close(); }
});

test("{§outside-text}: a reasoning NOTE is work, not a request to wait, after the messages are answered", async () => {
    const { db, turn, ids } = await setup([said("Four."), said("", PlurnkParser.frame("NOTE", "Still checking."))]);
    try {
        assert.equal((await turn()).status, 102);
        await holdChild(db, ids.workspaceId, ids.sessionId);
        const empty = await turn();
        assert.equal(empty.emptyTurn, false, "the reasoning NOTE is an authored operation");
        assert.equal(empty.status, 102, "a NOTE is never a request to wait; only WAIT parks on the child");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: empty.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["NOTE"]);
    } finally { await db.close(); }
});

test("{§loop-completion}: WAIT on a turn with a reply SEND or non-final SEND [200] concludes when no work or unobserved result remains", async () => {
    for (const [label, extraMessage, emission, withRead, expected] of [
        ["SEND + WAIT concludes single message", false, `${send("Four.")}\n\n${PlurnkParser.frame("WAIT [60]", "Waiting for reply.")}`, false, 200],
        ["non-final SEND [200] + WAIT concludes remaining message", true, `${conclude("Four.")}\n\n${PlurnkParser.frame("WAIT", null)}`, false, 200],
        ["SEND + READ + WAIT continues to observe READ result", false, `${send("Checking.")}\n\n${PlurnkParser.frame("READ (workspace:///input.txt)", null)}\n\n${PlurnkParser.frame("WAIT", null)}`, true, 102],
    ] as const) {
        const { db, engine, turn, answer, ids, leadLoop } = await setup([said(emission)]);
        try {
            if (extraMessage) {
                await engine.injectIntoLoop(ids.loopId, "And confirm.", [], "session://lead", {}, "message://alice/followup", await sendingOperation(db, leadLoop));
            }
            if (withRead) {
                await seedEntryWithChannel(db, {
                    workspaceId: ids.workspaceId, scheme: "workspace", pathname: "/input.txt",
                    channel: "body", content: "witness", mimetype: "text/plain", state: "static",
                });
            }
            const settled = await turn();
            assert.equal(settled.status, expected, label);
            if (expected === 200) {
                const delivered = await answer();
                assert.ok("content" in delivered);
                assert.equal(delivered.content, "Four.", label);
            }
        } finally { await db.close(); }
    }
});
});

describe("Engine.lifecycle", () => {
const frame = PlurnkParser.frame;
const response = (content: string, reasoning: string | null = null) => ({
    assistant: { content, reasoning },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const [name, first, detail] of [
    ["note-only continuation", frame("NOTE", "Consider the next step."), null],
    ["empty wait", frame("WAIT", ""), "Nothing is in flight. Continuing."],
    ["empty note", frame("NOTE", ""), null],
    ["scoped wait", frame("WAIT [60]", ""), "Nothing is in flight. Continuing."],
    ["decorated wait", frame("WAIT (sh:///missing) <60,60> [{\"timeout\":42}]", ""), "Nothing is in flight. Continuing."],
] as const) {
    test(`{§op-shapes} {§loop-completion} ${name} continues without losing its operations`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "explicit-lifecycle");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Answer.");
        const provider = new Mock({ contextWindow: 100000, responses: [response(first), response(frame("SEND [200]", "Answer."))] });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 3, maxStrikes: 2,
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, loopId), "Answer.");
        assert.equal(provider.received.length, 2);
        assert.equal(await new StrikeRail(db).streak(loopId), 0);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string; status_rx: number }>({ loop_id: loopId });
        if (detail !== null) {
            assert.equal(rows.filter(({ rx }) => {
                const parsed = JSON.parse(rx);
                return (parsed.problem?.detail ?? parsed.detail) === detail;
            }).length, 1, "one durable correction, not duplicated grammar and runtime errors");
            assert.match(JSON.stringify(provider.received[1]), new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        assert.equal(rows.filter(({ op, origin }) => origin === "model" && op === "SEND").length, 1);
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), [/^`+(\w+)/u.exec(first)![1], "SEND"],
            "the model's rows are exactly its program and its conclusion");
    });
}

test("{§session-loop-lifecycle} a not-ready READ continues until an explicit WAIT joins the child", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "independent-join");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Advance while the child works.");
    const childId = await insertSession(db, workspaceId, sessionId, "child");
    await insertLoop(db, childId, 1, "Child work.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("READ (session://child)", "")), response(frame("WAIT", "Await the child.")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 3, maxStrikes: 1,
    });
    assert.equal(result.result.status, 202);
    assert.equal(provider.received.length, 2);
    assert.equal(await new StrikeRail(db).streak(loopId), 0);
    assert.equal(await new LoopLifecycle(db).status(loopId), 202);
});

for (const [cancel, status] of [[false, 200], [true, 499]] as const) {
    test(`{§message-completion} ${cancel ? "cancellation" : "completion"} keeps the last delivered message despite its curation`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "response-evidence");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Answer, then tidy up.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(`${frame("FIND (workspace:///*)", "")}\n${frame("SEND", "The answer.")}`),
            response(`${frame("KILL (log:///1/2/*/SEND)", "")}\n${cancel ? frame("KILL (session://alice)", "") : frame("NOTE", "Result observed.")}`),
            response(frame("SEND [200]", "")),
        ] });
        const lifecycle = new LoopLifecycle(db);
        const result = await new Engine({ db, schemes: new SchemeRegistry(), cancelSession: async (id, reason) => { await lifecycle.cancelTree(id, reason, true); } }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 3 });
        assert.equal(result.result.status, status);
        assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, loopId), "The answer.");
        assert.equal((await new LoopLifecycle(db).result(loopId))?.content, undefined);
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId });
        assert.ok(rows.some(({ op, status_rx }) => op === "KILL" && status_rx === 200));
        assert.equal(provider.received.length, cancel ? 2 : 3, "cancellation or completion of all obligations ends the loop");
        if (cancel) assert.match(result.result.problem?.detail ?? "", /killed via session/);
        else assert.equal(result.result.problem, undefined);
    });
}

test("{§message-completion} a terminal response supersedes earlier delivered SENDs", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "response-last-message");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "What is the codename?");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(`${frame("SEND", "The codename is Bumblebee.")}\n${frame("SEND", "The codename is phoenix.")}`),
        response(frame("SEND [200]", "")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "The codename is phoenix.");
    assert.equal((await new LoopLifecycle(db).result(loopId))?.content, undefined);
    const messages = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
    assert.deepEqual(messages.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The codename is Bumblebee.", "The codename is phoenix."]);
});

test("{§loop-completion} an observed cleanup failure does not invalidate completed work", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "cleanup-outcome");
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1, "Deliver the project brief.");
    const brief = "Codename: phoenix. Host: db.internal. TODO: add error handling.";
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(`${frame("SEND", brief)}\n${frame("KILL (reasoning://alice/1/2) <1,-1>", "")}`, "The requested project brief is ready."),
        response(frame("SEND [200]", "")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4 });
    const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
    const denied = rows.find(({ op }) => op === "KILL");
    assert.equal(denied?.status_rx, 403);
    assert.equal(JSON.parse(denied.rx).problem.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
    assert.ok(JSON.stringify(provider.received[1]).includes("writer-forbidden"), "the failed cleanup reaches a later packet");
    assert.equal(provider.received.length, 2);
    assert.equal(result.result.status, 200);
    assert.equal(result.result.problem, undefined);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), brief);
});

test("{§message-completion} cancellation preserves delivered messages but not WAIT text", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "response-cancellation");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Wait after the update.");
    const childId = await insertSession(db, workspaceId, sessionId, "child");
    await insertLoop(db, childId, 1, "Live child work the wait joins.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(`${frame("SEND", "Update delivered.")}\n${frame("WAIT", "Await the child.")}`)] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 2 });
    assert.equal(result.result.status, 202);
    const lifecycle = new LoopLifecycle(db);
    const cancelled = await lifecycle.cancelTree(sessionId, "operator request", true);
    const own = cancelled.loops.find(({ loopId: id }) => id === loopId);
    assert.ok(own);
    assert.equal(own.result.status, 499);
    assert.equal(own.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Update delivered.");
    assert.equal((await lifecycle.result(loopId))?.content, undefined);
    assert.equal(own.result.problem?.type, "https://problems.plurnk.xyz/lifecycle/cancel/scope-cancelled");
});

for (const [cancel, parentStatus, childStatus] of [[false, 202, 102], [true, 499, 499]] as const) {
    test(`{§loop-completion} ${cancel ? "scope cancellation cancels" : "answered work joins"} a live child`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "live-child");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Wait for the delegated result.");
        const childId = await insertSession(db, workspaceId, sessionId, "child");
        const childLoopId = await insertLoop(db, childId, 1, "Finish delegated work.");
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelSession: async (id, reason) => { await lifecycle.cancelTree(id, reason, true); } });
        const provider = new Mock({ contextWindow: 100000, responses: [response(frame(cancel ? "KILL (session://alice)" : "SEND [200]", cancel ? "" : "Waiting for the delegated result."))] });
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
        assert.equal(result.status, parentStatus);
        assert.equal(await lifecycle.status(loopId), parentStatus);
        assert.equal(await lifecycle.status(childLoopId), childStatus);
    });
}

test("{§message-completion} an empty SEND leaves an open message unanswered", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "silent-completion");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Do the work.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(frame("SEND", ""))] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
    assert.equal(result.status, 102);
    assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 1);
    const history = await db.message_history.all<{ direction: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
    assert.deepEqual(history.map(({ direction }) => direction), ["inbound"]);
});

test("{§op-shapes} writing about failure in NOTE does not declare failure", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "notes-not-control");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Try both approaches.");
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("NOTE", "First approach failed.\nTry the second approach.")),
        response(frame("SEND [200]", "Second approach succeeded.")),
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 2);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Second approach succeeded.");
});
});

describe("Engine.message-replies", () => {
const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { prompt: "Deliver the result." });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, env, engine, lifecycle: new LoopLifecycle(db) };
};

for (const stmt of [sendStmt(parsePath("message://request/reply"), "An answer."), noteStmt("A determination.")]) {
    test(`{§op-shapes} dispatching ${stmt.op} alone does not settle the enclosing program`, async () => {
        const { db, env, engine, lifecycle } = await setup();
        try {
            await engine.injectIntoLoop(env.loopId, "Reply.", [], undefined, {}, "message://request/reply");
            const result = await engine.dispatch({ ...env, statement: stmt, sequence: 1, origin: "model" });
            assert.equal(result.status, 200);
            assert.equal(await lifecycle.status(env.loopId), 102);
            const log = await db.test_first_log_entry_for_turn.get<{ status_rx: number }>({ turn_id: env.turnId });
            assert.equal(log?.status_rx, 200);
        } finally { await db.close(); }
    });
}

test("{§message-completion} a failed endpoint SEND neither answers a message nor concludes", async () => {
    const { db, env, engine, lifecycle } = await setup();
    try {
        const before = await db.message_unanswered_count.get<{ count: number }>({ loop_id: env.loopId });
        const result = await engine.dispatch({ ...env, statement: sendStmt(urlPath("wss", "feed/x"), "message"), sequence: 1, origin: "model" });
        assert.equal(result.status, 501);
        assert.equal(await lifecycle.status(env.loopId), 102);
        assert.deepEqual(await db.message_unanswered_count.get({ loop_id: env.loopId }), before);
    } finally { await db.close(); }
});

test("{§message-completion} every progress SEND executes before a later completion reply", async () => {
    const { db, env, engine, lifecycle } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: {
            content: "", reasoning: null, ops: [sendStmt(null, "First."), sendStmt(null, "Second."), noteStmt("Both delivered.")],
        } }, { assistant: { content: "", reasoning: null, ops: [completeStmt("")] } }] });
        const turn = await engine.runTurn({ ...env, provider, messages: [] });
        assert.equal(turn.status, 102);
        assert.deepEqual(turn.outcomes.map(({ op, status }) => [op, status]), [["SEND", 200], ["SEND", 200], ["NOTE", 200]]);
        assert.equal((await engine.runTurn({ ...env, provider, messages: [] })).status, 200);
        assert.equal((await lifecycle.result(env.loopId))?.content, undefined);
        assert.equal(await lastReply(db, env.loopId), "Second.");
    } finally { await db.close(); }
});

test("{§tokenomics} a later cancellation cannot overwrite a successful conclusion", async () => {
    const { db, env, engine, lifecycle } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: {
            content: "", reasoning: null, ops: [completeStmt("Answer.")],
        } }] });
        assert.equal((await engine.runTurn({ ...env, provider, messages: [] })).status, 200);
        await lifecycle.cancelTree(env.sessionId, "Late cancellation.", true);
        assert.equal(await lifecycle.status(env.loopId), 200);
        assert.equal((await lifecycle.result(env.loopId))?.content, undefined);
        assert.equal(await lastReply(db, env.loopId), "Answer.");
    } finally { await db.close(); }
});
});

describe("completion-defers-to-results", () => {
const frame = PlurnkParser.frame;
const response = (...program: string[]) => ({ assistant: { content: program.join("\n\n"), reasoning: null } });
const fixture = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `observe-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1, "Report the saved answer.");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "workspace", pathname: "/answer.md", channel: "body",
        content: "The answer is 42.", mimetype: "text/markdown", state: "static",
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
        cancelSession: async (id, reason) => { await new LoopLifecycle(db).cancelTree(id, reason, true); },
    });
    return { db, workspaceId, sessionId, loopId, engine };
};

for (const [op, maxStrikes] of [["READ (workspace:///answer.md)", 0], ["READ (workspace:///answer.md)", 1],
    ["READ (workspace:///answer.md)", 3], ["FIND (workspace:///answer.md)", 3], ["BARE", 3]] as const) {
    test(`{§loop-completion} ${op}, tolerance ${maxStrikes}: observe the result without repeating the answer`, async (t) => {
        const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(frame(op, op === "BARE" ? "What is six times seven?" : null), frame("SEND", "The answer is 42.")),
            response(frame("SEND [200]", null)),
        ] });
        const childProvider = new Mock({ contextWindow: 100000, responses: [response("42")] });
        const result = await engine.runLoop({ provider, childProvider, workspaceId, sessionId, loopId, messages: [], maxTurns: 3, maxStrikes });
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, loopId), "The answer is 42.");
        assert.equal(provider.received.length, 2);
        assert.match(JSON.stringify(provider.received[1]), /42/, "the observation packet contains the result");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string }>({ loop_id: loopId });
        const authored = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(authored.map((row) => row.op), [op.split(" ")[0], "SEND", "SEND"], "the model resolves its messages without repeating the answer");
        assert.equal(authored.find((row) => row.op === "SEND")?.status_rx, 200, "reply delivery is not deferred");
        assert.equal(await new StrikeRail(db).streak(loopId), 0);
        const turns = await Promise.all(result.turnIds.slice(1).map((id) => db.test_get_turn.get<{ status: number }>({ id })));
        assert.deepEqual(turns.map((turn) => turn?.status), [102, 200]);
    });
}

test("{§message-completion} observation permits a corrected reply", async (t) => {
    const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("READ (workspace:///answer.md)", null), frame("SEND", "The answer is 41.")),
        response(frame("SEND [200]", "Correction: the answer is 42.")),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Correction: the answer is 42.");
    const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
    assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The answer is 41.", "Correction: the answer is 42."]);
});

for (const target of ["log:///999/*/*", "workspace:///answer.md"]) {
    test(`{§message-completion} progress SEND plus successful KILL ${target} leaves the message unresolved`, async (t) => {
        const { engine, workspaceId, sessionId, loopId } = await fixture(t);
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(frame(`KILL (${target})`, null), frame("SEND", "Finished.")),
            response(frame("SEND [200]", null)),
        ] });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 2 });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 2);
    });
}

test("{§loop-completion} curation cannot turn a same-turn READ into an observed result", async (t) => {
    const { engine, workspaceId, sessionId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [response(
        frame("READ (workspace:///answer.md)", null), frame("KILL (log:///**/READ)", null), frame("SEND", "Finished."),
    )] });
    const turn = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
    assert.equal(turn.status, 102);
    assert.deepEqual(turn.outcomes.map(({ op }) => op), ["READ", "KILL", "SEND"]);
    assert.ok(turn.outcomes.filter(({ op }) => op !== "KILL").every(({ status }) => status === 200));
});

test("{§loop-completion} repeated work costs observations, not ceremony strikes", async (t) => {
    const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(frame("READ (workspace:///answer.md)", null), frame("SEND", "The answer is 42.")),
        response(frame("FIND (workspace:///answer.md)", null)),
        response(frame("SEND [200]", null)),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 4, maxStrikes: 1 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.equal(await new StrikeRail(db).streak(loopId), 0);
});

for (const kind of ["sessions", "streams", "failed-stream-results", "late-failed-stream-results", "session-results", "operation-failure", "kill-failure"] as const) {
    test(`{§loop-completion} ${kind} arriving after packet assembly prevents premature conclusion`, async (t) => {
        const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
        const live = kind === "sessions" || kind === "streams";
        const operation = kind === "operation-failure" ? "READ (workspace:///missing.md)" : kind === "kill-failure" ? "KILL (workspace:///missing.md)" : "SEND [200]";
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(frame("READ (workspace:///answer.md)", null), frame("SEND", "The answer is 42.")),
            response(frame(operation, null)), response(operation === "SEND [200]" ? "" : frame("SEND [200]", null)),
        ] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
            if (provider.received.length === 1) {
                if (kind === "sessions" || kind === "session-results") {
                    const child = await insertSession(db, workspaceId, sessionId, "child");
                    const childLoop = await insertLoop(db, child, 1, "Delegated work.");
                    if (kind === "session-results") await new LoopLifecycle(db).finish(childLoop, { status: 200, content: "Child result", mimetype: "text/plain" });
                } else if (["streams", "failed-stream-results", "late-failed-stream-results"].includes(kind)) {
                    const count = kind === "late-failed-stream-results" ? 9 : 1;
                    for (let index = 0; index < count; index++) {
                        const path = `/stream-${index}`;
                        const entryId = await seedEntryWithChannel(db, { workspaceId, authority: "alice", scheme: "session", pathname: path,
                            channel: "stdout", content: "Working", mimetype: "text/plain", state: "active" });
                        const subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "session", handle: path, publishedChannel: "stdout" });
                        if (kind !== "streams") await ChannelWrite.closeSubscription(db, { subscriptionId,
                            result: index === count - 1 ? Results.failure("executor:fixture", "failed", 500, "Fixture stream failed.") : { status: 200 },
                        });
                    }
                }
            }
            return generate(args);
        });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 5 });
        assert.equal(result.result.status, live ? 202 : 200);
        assert.equal(provider.received.length, live ? 2 : 3);
        if (!live) assert.match(JSON.stringify(provider.received[2]), kind === "session-results" ? /Child result/ : kind.endsWith("stream-results") ? /Fixture stream failed/ : /404/);
        const turns = await Promise.all(result.turnIds.slice(1).map((id) => db.test_get_turn.get<{ status: number }>({ id })));
        assert.deepEqual(turns.map((turn) => turn?.status), live ? [102, 202] : [102, 102, 200]);
    });
}

test("{§session-causal-admission} explicit scope cancellation does not wait for result observation", async (t) => {
    const { engine, db, workspaceId, sessionId, loopId } = await fixture(t);
    const childId = await insertSession(db, workspaceId, sessionId, "child");
    const childLoop = await insertLoop(db, childId, 1, "Still working.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(frame("READ (workspace:///missing.md)", null),
        frame("SEND", "Stopping the work."), frame("KILL (session://alice)", null))] });
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 2 });
    assert.equal(result.result.status, 499);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Stopping the work.");
    assert.equal(await new LoopLifecycle(db).status(childLoop), 499);
    assert.equal(provider.received.length, 1);
});
});

describe("live-harness-response", () => {
for (const cancelled of [false, true]) {
    test(`{§message-completion} the live harness retains the last SEND across ${cancelled ? "cancellation" : "completion"}`, async () => {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse("````FIND (workspace:///)\n````\n````SEND\nFirst answer.\n````"),
            makeMockResponse("````FIND (workspace:///)\n````\n````SEND\nSecond answer.\n````"),
            makeMockResponse(cancelled ? "````KILL (session://root)\n````" : "````SEND [200]\n````"),
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
        makeMockResponse("````SEND\n````"),
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
// {§message-completion} — ops://<session>/<loop> is what the loop said: the latest reply to the message that
// started it.










test("{§message-completion}: a loop's address reads its SEND answer; running is 425, absent is 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-answer-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const first = await insertLoop(db, sessionId, 1, "What is two plus two?");
        // A client read opens a loop on its reader, and this test numbers alice's loops: another session reads
        // her answers ({§turn-source-resources}), and alice reads her own log only once they are numbered.
        const observer = await insertSession(db, workspaceId, null, "observer");
        const read = (address: string, reader = observer) => clientRead(engine, db, { workspaceId, sessionId: reader, statement: statement(`\`\`\`\`READ (${address})\`\`\`\``) });

        const running = await read("ops://alice/1");
        assert.equal(running.status, 425, "a loop still running has not answered yet");
        assert.equal(running.problem?.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");

        const firstReply = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````SEND\nFour.\n````\n\n````SEND [200]\n````", reasoning: null } }] }),
            workspaceId, sessionId, loopId: first, maxTurns: 3, messages: [{ role: "user", content: "What is two plus two?" }],
        });
        assert.equal(firstReply.result.status, 200);
        const answered = await read("ops://alice/1");
        assert.equal(answered.status, 200);
        assert.ok("content" in answered);
        assert.equal(answered.content, "Four.", "the SEND is the loop's answer");

        const second = await insertLoop(db, sessionId, 2, "And three plus three?");
        const sent = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````SEND\nSix.\n````\n\n````SEND [200]\n````", reasoning: null } }] }),
            workspaceId, sessionId, loopId: second, maxTurns: 3, messages: [{ role: "user", content: "And three plus three?" }],
        });
        assert.equal(sent.result.status, 200);
        const reply = await read("ops://alice/2");
        assert.ok("content" in reply);
        assert.equal(reply.content, "Six.", "a SEND answer is the loop's answer too, without its fence");
        const written = (await db.test_log_entries_by_turn.all<{ op: string; origin: string; attrs: string; tx: string }>({ turn_id: sent.turnIds.at(-1)! }))
            .find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.equal(LogEntryProjection.leaf(written!), "SEND", "a SEND the model wrote stays a SEND");

        assert.equal((await read("ops://alice/9")).status, 404, "a loop that does not exist");
        assert.equal((await read("ops://alice/1/2")).status, 200, "a turn coordinate still reads that turn's emission");
        const row = await read("log:///1/2/3/SEND", sessionId);
        assert.equal(row.status, 200, "a final reply is an ordinary SEND row");
    } finally { await db.close(); }
});

for (const [shape, body] of [
    ["ordinary", "The draft is sound."],
    ["early closer", "The draft is sound.\n````\n```EDIT (workspace:///must-not-execute)\nNot an operation.\n```\nThe entire report is the answer.\n````"],
] as const) test(`{§message-completion} {§message-completion}: a child's ${shape} answer survives delivery and reading at its own address`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loop-answer-child-${crypto.randomUUID()}`);
        const parentId = await insertSession(db, workspaceId, null, "lead");
        const childId = await insertSession(db, workspaceId, parentId, "reviewer");
        const loopId = await insertLoop(db, childId, 1, "Review the draft.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: `\`\`\`\`SEND [200]\n${body}${shape === "ordinary" ? "\n````" : ""}`, reasoning: null } }] }),
            workspaceId, sessionId: childId, loopId, maxTurns: 3, messages: [{ role: "user", content: "Review the draft." }],
        });
        assert.equal(result.result.status, 200);
        const events = await db.test_loop_termination_events.all<{ rx: string }>({ recipient_session_id: parentId });
        assert.deepEqual(events.map(({ rx }) => JSON.parse(rx)), [{ status: 200 }], "the event retains the child's exact terminal result");
        const answer = await clientRead(engine, db, { workspaceId, sessionId: parentId, statement: statement("````READ (ops://reviewer/1)````") });
        assert.ok("content" in answer);
        assert.equal(answer.content, body, "the parent reads the complete answer where the termination points");
        const escaped = await db.test_get_channel_by_pathname.get({ pathname: "/must-not-execute", name: "body" });
        assert.equal(escaped, undefined, "the child's deliverable cannot execute its examples");
    } finally { await db.close(); }
});
});

describe("message-completion", () => {
const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `message-completion-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const ids = { workspaceId, sessionId, loopId };
    const message = (name: string) => `message://alice/${name}`;
    const add = (name: string) => engine.injectIntoLoop(loopId, `Request ${name}.`, [], undefined, {}, message(name));
    await add("first");
    const turn = (content: string, reasoning: string | null = null, finishReason: NonNullable<MockResponse["assistant"]>["finishReason"] = "stop") => engine.runTurn({
        ...ids, messages: [],
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning, finishReason } }] }),
    });
    const remaining = async () => (await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count;
    const replies = async () => (await db.message_history.all<{ direction: string; body: string }>({
        workspace_id: workspaceId, session_id: sessionId, loop_id: loopId,
    })).filter(({ direction }) => direction === "outbound").map(({ body }) => body);
    return { db, engine, ids, message, add, turn, remaining, replies };
};

test("{§message-completion}: progress delivers without resolving; explicit completion concludes", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    assert.equal((await f.turn(frame(`SEND (${f.message("first")})`, "Working."))).status, 102);
    assert.deepEqual(await f.replies(), ["Working."]);
    assert.equal(await f.remaining(), 1);
    assert.equal((await f.turn(frame("SEND [200]", "Finished."))).status, 200);
    assert.equal(await f.remaining(), 0);
    assert.deepEqual(await f.replies(), ["Working.", "Finished."]);
});

for (const code of [null, 200, 499]) {
    test(`{§log-wire-format} {§message-completion}: SEND ${code ?? "progress"} omits delivery success without changing message state`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await f.add("second");
        const body = code === null ? "Sign-in is required." : "The request is settled.";
        const result = await f.turn(frame(code === null ? "SEND" : `SEND [${code}]`, body));
        assert.equal(result.outcomes.find(({ op }) => op === "SEND")?.status, 200, "delivery still reports success");
        assert.equal(await f.remaining(), code === null ? 2 : 1);

        const observation = await f.turn(frame("NOTE", "The second request remains open."));
        const storedPacket = await f.db.test_get_packet.get<{ packet: string }>({ id: observation.turnId });
        const packet = JSON.parse(storedPacket!.packet);
        const receipts = logEntries(packet);
        const reply = receipts.find(({ answers }) => Array.isArray(answers) && answers.includes(f.message("first")));
        assert.ok(reply, "the delivered reply is present in the next packet");
        assert.equal(Object.hasOwn(reply, "status"), false, "delivery success cannot masquerade as message completion");
        assert.equal(Object.hasOwn(reply, "metadata"), false, "the paired operation supplies authored metadata");
        assert.equal(reply.body, undefined, "the answer appears once, in the complete operation");
        assert.equal(packetSection(packet, "emission-history"), frame(code === null ? "SEND" : `SEND [${code}]`, body));
        const arrivals = receipts.filter(({ origin }) => origin === "user");
        assert.equal(arrivals.length, 2);
        for (const arrival of arrivals) assert.equal(Object.hasOwn(arrival, "status"), false);
        const open = JSON.parse(packetSection(packet, "messages")) as Array<{ path: string }>;
        assert.deepEqual(open.map(({ path }) => path), (code === null ? arrivals : arrivals.slice(1)).map(({ resource }) => resource));

        const rows = await f.db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number; rx: string }>({ turn_id: result.turnId });
        const durable = rows.find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.equal(durable?.status_rx, 200);
        assert.equal(JSON.parse(durable.rx).status, 200);
    });
}

test("{§message-completion}: two independent final replies execute in one turn", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    const completed = await f.turn([
        frame(`SEND (${f.message("first")}) [200]`, "First answer."),
        frame(`SEND (${f.message("second")}) [200]`, "Second answer."),
    ].join("\n\n"));
    assert.equal(completed.status, 200);
    assert.equal(await f.remaining(), 0);
    assert.deepEqual(await f.replies(), ["First answer.", "Second answer."]);
});

for (const count of [0, 1, 2]) {
    for (const metadata of ["", " [200]", " [499]"]) {
        test(`{§message-completion}: targetless SEND${metadata} with ${count} Open Messages`, async (t) => {
            const f = await setup(); t.after(() => f.db.close());
            await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/evidence.txt", content: "Evidence." });
            if (count === 0) await f.turn(`${frame("READ (workspace:///evidence.txt)")}\n\n${frame(`SEND (${f.message("first")}) [200]`, "First answer.")}`);
            if (count === 2) await f.add("second");
            const before = await f.replies();
            const result = await f.turn(frame(`SEND${metadata}`, "Implicit reply."));
            const delivery = result.outcomes.find(({ op }) => op === "SEND");
            assert.equal(delivery?.status, 200);
            assert.equal(await f.remaining(), count > 0 && metadata !== "" ? count - 1 : count);
            assert.deepEqual(await f.replies(), [...before, "Implicit reply."]);
            const rows = await f.db.test_log_entries_by_turn.all<{ op: string; origin: string; rx: string }>({ turn_id: result.turnId });
            const reply = rows.find(({ op, origin }) => op === "SEND" && origin === "model");
            assert.deepEqual(JSON.parse(reply!.rx).answers, [f.message("first")]);
            if (count === 0) {
                assert.equal(JSON.parse(reply!.rx).completion, undefined, "with none open, the reply is speech only");
                assert.equal((await f.db.message_completion_outcome.get<{ status: number }>({ loop_id: f.ids.loopId }))!.status, 200,
                    "the completed message keeps its outcome");
            }
        });
    }
}

test("{§message-completion}: a targetless SEND in a loop with no published message is refused", async (t) => {
    const db = await openMigrated(); t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `message-completion-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "bob");
    const loopId = await insertLoop(db, sessionId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const result = await engine.runTurn({ workspaceId, sessionId, loopId, messages: [],
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("SEND", "Hello?"), reasoning: null, finishReason: "stop" } }] }) });
    const delivery = result.outcomes.find(({ op }) => op === "SEND");
    assert.equal(delivery?.status, 400);
    assert.equal(delivery?.problemType, "https://problems.plurnk.xyz/engine/dispatcher/send-target-required");
});

test("{§message-completion}: progress and consecutive completions consume the queue in authored order", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    const result = await f.turn([
        frame("SEND", "First progress."),
        frame("SEND [200]", "First answer."),
        frame("SEND", "Second progress."),
        frame("SEND [499]", "Second cancelled."),
    ].join("\n\n"));
    assert.equal(result.status, 200);
    assert.equal(await f.remaining(), 0);
    const rows = await f.db.test_log_entries_by_turn.all<{ op: string; origin: string; rx: string }>({ turn_id: result.turnId });
    assert.deepEqual(rows.filter(({ op, origin }) => op === "SEND" && origin === "model").map(({ rx }) => JSON.parse(rx).answers),
        [[f.message("first")], [f.message("first")], [f.message("second")], [f.message("second")]]);
});

test("{§message-completion}: corrections name an already-resolved message explicitly", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/evidence.txt", content: "New evidence." });
    assert.equal((await f.turn(`${frame("READ (workspace:///evidence.txt)")}\n\n${frame("SEND [200]", "Initial answer.")}`)).status, 102);
    assert.equal((await f.turn(frame(`SEND (${f.message("first")}) [200]`, "Corrected answer."))).status, 200);
    assert.deepEqual(await f.replies(), ["Initial answer.", "Corrected answer."]);
});

for (const tail of ["", frame("NOTE", "The result is sufficient."), frame("KILL (log:///**/READ)", "Retired inspected evidence.")]) {
    test(`{§loop-completion}: late results retain the answer and settle after ${tail || "no further operations"}`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "workspace", pathname: "/evidence.txt",
            channel: "body", content: "Late evidence.", mimetype: "text/plain", state: "static" });
        const first = await f.turn([frame("READ (workspace:///evidence.txt)"), frame("SEND [200]", "The deliverable.")].join("\n\n"));
        assert.equal(first.status, 102, "the READ receipt requires an observation turn");
        assert.equal(await f.remaining(), 0, "the delivered final reply resolved its messages already");
        assert.deepEqual(await f.replies(), ["The deliverable."], "the answer is not withheld");
        assert.equal((await f.turn(tail)).status, 200);
        assert.deepEqual(await f.replies(), ["The deliverable."], "settlement neither repeats nor erases the answer");
    });
}

test("{§loop-completion}: empty output with an unresolved message is recovery", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    const result = await f.turn("");
    assert.equal(result.status, 102);
    assert.equal(result.emptyTurn, true);
    assert.equal(await f.remaining(), 1);
});

test("{§message-completion}: empty completion resolves without replacing earlier speech", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.turn(frame(`SEND (${f.message("first")})`, "Delivered answer."));
    assert.equal((await f.turn(frame("SEND [200]"))).status, 200);
    assert.equal(await f.remaining(), 0);
    assert.deepEqual((await f.replies()).filter(Boolean), ["Delivered answer."]);
});

test("{§loop-completion}: new operations after final replies create new observation obligations", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "workspace", pathname: "/evidence.txt",
        channel: "body", content: "Inspect again.", mimetype: "text/plain", state: "static" });
    const read = frame("READ (workspace:///evidence.txt)");
    assert.equal((await f.turn(`${frame("SEND [200]", "Answer.")}\n\n${read}`)).status, 102);
    assert.equal((await f.turn(read)).status, 102);
    assert.equal((await f.turn("")).status, 200);
});

test("{§loop-completion}: final replies join held work without cancelling it", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    const childLoop = await holdChild(f.db, f.ids.workspaceId, f.ids.sessionId);
    assert.equal((await f.turn(frame("SEND [200]", "Answer while the child finishes."))).status, 202);
    assert.equal(await f.remaining(), 0);
    assert.equal((await f.db.lifecycle_loop_status.get<{ status: number }>({ loop_id: childLoop }))!.status, 102);
});

for (const code of [200, 499]) {
    test(`{§message-completion}: [${code}] leaves child and stream work alive until normal settlement`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        const childLoop = await holdChild(f.db, f.ids.workspaceId, f.ids.sessionId);
        const entry = await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "sh", pathname: "/live", channel: "stdout", state: "active" });
        const stream = await f.db.open_subscription.get<{ id: number }>({ session_id: f.ids.sessionId, entry_id: entry, scheme: "sh", handle: "fixture-live" });
        assert.ok(stream);
        const held = () => f.db.session_live_obligations.get<{ streams: number; sessions: number }>({ session_id: f.ids.sessionId });
        assert.equal((await f.turn(frame(`SEND [${code}]`, "Outcome delivered."))).status, 202);
        assert.deepEqual(await held(), { streams: 1, sessions: 1 }, "message resolution cancels neither obligation");
        const lifecycle = new LoopLifecycle(f.db);
        await lifecycle.finish(childLoop, { status: 200 });
        await f.db.close_subscription.run({ subscription_id: stream.id, status: 200, result: JSON.stringify({ status: 200 }), channel_results: "{}" });
        assert.deepEqual(await held(), { streams: 0, sessions: 0 });
        assert.equal(await lifecycle.wake(f.ids.loopId), true);
        assert.equal((await f.db.drain_claim_next_loop.get<{ id: number }>({ session_id: f.ids.sessionId }))?.id, f.ids.loopId);
        assert.equal((await f.turn("")).status, code, "the next packet observes normal settlement before the message outcome concludes the loop");
        assert.equal(await lifecycle.status(childLoop), 200, "parent cancellation does not rewrite the child's success");
    });
}

test("{§message-completion}: an attachment-only completion retains its deliverable", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/report.txt", content: "Final report." });
    assert.equal((await f.turn(frame('SEND [200,{"attachments":["workspace:///report.txt"]}]'))).status, 200);
    assert.equal(await f.remaining(), 0);
    const history = await f.db.message_history.all<{ direction: string; body: string; evidence: string }>({
        workspace_id: f.ids.workspaceId, session_id: f.ids.sessionId, loop_id: f.ids.loopId,
    });
    const replies = history.filter(({ direction }) => direction === "outbound");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].body, "");
    assert.deepEqual(JSON.parse(replies[0].evidence).attachments.map(({ target, name }: { target: string; name: string }) => ({ target, name })),
        [{ target: "workspace:///report.txt", name: "report.txt" }]);
});

test("{§message-completion}: a later request stays open after an earlier final reply", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    assert.equal((await f.turn(frame(`SEND (${f.message("first")}) [200]`, "First answer."))).status, 102);
    assert.equal(await f.remaining(), 1);
    assert.equal((await f.turn("")).status, 102);
    assert.equal((await f.turn(frame(`SEND (${f.message("second")}) [200]`, "Second answer."))).status, 200);
});

for (const [codes, expected] of [[[499, 499], 499], [[499, 200], 200], [[200, 499], 200]] as const) {
    test(`{§message-completion}: message outcomes ${codes.join("+")} settle as ${expected}`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await f.add("second");
        const result = await f.turn([
            frame(`SEND (${f.message("first")}) [${codes[0]}]`, "First outcome."),
            frame(`SEND (${f.message("second")}) [${codes[1]}]`, "Second outcome."),
        ].join("\n\n"));
        assert.equal(result.status, expected);
        assert.equal(await f.remaining(), 0);
        assert.deepEqual(await f.replies(), ["First outcome.", "Second outcome."]);
    });
}

test("{§message-completion}: a corrected completion wins without ordinary progress reopening it", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    await f.turn(frame(`SEND (${f.message("first")}) [499]`, "Cannot yet deliver."));
    await f.turn(frame(`SEND (${f.message("first")}) [200]`, "Found the answer."));
    await f.turn(frame(`SEND (${f.message("first")})`, "Additional context."));
    assert.equal(await f.remaining(), 1);
    assert.equal((await f.turn(frame(`SEND (${f.message("second")}) [499]`, "Cancelled."))).status, 200);
});

for (const invalid of ["[201]", "[500]", "[200,499]", '["200"]', '[200,{"attachments":["workspace:///missing.pdf"]}]']) {
    test(`{§message-completion}: failed reply ${invalid} leaves its message unresolved`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        const result = await f.turn(frame(`SEND ${invalid}`, "Not delivered."));
        assert.equal(result.status, 102);
        assert.ok(result.outcomes.some(({ status }) => status >= 400));
        assert.equal(await f.remaining(), 1);
        assert.deepEqual(await f.replies(), []);
    });
}

for (const finishReason of ["length", "content_filter", "tool_calls"] as const) {
    test(`{§loop-completion}: ${finishReason} cannot close an otherwise resolved loop`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "workspace", pathname: "/evidence.txt",
            channel: "body", content: "Evidence.", mimetype: "text/plain", state: "static" });
        await f.turn(`${frame("READ (workspace:///evidence.txt)")}\n\n${frame("SEND [200]", "Answer.")}`);
        assert.equal((await f.turn("", "", finishReason)).status, 102);
        assert.equal((await f.turn("")).status, 200);
    });
}

for (const content of [
    "READ (workspace:///evidence.txt)",
    '<tool_call><function=READ><parameter=unknown>evidence.txt</parameter></function></tool_call>',
    frame("reed (workspace:///evidence.txt)"),
    `${frame("NOTE", "Inspect more evidence.")}\n\nREAD (workspace:///evidence.txt)`,
]) {
    test(`{§loop-completion}: omitted operation cannot certify settlement: ${content}`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/evidence.txt", content: "Evidence." });
        assert.equal((await f.turn(`${frame("READ (workspace:///evidence.txt)")}\n\n${frame("SEND [200]", "Answer.")}`)).status, 102);
        assert.equal((await f.turn(content)).status, 102, "omitted work requires another opportunity to act");
        assert.equal((await f.turn("")).status, 200, "the diagnostic does not create a lasting acknowledgement state");
    });
}

test("{§loop-completion}: an admitted syntax recovery does not withhold completion", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    const result = await f.turn("````\nSEND [200]\nAnswer.\n````");
    assert.equal(result.status, 200);
    assert.deepEqual(await f.replies(), ["Answer."]);
});
});

describe("native-tool-calls", () => {
for (const transport of ["text", "wire"] as const) {
    for (const withOperation of [false, true]) {
        test(`{§fence-pairing} {§provider-failure-normalization}: ${transport} calls withOperation=${withOperation} retain valid work and use ordinary strikes`, async () => {
            const db = await openMigrated();
            try {
                const workspaceId = await insertWorkspace(db, "native-calls");
                const sessionId = await insertSession(db, workspaceId, null, "alice");
                const loopId = await insertLoop(db, sessionId, 1, "Update the fact.");
                await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Original fact." });
                const markup = '<tool_call><function=EDIT><parameter=old_string>Original fact.</parameter><parameter=new_string>Unadmitted change.</parameter></function></tool_call>';
                const tool = { index: 0, id: "call-1", type: "function", function: { name: "EDIT", arguments: '{"path":"workspace:///fact.txt","body":"Unadmitted change."}' } };
                const operation = withOperation ? PlurnkParser.frame("EDIT (workspace:///fact.txt) <1,-1>", "Admitted change.") : "";
                const content = transport === "text" ? `${operation}\n\n${markup}` : operation;
                const notices: Notice[] = [];
                let requests = 0;
                const provider = new AiSdkProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
                    fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
                    temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "off", budget: null },
                    fetch: async () => {
                        requests += 1;
                        const first = requests === 1;
                        const delta = first ? { content, ...(transport === "wire" ? { tool_calls: [tool] } : {}) }
                            : { content: PlurnkParser.frame("SEND [200]", "Finished.") };
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
                const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string; status_rx: number }>({ turn_id: first });
                assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ status_rx }) => status_rx), withOperation ? [200] : []);
                assert.deepEqual(rows.filter(({ op }) => op === "error").map(({ rx }) => JSON.parse(rx).problem.detail),
                    withOperation ? [] : ["The turn performed no operation."]);
                const fact = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/fact.txt", scheme: "workspace", name: "body" });
                assert.equal(fact?.content, withOperation ? "Admitted change." : "Original fact.");
                assert.equal(notices.filter(({ message }) => transport === "wire"
                    ? message === "The response included native tool calls, but no tools were declared."
                    : message?.includes("tool-call markup and was not executed")).length, 1);
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
        const tool = { index: 0, id: "call-extra", type: "function", function: { name: "READ", arguments: '{"path":"workspace:///fact.txt"}' } };
        let requests = 0;
        const provider = new AiSdkProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
            fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
            temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "off", budget: null },
            fetch: async () => {
                requests += 1;
                const delta = requests === 1 ? { content: `${PlurnkParser.frame("READ (workspace:///fact.txt)", null)}\n${PlurnkParser.frame("SEND [200]", "The fact.")}` }
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

describe("premature-terminate-child", () => {
// {§loop-completion} extended to child sessions — completion while a spawned child is still
// live is premature exactly as completion with an open stream is (children and streams are the same
// kind of "live thing the session holds", {§session-loop-lifecycle}). Engine-level A/B so it's race-free.













const knownPath = (pathname: string): ParsedPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: null,
});

test("{§loop-completion} completion with a live child session joins it on the record (no erasure), never a strike", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-child-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const send200 = (loopId: number) => engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } }] }),
            workspaceId, sessionId: parentSession, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        // Baseline: no child → completed inventory can conclude.
        const clean = await send200(parentLoop);
        assert.equal(clean.status, 200, "with no live child, completed inventory terminates cleanly");

        // Spawn a live child session (parent_session_id = parentSession, a non-terminal loop — default status 102).
        const childSession = await insertSession(db, workspaceId, parentSession);
        await insertLoop(db, childSession, 1, "child");

        // Completion over a live child is a join ({§loop-completion}): the loop parks.
        const joiningLoop = await insertLoop(db, parentSession, 2, "parent again");
        const premature = await send200(joiningLoop);
        assert.equal(premature.status, 202, "the completion joins the live child: the loop parks, it never went terminal");

        const rows = await db.test_log_entries_by_turn.all<{ status_rx: number; op: string; origin: string }>({ turn_id: premature.turnId });
        const modelRows = rows.filter(({ origin }) => origin === "model");
        const completion = modelRows.find((r) => r.op === "SEND");
        assert.deepEqual(modelRows.map(({ op }) => op), ["SEND"], "joining adds no fictional operation");
        assert.equal(completion?.status_rx, 200, "the reply is delivered while the loop joins the child");
    } finally { await db.close(); }
});

test("{§loop-completion} an _plurnk administrative completion closes only its own loop while model work remains live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `admin-terminal-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const modelLoopId = await insertLoop(db, sessionId, 1, "model work");
        const childSessionId = await insertSession(db, workspaceId, sessionId);
        const childLoopId = await insertLoop(db, childSessionId, 1, "child work");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, sessionId, [noteStmt("Maintenance.")]);
        const loops = await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: sessionId });
        assert.ok(loops.some(({ id, status }) => id !== modelLoopId && status === 200),
            "the administrative transaction closes despite unrelated model work");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: modelLoopId }))?.status, 102, "the model loop remains live");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: childLoopId }))?.status, 102, "the child obligation remains live");
    } finally { await db.close(); }
});

test("{§loop-completion} a newer terminal loop cannot mask a child's older unresolved work", async () => {
    // A real fork clamps inherited loops terminal before creating its own work.
    // This deliberately inconsistent fixture proves that every unresolved loop
    // remains a live obligation regardless of newer history.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-concluded-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const childSession = await insertSession(db, workspaceId, parentSession);
        const unresolvedLoop = await insertLoop(db, childSession, 1, "unresolved");
        const ownLoop = await insertLoop(db, childSession, 2, "own work");        // seq 2 — the child's actual loop
        await db.test_set_loop_status.run({
            id: ownLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        }); // it concluded

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const refused = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(refused.status, 202, "the older unresolved loop keeps the child live: the completion joins it");

        await db.test_set_loop_status.run({
            id: unresolvedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        await new LoopLifecycle(db).wake(parentLoop);
        assert.equal((await db.drain_claim_next_loop.get<{ id: number }>({ session_id: parentSession }))?.id, parentLoop);
        const completed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(completed.status, 200, "completion succeeds only after every child loop is terminal");
    } finally { await db.close(); }
});

// {§loop-completion}: settlement follows the entire admitted program.

test("{§loop-completion}: READ + completed inventory in the same turn is deferred — the pending set includes this turn's retrievals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pend-read-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), sendStmt(null, "the host is db.internal")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "the turn stays a continue — the loop never went terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.equal(rows.find((r) => r.op === "SEND")?.status_rx, 200, "successful delivery is not rewritten to describe loop continuation");
        // The STORED record agrees with the return: the close persists the provisional status
        // pre-dispatch, and the refusal demotes the stored row too.
        const storedTurn = await db.test_get_turn.get<{ status: number }>({ id: result.turnId });
        assert.equal(storedTurn?.status, 102, "the persisted turns.status is demoted — the digest surface never lies");
    } finally { await db.close(); }
});

test("{§op-shapes} WAIT ignores a non-duration decoration and continues without live work", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `park-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "```WAIT <-1>\nstanding by\n```", reasoning: null } }] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "an ignored scope does not invent a future wake");
        const row = await db.test_disposition_rows_for_session.all<{ status_rx: number; rx: string }>({ session_id: sessionId });
        assert.equal(row.length, 1);
        assert.equal(row[0].status_rx, 102);
        assert.equal(JSON.parse(row[0].rx).problem, undefined);
        assert.equal(JSON.parse(row[0].rx).detail, "Nothing is in flight. Continuing."); // {§operation-results}
    } finally { await db.close(); }
});

test("{§op-shapes} a decorated WAIT keeps its sibling, source evidence, and ordinary result", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `next-scope-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "read the note");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.txt", channel: "body", content: "the note", mimetype: "text/plain", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const content = "````READ (workspace:///note.txt)````\n````WAIT (sh:///missing) [60] [{\"timeout\":42}]\nstanding by\n````";
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content, reasoning: null } }] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "read the note" }],
        });
        assert.equal(result.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.find(({ op }) => op === "READ")?.status_rx, 200, "the valid sibling executes");
        assert.equal(rows.some(({ op }) => op === "error"), false);
        const task = rows.find(({ op }) => op === "WAIT");
        assert.equal(task?.status_rx, 102);
        assert.equal(JSON.parse(task.rx).problem, undefined);
        assert.equal(JSON.parse(task.rx).detail, "Nothing is in flight. Continuing."); // {§operation-results}
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, content);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.equal(attempts[0]?.accepted, 1);
        const diagnostics = JSON.parse(attempts[0].parse_errors) as Array<{ message: string }>;
        assert.deepEqual(diagnostics, []);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 102);
    } finally { await db.close(); }
});

test("{§loop-completion} waiting cannot complete an empty join over a same-turn failed operation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-failure-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({
                contextWindow: 100000,
                responses: [{
                    assistant: {
                        content: "",
                        reasoning: null,
                        ops: [
                            execStmt("unregistered-runtime", "build"),
                            dispositionStmt("WAIT", "awaiting the build"),
                        ],
                    },
                }],
            }),
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        assert.equal(result.status, 102, "the failed operation remains unobserved, so the turn continues");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "the loop never records a false successful terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.ok((rows.find((row) => isExecutionOp(row.op))?.status_rx ?? 0) >= 400, "the original operation failure is preserved");
        assert.equal(rows.find((row) => row.op === "WAIT")?.status_rx, 102, "the failed result enters the next packet without an additional correction");
    } finally { await db.close(); }
});

test("{§loop-completion} a successful same-turn scoped KILL continues an empty wait and permits explicit completion", async () => {
    const db = await openMigrated();
    try {
        const run = async (status: 200 | 202) => {
            const workspaceId = await insertWorkspace(db, `fold-disposition-${status}-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "curate");
            await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "workspace",
                pathname: "/notes.md",
                channel: "body",
                content: "context to curate",
                mimetype: "text/markdown",
                state: "static",
            });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const primed = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 100000,
                    responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/notes.md")), noteStmt("Continue.")] } }],
                }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
            });
            const rows = await db.test_log_sequencees_by_turn.all<{ sequence: number; op: string }>({ turn_id: primed.turnId });
            const read = rows.find((row) => row.op === "READ");
            assert.ok(read, "the prior READ provides one open log row to curate");
            const primedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: primed.turnId });
            assert.ok(primedTurn, "the model turn has a durable loop coordinate");
            const result = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 100000,
                    responses: [{
                        assistant: {
                            content: "",
                            reasoning: null,
                            ops: [
                                killStmt(urlPath("log", `/1/${primedTurn.sequence}/${read.sequence}/READ`), { marks: [1, -1] }),
                                status === 202 ? dispositionStmt("WAIT", "continue after curation") : sendStmt(null, "curation complete"),
                            ],
                        },
                    }],
                }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "system", content: "SD" }, { role: "user", content: "continue" }],
            });
            return { loopId, result };
        };

        const continued = await run(202);
        assert.equal(continued.result.status, 102, "log curation makes the next packet meaningful, so an empty wait continues");
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: continued.loopId }))?.status,
            102,
            "the curated loop remains available for its next reasoning turn",
        );

        const concluded = await run(200);
        assert.equal(concluded.result.status, 102, "curation executes, but a progress SEND leaves the message unresolved");
    } finally { await db.close(); }
});

test("{§loop-completion} a READ with a NOTE continues while its message remains unanswered", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-read-ok-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), noteStmt("Continue.")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "READ with a NOTE does not answer the assignment");
    } finally { await db.close(); }
});

test("{§loop-completion} a model declaring done with a live child parks on the first claim: no false 200, no spin", async () => {
    // The 200-vs-202 robustness: a model that declares done while its child works is joined to that
    // work — the loop parks and the wake brings the result — so it can never falsely complete, and it
    // never spins through turns claiming done.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-strike-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        // A persistently live child (its loop stays non-terminal through the parent's whole loop).
        const childSession = await insertSession(db, workspaceId, parentSession);
        await insertLoop(db, childSession, 1, "child");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 6 }, () => ({ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } })) });
        const result = await engine.runLoop({ provider, workspaceId, sessionId: parentSession, loopId: parentLoop, messages: [], maxTurns: 10, maxStrikes: 3 });
        assert.equal(result.result.status, 202, "the first claim joins the live child: the loop parks");
        assert.equal(provider.received.length, 1, "no further turn runs until the child concludes and wakes the loop");
        assert.notEqual(result.result.status, 200, "a model declaring done with work running NEVER gets a false 200");
    } finally { await db.close(); }
});

test("{§loop-completion} 499 is never gated by live work: it recursively cancels unresolved descendants", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `guard-499-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const childSession = await insertSession(db, workspaceId, parentSession);
        const childLoop = await insertLoop(db, childSession, 1, "child"); // live child
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"x"}', mimetype: "application/json", state: "static" });
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
            cancelSession: async (root, reason) => { await lifecycle.cancelTree(root, reason, true); },
        });
        const parent = await db.envelope_get_session_by_id.get<{ name: string }>({ id: parentSession });
        assert.ok(parent);
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [killStmt({ ...urlPath("session", ""), hostname: parent.name, raw: `session://${parent.name}` })] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 499, "the abandon lands — live work never gates a 499 ({§loop-completion} defers only settled results)");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop }))?.status;
        assert.equal(loopStatus, 499, "the loop is terminal");
        const childStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: childLoop }))?.status;
        assert.equal(childStatus, 499, "the unresolved child is cancelled with its abandoned parent scope");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; origin: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["KILL", 200]],
            "cancellation is the actual KILL, not an invented failure operation");
    } finally { await db.close(); }
});
});

describe("reply-completion", () => {
const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const response = (content: string, reasoning: string | null = null): MockResponse => ({ assistant: { content, reasoning } });
const setup = async (responses: MockResponse[]) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `reply-completion-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1);
    const notices: Array<{ kind: string; message?: string }> = [];
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
    await engine.injectIntoLoop(loopId, "Answer the question.", [], "acp://operator/threads/alice/messages/question");
    const provider = new Mock({ contextWindow: 100_000, responses });
    return { db, engine, provider, workspaceId, sessionId, loopId, notices,
        turn: () => engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] }),
        history: () => db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId }),
    };
};
const speech = async (f: Awaited<ReturnType<typeof setup>>) => (await f.history())
    .filter(({ direction, body }) => direction === "outbound" && body.trim().length > 0).map(({ body }) => body);

test("{§operation-fences}: ordinary EDIT, progress SEND and final SEND execute without framing notices", async (t) => {
    const f = await setup([
        response(frame("EDIT (workspace:///kept.md)", "Retained.")),
        response(frame("SEND", "Progress delivered.")),
        response(frame("SEND [200]", "Verified.")),
    ]);
    t.after(() => f.db.close());
    for (const status of [102, 102, 200]) {
        const turn = await f.turn();
        assert.equal(turn.status, status);
        assert.equal(turn.emptyTurn, false);
        const rows = await f.db.test_log_entries_by_turn.all<{ status_rx: number }>({ turn_id: turn.turnId });
        assert.equal(rows.some(({ status_rx }) => status_rx >= 400), false);
    }
    assert.equal(f.notices.some(({ message }) => message?.includes("backticks")), false);
    assert.equal((await f.db.test_get_channel_by_pathname.get({ pathname: "/kept.md", name: "body" }))?.content, "Retained.");
    assert.deepEqual(await speech(f), ["Progress delivered.", "Verified."]);
});

for (const shape of ["nested", "indented"] as const) {
    test(`{§fence-pairing}: a ${shape} deletion example is not executed`, async (t) => {
        const example = frame("KILL (workspace:///kept.md)");
        const answer = `Example only:\n${example}\nNothing was deleted.`;
        const content = shape === "nested" ? frame("SEND [200]", answer)
            : example.split("\n").map((line) => `\t${line}`).join("\n") + "\n\n" + frame("SEND [200]", "Done.");
        const f = await setup([response(frame("EDIT (workspace:///kept.md)", "Retained.")), response(content)]);
        t.after(() => f.db.close());
        assert.equal((await f.turn()).status, 102);
        const final = await f.turn();
        assert.equal(final.status, 200);
        assert.equal((await f.db.test_get_channel_by_pathname.get({ pathname: "/kept.md", name: "body" }))?.content, "Retained.");
        assert.deepEqual(await speech(f), [shape === "nested" ? answer : "Done."]);
        assert.equal((await f.db.test_log_entries_by_turn.all<{ op: string }>({ turn_id: final.turnId })).some(({ op }) => op === "KILL"), false);
    });
}

test("{§outside-text}: rejected prose is not silently promoted by a later completion", async (t) => {
    const f = await setup([response("42."), response(frame("SEND [200]"))]);
    t.after(() => f.db.close());
    const first = await f.turn();
    assert.equal(first.status, 102);
    assert.equal(first.emptyTurn, true);
    assert.equal((await f.turn()).status, 200);
    assert.deepEqual(await speech(f), []);
});

for (const completionFirst of [false, true]) {
    test(`{§loop-completion}: EDIT ${completionFirst ? "after" : "before"} a final reply still runs and requires observation`, async (t) => {
        const edit = frame("EDIT (workspace:///answer)", "42");
        const reply = frame("SEND [200]", "Delivered answer.");
        const f = await setup([response((completionFirst ? [reply, edit] : [edit, reply]).join("\n\n")), response("")]);
        t.after(() => f.db.close());
        const first = await f.turn();
        assert.equal(first.status, 102);
        assert.deepEqual(await speech(f), ["Delivered answer."], "delivery does not wait for observation");
        assert.equal((await f.db.test_get_channel_by_pathname.get({ pathname: "/answer", name: "body" }))?.content, "42");
        assert.ok(f.notices.some(({ message }) => message === "All Open Messages resolved. Review new results; emit no OPs if finished."));
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await speech(f), ["Delivered answer."], "settlement does not replay the reply");
    });

    test(`{§loop-completion}: curation ${completionFirst ? "after" : "before"} completion runs without extending the loop`, async (t) => {
        const curate = frame("KILL (log:///**/NOTE)");
        const reply = frame("SEND [200]", "42.");
        const f = await setup([response(frame("NOTE", "Disposable scratch.")), response((completionFirst ? [reply, curate] : [curate, reply]).join("\n\n"))]);
        t.after(() => f.db.close());
        assert.equal((await f.turn()).status, 102);
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await speech(f), ["42."]);
        assert.equal((await f.db.engine_render_log.all<{ op: string }>({ session_id: f.sessionId })).some(({ op }) => op === "NOTE"), false);
    });
}

for (const body of [null, "", " \n\t"]) {
    test(`{§message-completion}: empty reply ${JSON.stringify(body)} resolves without inventing speech`, async (t) => {
        const f = await setup([response(frame("SEND [200]", body))]);
        t.after(() => f.db.close());
        const turn = await f.turn();
        assert.equal(turn.status, 200);
        assert.equal(turn.emptyTurn, false);
        assert.equal(await new LoopLifecycle(f.db).status(f.loopId), 200);
        assert.deepEqual(await speech(f), []);
        assert.deepEqual((await f.history()).filter(({ direction }) => direction === "inbound").map((message) => message.body), ["Answer the question."]);
        assert.deepEqual((await f.history()).filter(({ direction }) => direction === "outbound"), [], "the completion fact is not an empty outbound message");
        assert.equal((await f.db.message_unanswered_count.get({ loop_id: f.loopId }))?.count, 0);
    });
}

for (const stage of ["inference", "terminal transition"] as const) {
    test(`{§message-arrival}: a reply cannot resolve an unseen message arriving during ${stage}`, async (t) => {
        const f = await setup([response(frame("SEND [200]")), response(frame("SEND [200]"))]);
        t.after(() => f.db.close());
        let injected = false;
        const inject = async () => {
            if (injected) return;
            injected = true;
            await f.engine.injectIntoLoop(f.loopId, "A later request.");
        };
        if (stage === "inference") {
            const generate = f.provider.generate.bind(f.provider);
            t.mock.method(f.provider, "generate", async (...args: Parameters<Mock["generate"]>) => { await inject(); return generate(...args); });
        } else {
            const finish = LoopLifecycle.prototype.finish;
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<LoopLifecycle["finish"]>) {
                if (args[0] === f.loopId) await inject();
                return finish.apply(this, args);
            });
        }
        assert.equal((await f.turn()).status, 102);
        assert.equal((await f.db.message_unanswered_count.get({ loop_id: f.loopId }))?.count, 1);
        assert.equal((await f.turn()).status, 200);
        assert.match(JSON.stringify(f.provider.received[1]), /A later request\./u);
        assert.deepEqual(await speech(f), []);
    });
}

test("{§loop-completion}: a reasoning NOTE does not extend a resolved loop", async (t) => {
    const f = await setup([response(frame("SEND [200]", "42."), frame("NOTE", "Arithmetic verified."))]);
    t.after(() => f.db.close());
    assert.equal((await f.turn()).status, 200);
    assert.deepEqual(await speech(f), ["42."]);
});

for (const [header, status] of [["SEND (reasoning://alice/1/1)", 400], ["KILL (log:///9/9/9)", 404]] as const) {
    test(`{§loop-completion}: failure of ${header} requires observation but never withholds a successful reply`, async (t) => {
        const f = await setup([response(`${frame(header)}\n\n${frame("SEND [200]", "Answer.")}`), response("")]);
        t.after(() => f.db.close());
        const first = await f.turn();
        assert.equal(first.status, 102);
        assert.deepEqual(await speech(f), ["Answer."]);
        assert.ok((await f.db.test_log_entries_by_turn.all<{ status_rx: number }>({ turn_id: first.turnId })).some(({ status_rx }) => status_rx === status));
        assert.equal((await f.turn()).status, 200);
    });
}

test("{§loop-completion}: omitted operations prevent settlement and an omitted reply resolves nothing", async (t) => {
    const previous = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "1";
    t.after(() => { if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = previous; });
    const f = await setup([response([frame("NOTE", "Kept."), frame("NOTE", "Omitted."), frame("SEND [200]", "Not delivered.")].join("\n\n")), response(frame("SEND [200]", "Reviewed."))]);
    t.after(() => f.db.close());
    const first = await f.turn();
    assert.equal(first.status, 102);
    assert.deepEqual(await speech(f), []);
    assert.equal((await f.db.message_unanswered_count.get({ loop_id: f.loopId }))?.count, 1);
    assert.ok((await f.db.test_log_entries_by_turn.all<{ status_rx: number; rx: string }>({ turn_id: first.turnId }))
        .some(({ status_rx, rx }) => status_rx === 429 && JSON.parse(rx).problem?.omittedOperations === 2));
    assert.equal((await f.turn()).status, 200);
    assert.deepEqual(await speech(f), ["Reviewed."]);
});
});

describe("send-200-mutation-receipts", () => {
for (const curate of [false, true]) {
    test(`{§loop-completion}: mutation receipts require observation, including when curated=${curate}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const extra = curate ? "````READ (workspace:///notes.md)\n````\n````READ (workspace:///notes.md)\n````\n````KILL (log:///**/EDIT)\n````\n" : "";
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse("````EDIT (workspace:///notes.md)\nhello\n````\n" + extra + "````SEND\nWritten.\n````"),
            makeMockResponse("````SEND [200]\n````"),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mutation-gate" });
                const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.equal(result.finalStatus, 200);
                assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), "Written.");
                assert.equal(mock.received.length, 2, "a completed mutation needs one observation turn, no terminal ceremony");
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: result.loopId });
                const model = rows.filter(({ origin }) => origin === "model");
                assert.deepEqual(model.map(({ op }) => op), curate ? ["EDIT", "READ", "READ", "KILL", "SEND", "SEND"] : ["EDIT", "SEND", "SEND"]);
                assert.equal(model[0].status_rx, 201);
                assert.deepEqual(model.slice(1).map(({ op, status_rx }) => [op, status_rx]),
                    curate ? [["READ", 200], ["READ", 200], ["KILL", 204], ["SEND", 200], ["SEND", 200]] : [["SEND", 200], ["SEND", 200]],
                    "curation cannot select a same-turn receipt before it is published");
                assert.match(JSON.stringify(mock.received[1]), /notes\.md/);
                const entry = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "workspace", name: "body" });
                assert.equal(entry?.content, "hello", "both creation and retained content are verified");
            } finally { ws.close(); }
        });
    });
}
});

describe("send-200-stream-success", () => {
// {§loop-completion} {§message-completion}








const withSettlement = async (ms: string, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = ms;
    try {
        await fn();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
};

for (const command of ["true", "hostname"]) {
    for (const earlyReply of [false, true]) test(`{§loop-completion} a successful ${command} reaches the next packet, early reply=${earlyReply}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const answer = command === "hostname" ? hostname() : "The command completed successfully.";
        const reply = earlyReply ? "\n````SEND\nThe hostname is plurnk-sandbox.\n````" : "";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                makeMockResponse(`\`\`\`\`sh\n${command}\n\`\`\`\`${reply}`),
                makeMockResponse(`\`\`\`\`SEND [200]\n${answer}\n\`\`\`\``),
            ],
        });
        await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "stream-success-terminal" });
                const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude" });
                assert.equal(result.finalStatus, 200);
                assert.equal(provider.remaining, 0, "the model gets exactly one observation turn before completing");
                assert.equal(provider.received.length, 2);
                assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), answer, "the corrected answer is the response; the blind first SEND stays a log row");
                const observedPacket = JSON.stringify(provider.received[1]);
                assert.match(observedPacket, /terminal/, "the next packet contains the stream conclusion");
                if (command === "hostname") assert.ok(observedPacket.includes(hostname()), "the actual hostname reaches the model");
                const rows = await db.test_log_entries_by_session.all<{ op: string; origin: string; status_rx: number }>({ session_id: result.modelSessionId });
                assert.ok(rows.some((r) => isExecutionOp(r.op)), "the stream ran");
                assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op),
                    ["sh", ...(earlyReply ? ["SEND"] : []), "SEND"], "no synthetic completion operation");
                assert.equal(rows.filter((r) => r.op === "SEND" && r.origin === "model" && r.status_rx === 200).length,
                    earlyReply ? 2 : 1, "only the authored replies were delivered");
            } finally {
                ws.close();
            }
        }));
    });
}

test("{§loop-completion}: a successful execution receipt defers completion one packet without a strike", async (t) => {
    serverProposals(t, "accept");
    const previous = process.env.PLURNK_SERVICE_MAX_STRIKES;
    process.env.PLURNK_SERVICE_MAX_STRIKES = "1";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_STRIKES;
        else process.env.PLURNK_SERVICE_MAX_STRIKES = previous;
    });
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\ntrue\n````\n````SEND\nCompleted.\n````"),
            makeMockResponse("````SEND [200]\n````"),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-final-strike" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "run the command" });
            assert.equal(result.finalStatus, 200, "the deferred completion concludes on the next packet; at MAX_STRIKES 1 a strike would have ended the loop");
            assert.equal(provider.received.length, 2);
            assert.equal(provider.remaining, 0);
            const rows = await db.test_log_entries_by_session.all<{ op: string; origin: string; status_rx: number }>({ session_id: result.modelSessionId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["sh", "SEND", "SEND"]);
            assert.equal(result.result.content, undefined);
            assert.equal(await lastReply(db, result.loopId), "Completed.", "an empty completion resolves the observed assignment without repeating its answer");
            assert.equal(rows.filter(({ op, origin }) => isExecutionOp(op) && origin === "model").length, 1, "the submitted command was executed");
        } finally {
            ws.close();
        }
    }));
});

test("{§loop-completion}: a same-turn stream's nonzero exit defers completion without echoing its command", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("````sh\nexit 3\n````\n````SEND\nconcluding blind\n````"),
            makeMockResponse("````SEND [200]\nconcluding after reading the failure\n````"),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-failure-terminal" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude" });
            assert.equal(result.finalStatus, 200);
            assert.equal(provider.remaining, 0, "the deferral cost exactly one more provider turn");
            const rows = await db.test_log_entries_by_session.all<{ id: number; op: string; origin: string; status_rx: number }>({ session_id: result.modelSessionId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["sh", "SEND", "SEND"]);
            assert.ok(rows.some(({ op, origin, status_rx }) => op === "READ" && origin === "_plurnk" && status_rx === 200), "the terminal stream observation lands as the command's answer");
            assert.match(JSON.stringify(provider.received[1]), /\\"exitCode\\":3/, "the exit code reaches the observation packet");
            assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), "concluding after reading the failure");
            assert.ok(rows.filter(({ origin, op }) => origin === "model" && ["SEND", "KILL"].includes(op)).every(({ status_rx }) => status_rx === 200),
                "both replies succeeded independently of the execution");
        } finally {
            ws.close();
        }
    }));
});
});

describe("send-response", () => {
// {§message-completion} — a delivered reply names the open messages it answered.






// Every operation is on the line after its fence.
const MISFENCED = [
    "````\nsh <!-- brand presence -->\nprintf plurnk\n````",
    "````\nREAD (workspace:///notes.md) <!-- retry the notes -->\n````",
    "````\nWAIT\nResearch positioning.\n````",
].join("\n\n");

test("{§operation-fences}: a complete nested reply reaches the client without executing its examples", async (approvalContext) => {
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
            const { finalStatus, loopId, result, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "Explain with examples." });
            assert.equal(finalStatus, 200);
            assert.equal(result.content, undefined);
            assert.equal(await lastReply(db, loopId), body, "the client receives the entire answer, not its prefix");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["SEND", 200], ["SEND", 200]], "quoted commands produce no dispatch, proposals or execution receipts");
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
        makeMockResponse("````SEND [200]\nthe answer\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-misfenced" });
            const { finalStatus, loopId, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "research plurnk" });
            assert.equal(finalStatus, 200, "the second turn concludes");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; tx: string }>({ loop_id: loopId });
            const model = rows.filter((r) => r.origin === "model").map(({ op, tx }) => ({ op, tx }));
            assert.ok(model.some(({ op }) => op === "READ"), "the READ under a bare fence ran");
            assert.ok(model.every(({ op }) => op !== "WAIT"), "the complete nested annotation remains literal under the same rule as NOTE and log KILL");
            assert.ok(model.some(({ op, tx }) => op === "NOTE" && JSON.parse(tx).body === "````\n\n````\nWAIT\nResearch positioning."),
                "the complete annotation survives rather than executing its quoted WAIT");
            assert.ok(model.some(({ op, tx }) => op === "NOTE" && /printf plurnk/u.test(JSON.parse(tx).body)), "a bare executor name is a word: its block stays quoted text, and beside the operations that text is the turn's NOTE ({§outside-text})");
            const sources = await db.test_turn_sources.all<{ kind: string; content: string }>({ session_id: modelSessionId! });
            assert.equal(sources.some((row) => row.kind === "outside"), false, "a turn with fenced operations keeps no outside source");
            assert.match(JSON.stringify(mock.received[1]), /ran, though its fence was malformed: the opening fence, OP, parameters, and aside share one line/, "the next packet states the form once");
            assert.equal(await lastReply(db, loopId), "the answer");
            const shells = await db.test_get_entry_by_pathname_scheme.get({ scheme: "sh", pathname: "/1/1/1/sh" });
            assert.equal(shells, undefined, "no shell spawned");
        } finally { ws.close(); }
    });
});

test("{§op-shapes}: messages that start with operation names remain literal replies", async (approvalContext) => {
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
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.origin === "model" && r.op === "SEND");
            assert.deepEqual(sends.map(({ status_rx }) => status_rx), [200, 200, 200, 200], "message content is never parsed as another operation");
            assert.equal(rows.filter(({ origin }) => origin === "model").length, 4);
        } finally { ws.close(); }
    });
});

test("{§message-completion}: a delivered reply names the open messages it answered", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND [200]\nthe answer\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-receipt" });
            const { finalStatus, loopId, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "answer me" });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const send = rows.find((r) => r.origin === "model" && r.op === "SEND");
            assert.equal(send?.status_rx, 200);
            const receipt = JSON.parse(send.rx) as { answers: string[]; recipients?: unknown };
            assert.ok(Array.isArray(receipt.answers), "a reply names answered message addresses in answers");
            assert.equal(Object.hasOwn(receipt, "recipients"), false, "answered messages are not mislabeled as recipient actors");
            const { answers } = receipt;
            assert.ok(modelSessionId !== undefined);
            const arrivals = rows.filter((r) => r.origin === "_plurnk" && r.op === "SEND");
            assert.equal(arrivals.length, 1, "one message in the loop");
            assert.equal(answers.length, 1, "the receipt names the one open message");
            const source = await db.message_source_by_address.get<{ body: string }>({ workspace_id: (await db.drain_get_session_workspace.get<{ workspace_id: number }>({ session_id: modelSessionId }))!.workspace_id, path: answers[0] });
            assert.equal(source?.body, "answer me", "the receipt names the durable message source");
        } finally { ws.close(); }
    });
});

test("{§log-wire-format} {§tokenomics}: a sent reply renders whole in the next request; delivery and the retained body are unchanged", async (approvalContext) => {
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
            const { finalStatus, loopId, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "Send the report." });
            assert.equal(finalStatus, 200);
            assert.equal(await lastReply(db, loopId), body, "the client receives every line");
            const next = await runLoopToTerminal(ws, 3, { prompt: "Thanks.", sessionId: modelSessionId });
            assert.equal(next.finalStatus, 200);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnIds!.at(-1)! }))!.packet);
            const reply = logEntries(packet).find((row) => Array.isArray(row.answers) && row.logPath.endsWith("/SEND"));
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
});

describe("send-target-recipient", () => {
// {§send} — a SEND addressed to a non-recipient (an immutable turn source,
// a file path) states the address contract without guessing what the model intended.





test("{§operation-results} a SEND addressed to a turn source the model may not write is refused 400 with neutral recipient guidance", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````SEND (reasoning://alice/1/1)\nthe answer\n````", 10),
        makeMockResponse("````SEND [200]\nthe answer\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "answer me" });
            assert.equal(finalStatus, 200, "the target-less reply concluded on the second turn");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const sends = rows.filter((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(sends[0]?.status_rx, 400, "the directed SEND was refused 400, not 403");
            const problem = (JSON.parse(sends[0].rx) as { problem?: Record<string, unknown> }).problem;
            assert.equal(problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/send-target-not-a-recipient");
            assert.equal(problem?.detail, "The addressed scheme is not a SEND recipient."); // {§operation-results}
            assert.equal(problem?.recovery, "Name a message address or a recipient that implements SEND."); // {§operation-results}
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
        makeMockResponse("````SEND (.)\nwaiting\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "send-target-file" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go" });
            assert.equal(finalStatus, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
            const first = rows.find((r) => r.op === "SEND" && r.origin === "model");
            assert.equal(first?.status_rx, 501);
            const problem = (JSON.parse(first.rx) as { problem?: Record<string, unknown> }).problem;
            assert.equal(problem?.detail, "Scheme 'file' does not implement SEND."); // {§operation-results}
            assert.equal(problem?.recovery, undefined);
        } finally { ws.close(); }
    });
});
});

describe("session-message-obligation", () => {
// {§loop-completion} a message a session sent to another session holds the sender: its authored WAIT parks,
// and the recipient's completion, 200 or 499, wakes the same loop. {§loop-completion}: a recipient loop
// that ends without answering is answered 499 by the daemon, and that completion wakes the sender too.
// The ping/pong here is child to parent, a direction no child obligation covers: without the rule the child's
// WAIT would read "nothing in flight", continue, and ask for its next turn before the parent answered.







// A step yields fenced operations, or `{ raw }` for text the engine must parse and judge on its own terms.
type Emission = string | { raw: string };
type Step = (db: Db) => Promise<Emission> | Emission;

// One script per session, routed by the identity block each packet carries ({§child-orientation}), so the
// order in which two sessions ask for their turns never matters. A step may read the database when it runs,
// since the parent answers the child's message by the address the daemon minted for it.
class Scripted extends Mock {
    readonly #scripts: Record<string, Step[]>;
    readonly #db: () => Db;
    constructor(db: () => Db, scripts: Record<string, Step[]>) {
        super({ contextWindow: viableWindow(), responses: [] });
        this.#scripts = Object.fromEntries(Object.entries(scripts).map(([name, steps]) => [name, [...steps]]));
        this.#db = db;
    }
    left(name: string): number { return this.#scripts[name]?.length ?? 0; }
    override get remaining(): number { return Object.values(this.#scripts).reduce((sum, steps) => sum + steps.length, 0); }
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const packet = args[0].messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
        const name = Object.keys(this.#scripts).find((candidate) => candidate !== "root" && packet.includes(`"path":"session://${candidate}","parent":`)) ?? "root";
        const step = this.#scripts[name]?.shift();
        if (step === undefined) throw new Error(`scripted provider: '${name}' asked for a turn its script does not have`);
        const emission = await step(this.#db());
        const response = typeof emission === "string" ? makeMockResponse(emission, 10) : makeRawMockResponse(emission.raw, 10);
        const once = new Mock({ contextWindow: viableWindow(), responses: [response] });
        return once.generate(...args);
    }
}

// The child learns its parent's minted name from its task: the message the parent sent it names its source.
const parentOf = async (db: Db, workspaceId: number, child: string): Promise<string> => {
    const session = await waitForDb(() => db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: child }), (row) => row !== undefined);
    const task = await waitForDb(() => db.test_messages_by_session.all<{ ordinal: number; source: string | null }>({ session_id: session!.id }), (rows) => rows.some((row) => row.ordinal === 1));
    return task.find((row) => row.ordinal === 1)!.source!;
};

const openMessageFrom = async (db: Db, workspaceId: number, sender: string): Promise<string> => {
    const row = await waitForDb(
        () => db.test_open_message_from.get<{ path: string }>({ workspace_id: workspaceId, source: `session://${sender}` }),
        (found) => found !== undefined,
    );
    return row!.path;
};

const sessionIdOf = async (db: Db, workspaceId: number, name: string): Promise<number> =>
    (await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name }))!.id;

const loopsOf = async (db: Db, sessionId: number): Promise<number> =>
    (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: sessionId }))!.n;

const inferenceStatuses = async (db: Db, sessionId: number): Promise<number[]> => {
    const loops = await db.test_list_loops_all.all<{ id: number; session_id: number }>({});
    const loop = loops.find((row) => row.session_id === sessionId)!;
    const turns = await db.test_list_turns_in_loop.all<{ kind: string; status: number }>({ loop_id: loop.id });
    return turns.filter((turn) => turn.kind === "inference").map((turn) => turn.status);
};

for (const [name, completion, answer] of [["answered 200", 200, "the code is 4815"], ["declined 499", 499, "no code for you"]] as const) {
    test(`{§loop-completion} a child's message to its parent holds the child's WAIT, and the parent's completion (${name}) wakes the same loop`, async (approvalContext) => {
        serverProposals(approvalContext, "accept");
        let db!: Db;
        let workspaceId = 0;
        const provider = new Scripted(() => db, {
            root: [
                () => "````WORK (session://kid)\nask me for the code, then report what I said\n````\n\n````WAIT\nawaiting kid\n````",
                async (d) => `\`\`\`\`SEND (${await openMessageFrom(d, workspaceId, "kid")}) [${completion}]\n${answer}\n\`\`\`\`\n\n\`\`\`\`WAIT\nstill awaiting kid\n\`\`\`\``,
                () => "````SEND [200]\nkid is done\n````",
            ],
            kid: [
                async (d) => `\`\`\`\`SEND (${await parentOf(d, workspaceId, "kid")})\nwhat is the code?\n\`\`\`\`\n\n\`\`\`\`WAIT\nawaiting the parent's answer\n\`\`\`\``,
                () => "````SEND [200]\nreported\n````",
            ],
        });
        await withDaemon(provider, async (database, _daemon, addr) => {
            db = database;
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: `message-hold-${completion}` });
                workspaceId = (created.result as { id: number }).id;
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn kid and answer it" });
                assert.equal(finalStatus, 200, "the parent concluded after kid reported");
                assert.equal(provider.remaining, 0, "every scripted turn of both sessions ran");
                const kid = await sessionIdOf(db, workspaceId, "kid");
                assert.equal(await loopsOf(db, kid), 1, "the completion woke kid's parked loop; no fresh loop was minted");
                assert.equal((await inferenceStatuses(db, kid))[0], 202, "kid's WAIT parked on its message to the parent, nothing else being live");
                const completed = await db.test_message_completions_from.all<{ status: number; origin: string }>({ workspace_id: workspaceId, source: "session://kid" });
                assert.deepEqual(completed.map((row) => [row.status, row.origin]), [[completion, "model"]], "the parent's reply completed kid's message as authored");
                const [kidEnded] = await waitFor(
                    () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId === kid),
                    (events) => events.length > 0,
                );
                assert.equal(kidEnded.result.status, 200, "kid concluded 200 after the parent's");
            } finally { ws.close(); }
        });
    });
}

test("{§loop-completion} a parent that strikes out with the child's message unanswered: the daemon completes it 499 and the child wakes", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    let db!: Db;
    let workspaceId = 0;
    // A turn ceiling would end the child too ({§operator-config-workspace-settings}); strikes are the parent's alone. The
    // parent wakes on the question and answers with prose carrying no operation, turn after turn, until its
    // strike threshold ends its loop with the question unanswered.
    const provider = new Scripted(() => db, {
        root: [
            () => "````WORK (session://kid)\nask me for the code, then report what happened\n````\n\n````WAIT\nawaiting kid\n````",
            ...Array.from({ length: 16 }, () => () => ({ raw: "I am thinking about the code and will answer soon." })),
        ],
        kid: [
            async (d) => `\`\`\`\`SEND (${await parentOf(d, workspaceId, "kid")})\nwhat is the code?\n\`\`\`\`\n\n\`\`\`\`WAIT\nawaiting the parent's answer\n\`\`\`\``,
            () => "````SEND [200]\nthe parent went away without answering\n````",
        ],
    });
    await withDaemon(provider, async (database, _daemon, addr) => {
        db = database;
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "message-abandoned" });
            workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn kid and stall" });
            assert.ok(finalStatus >= 400 && finalStatus !== 499, `the parent's loop ended by its own strikes, not a cancellation; got ${finalStatus}`);
            const completed = await waitForDb(
                () => db.test_message_completions_from.all<{ status: number; origin: string }>({ workspace_id: workspaceId, source: "session://kid" }),
                (rows) => rows.length > 0,
            );
            assert.deepEqual(completed.map((row) => [row.status, row.origin]), [[499, "_plurnk"]], `the daemon completed kid's message 499 by its own hand; saw ${JSON.stringify(completed)} after the parent ended ${finalStatus}`);
            const kid = await sessionIdOf(db, workspaceId, "kid");
            const kidDone = await waitForDb(
                () => db.test_list_loops_all.all<{ status: number; session_id: number }>({}),
                (loops) => loops.some((loop) => loop.session_id === kid && loop.status === 200),
            );
            assert.ok(kidDone.length > 0);
            assert.equal(provider.left("kid"), 0, "kid woke on the 499 and reported");
            assert.equal(await loopsOf(db, kid), 1, "the same parked loop woke; none was minted");
            assert.equal((await inferenceStatuses(db, kid))[0], 202, "kid's WAIT had parked on its message");
            const [kidEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId === kid),
                (events) => events.length > 0,
            );
            assert.equal(kidEnded.result.status, 200, "kid concluded 200");
        } finally { ws.close(); }
    });
});
});

describe("session-obligations", () => {
// {§loop-completion} — what a session still holds is one durable row: an open stream that is not
// detached, or a child with an unresolved loop. The completion gate, the wait matrix, and the drain
// read the same view; a detached spawn is nobody's obligation from the row, not from process memory.



test("{§loop-completion}: open non-detached streams and live children are obligations; detached streams and settled children are not", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `obligations-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "parent");
        const held = async (): Promise<{ streams: number; sessions: number }> =>
            (await db.session_live_obligations.get<{ streams: number; sessions: number }>({ session_id: sessionId }))!;
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a fresh session holds nothing");

        const first = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/1/sh", channel: "stdout", content: "", state: "active" });
        const detached = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: first, detached: 1 });
        assert.ok(detached);
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a detached stream outlives the loop and is nobody's obligation");
        const second = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/2/sh", channel: "stdout", content: "", state: "active" });
        const attached = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: second, detached: 0 });
        assert.ok(attached);
        assert.deepEqual(await held(), { streams: 1, sessions: 0 }, "an open attached stream is an obligation");
        await db.test_close_subscription.run({ id: attached.id });
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a settled stream is not");

        const childId = await insertSession(db, workspaceId, sessionId, "child");
        const childLoop = await insertLoop(db, childId, 1, "work");
        assert.deepEqual(await held(), { streams: 0, sessions: 1 }, "a child with an unresolved loop is an obligation");
        await db.test_set_loop_status.run({ id: childLoop, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a concluded child is not");
    } finally { await db.close(); }
});
});

describe("session-overview", () => {
const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const said = (...statements: string[]): MockResponse => ({ assistant: { content: statements.join("\n\n"), reasoning: null } });

// {§message-completion}: the matrix of replies that finish and replies that do not, across one session's loops, its
// child, its fork, a bookkeeping session and a same-named session in another workspace.
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
    await run(alice, await ask(1), said(frame("SEND", "Still working on it.")));
    assert.equal(await replyOf(alice), null, "a progress reply finishes nothing");
    const first = await ask(2);
    await run(alice, first, said(frame("SEND [200]", "First answer, in full.\nWith detail.")));
    const answered = await replyOf(alice);
    assert.deepEqual([answered?.completion, answered?.excerpt, answered?.continued, answered?.coordinate.split("/")[0]], [200, "First answer", true, "2"],
        "a completion reply finishes, its excerpt cut to the setting");
    assert.ok(typeof answered?.at === "number" && answered.at > 0, "its stamp is Unix milliseconds");
    await run(alice, await ask(3), said(frame("SEND [499]", "Stopped: the input is missing.")));
    const cancelled = await replyOf(alice);
    assert.deepEqual([cancelled?.completion, cancelled?.excerpt], [499, "Stopped: the"], "a cancelling reply finishes too");
    assert.ok((cancelled?.id ?? 0) > (answered?.id ?? 0));
    await run(alice, await ask(4), said(frame("SEND [200]"), frame("SEND [200]", "Speech after the completion.")));
    const empty = await replyOf(alice);
    assert.deepEqual([empty?.completion, empty?.excerpt, empty?.continued], [200, "", false],
        "an empty completion is the latest finished reply, and speech that completed nothing never replaces it");
    await run(alice, await ask(5), said(frame("SEND (acp://operator/threads/alice/messages/missing) [200]", "Lost.")));
    assert.equal((await replyOf(alice))?.id, empty?.id, "a failed delivery finishes nothing");
    // {§loop-completion}: a message another session sent, left open by a loop that ended.
    const abandoned = await ask(6, "session://boss");
    assert.equal(await MessageAbandonment.complete(engine, db, workspaceId, alice, abandoned, 499), 1, "the daemon answers the abandoned message");
    const after = await placeOf(alice);
    assert.equal(after?.reply?.id, empty?.id, "the daemon's own 499 is not the model's reply");
    assert.notEqual(after?.lifecycle, "completed", "the lifecycle is the newest loop's, whatever the latest reply");

    const scout = await insertSession(db, workspaceId, alice, "scout");
    await run(scout, await insertLoop(db, scout, 1, "Scout the field."), said(frame("SEND [200]", "Scouted.")));
    assert.deepEqual([(await replyOf(scout))?.excerpt, (await replyOf(alice))?.id], ["Scouted.", empty?.id], "a child's reply is the child's");
    await run(alice, await ask(7), said(frame("FORK (session://twin)", "Carry on from here.")));
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
    // {§acp-status-descendants} The gates a place waits on, as the status tree counts them: such a place is held past the bound.
    const twinId = twin?.id ?? 0;
    const gated = await SessionOverview.read(db, { workspaceId, limit: 1, excerptChars: 12, projectLabel: () => null,
        pending: async () => [{ sessionId: twinId }, { sessionId: twinId }] });
    assert.deepEqual([gated.sessions.map(({ id, gates }) => [id, gates]), gated.omitted], [[[scout, 0], [twinId, 2]], 1],
        "the first in order, and every place waiting on a gate, with its gates");
});
});

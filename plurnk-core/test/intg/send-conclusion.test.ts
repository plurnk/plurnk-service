import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import { type Notice } from "@plurnk/plurnk-contracts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { holdChild, insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, sendingOperation, seedEnvelope } from "./_db.ts";
import { packetSection, lastReply, logEntries } from "./_packet.ts";
import { statement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { completeStmt, noteStmt, sendStmt, urlPath } from "./_dsl.ts";

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
            const repliedTo: string[] = JSON.parse(firstSend.rx).repliedTo;
            assert.equal(repliedTo.length, 1, "the SEND answers the original message");

            const concluded = await turn();
            assert.equal(concluded.status, 200);
            const result = await answer();
            assert.ok("content" in result);
            assert.equal(result.status, 200);
            assert.equal(result.content, final.trim() ? final : "Four.");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: concluded.turnId });
            assert.deepEqual(JSON.parse(rows.find(({ op }) => op === "SEND")!.rx).repliedTo, repliedTo, "completion addresses the original message even without speech");
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
            const expected = await db.message_source_by_address.get<{ key_path: string }>({ workspace_id: ids.workspaceId, path: addressed });
            assert.deepEqual(replies[0].repliedTo, [expected!.key_path]);
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

describe("message-completion", () => {
const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `message-completion-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const ids = { workspaceId, sessionId, loopId };
    const keys = new Map<string, string>();
    const message = (name: string) => keys.get(name)!;
    const add = async (name: string) => {
        const address = `message://alice/${name}`;
        await engine.injectIntoLoop(loopId, `Request ${name}.`, [], undefined, {}, address);
        const row = await db.message_source_by_address.get<{ key_path: string }>({ workspace_id: workspaceId, path: address });
        keys.set(name, row!.key_path);
    };
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
        const reply = receipts.find(({ repliedTo }) => Array.isArray(repliedTo) && repliedTo.includes(f.message("first")));
        assert.ok(reply, "the delivered reply is present in the next packet");
        assert.equal(Object.hasOwn(reply, "status"), false, "delivery success cannot masquerade as message completion");
        assert.equal(Object.hasOwn(reply, "metadata"), false, "the paired operation supplies authored metadata");
        assert.equal(reply.body, undefined, "the answer appears once, in the complete operation");
        assert.equal(packetSection(packet, "emission-history"), frame(code === null ? "SEND" : `SEND [${code}]`, body));
        const arrivals = receipts.filter(({ origin }) => origin === "user");
        assert.equal(arrivals.length, 2);
        for (const arrival of arrivals) assert.equal(Object.hasOwn(arrival, "status"), false);
        const open = JSON.parse(packetSection(packet, "work")).messages as Array<{ path: string }>;
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
            assert.deepEqual(JSON.parse(reply!.rx).repliedTo, [f.message("first")]);
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
    assert.deepEqual(rows.filter(({ op, origin }) => op === "SEND" && origin === "model").map(({ rx }) => JSON.parse(rx).repliedTo),
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


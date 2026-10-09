import assert from "node:assert/strict";
import test from "node:test";
import type { Notice } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { holdChild, insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { packetSection } from "./_packet.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { statement } from "./reasoning-fixture.ts";

const said = (content: string, reasoning: string | null = null): MockResponse => ({ assistant: { content, reasoning } });
const message = "message://alice/assignment";
const send = (content = "") => PlurnkParser.frame("SEND", content);
const conclude = (content = "") => PlurnkParser.frame("SEND [200]", content);
const correct = (content: string) => PlurnkParser.frame(`SEND (${message}) [200]`, content);

const setup = async (responses: MockResponse[]) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `send-conclusion-${crypto.randomUUID()}`);
    const parentId = await insertWorker(db, workspaceId, null, "lead");
    const workerId = await insertWorker(db, workspaceId, parentId, "alice");
    const loopId = await insertLoop(db, workerId, 1);
    const notices: Notice[] = [];
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
        noticeNotify: (_id, payload) => notices.push(payload.notice as Notice),
    });
    await engine.injectIntoLoop(loopId, "What is two plus two?", [], "worker://lead", {}, message);
    const provider = new Mock({ contextWindow: 100_000, responses });
    const ids = { workspaceId, workerId, loopId };
    return {
        db, engine, provider, ids, parentId, notices,
        turn: () => engine.runTurn({ provider, ...ids, messages: [] }),
        answer: () => engine.look({ ...ids, statement: statement("````READ (ops://alice/1)````") }),
    };
};

for (const final of ["Four, precisely.", "", " \n\t"]) {
    test(`{§send-response-receipt}: a ${final ? "corrected" : "empty-body"} final reply retains the child's answer for its parent`, async () => {
        const { db, engine, turn, answer, ids, parentId } = await setup([said(send("Four.")), said(conclude(final))]);
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
                workspace_id: ids.workspaceId, worker_id: ids.workerId, loop_id: ids.loopId,
            });
            assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["Four.", ...(final.trim() ? [final] : [])], "an empty completion is evidence, not another spoken message");

            const loopId = await insertLoop(db, parentId, 1, "Observe the result.");
            await engine.runTurn({ workspaceId: ids.workspaceId, workerId: parentId, loopId, messages: [],
                provider: new Mock({ contextWindow: 100_000, responses: [said(PlurnkParser.frame("NOTE", "Observed."))] }),
            });
            const parentRows = await db.engine_render_log.all<{ source: string; op: string; rx: string }>({ worker_id: parentId });
            const childRows = parentRows.filter(({ source }) => source === "worker://alice");
            assert.deepEqual(childRows.map(({ op }) => op), ["READ"], "the parent receives one conclusion, not a duplicate child message or activity");
            assert.equal(JSON.parse(childRows[0]!.rx).content, final.trim() ? final : "Four.", "the parent's actual conclusion READ contains the child's final answer");
        } finally { await db.close(); }
    });
}

test("{§message-completion} {§loop-answer}: an empty completion succeeds without a fabricated answer", async () => {
    const { db, engine, turn, answer, ids, parentId } = await setup([said(conclude())]);
    try {
        assert.equal((await turn()).status, 200);
        const outcome = await answer();
        assert.equal(outcome.status, 200, "the loop resource retains the successful empty outcome");
        assert.ok("content" in outcome);
        assert.equal(outcome.content, "", "READ represents successful silence as an empty body");
        const events = await db.test_loop_termination_events.all<{ rx: string }>({ recipient_worker_id: parentId });
        assert.deepEqual(events.map(({ rx }) => JSON.parse(rx)), [{ status: 200 }]);
        const loopId = await insertLoop(db, parentId, 1, "Observe the result.");
        await engine.runTurn({ workspaceId: ids.workspaceId, workerId: parentId, loopId, messages: [],
            provider: new Mock({ contextWindow: 100_000, responses: [said(PlurnkParser.frame("NOTE", "Observed."))] }),
        });
        const rows = await db.engine_render_log.all<{ source: string; op: string; rx: string }>({ worker_id: parentId });
        const conclusions = rows.filter(({ source }) => source === "worker://alice");
        assert.equal(conclusions.length, 1, "the parent receives one ordinary completion observation");
        assert.equal(conclusions[0]!.op, "READ");
        const result = JSON.parse(conclusions[0]!.rx);
        assert.equal(result.status, 200, "silence does not become a child failure");
        assert.ok(result.content === undefined || result.content === "", "no answer text is invented");
        assert.equal(result.problem, undefined);
    } finally { await db.close(); }
});

test("{§send-response-receipt}: FIFO targeting cannot acknowledge an unpublished arrival", async (t) => {
    const { db, engine, provider, turn, answer, ids } = await setup([
        said("Provisional answer."), said(conclude("Four, precisely.")), said(conclude("The follow-up is answered too.")),
    ]);
    const generate = provider.generate.bind(provider);
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (provider.received.length === 1) await engine.injectIntoLoop(ids.loopId, "Also answer this follow-up.", [], "worker://lead");
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
            test(`{§wait-obligation-matrix}: an earlier reply does not park ordinary work before ${park} with a live ${obligation}`, async () => {
                const first = `${send("Working on it.")}\n\n${PlurnkParser.frame("NOTE", "Continue the work.")}`;
                const { db, turn, ids } = await setup([
                    said(first),
                    said(PlurnkParser.frame("NOTE", "Check the saved input.")),
                    said(PlurnkParser.frame("READ (worker:///input.txt)", null)),
                    said(PlurnkParser.frame(park, null)),
                ]);
                try {
                    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "worker", pathname: "/input.txt",
                        channel: "body", content: "input-witness", mimetype: "text/plain", state: "static" });
                    assert.equal((await turn()).status, 102);
                    assert.equal((await db.message_unanswered_count.get({ loop_id: ids.loopId }))?.count, 1);
                    if (obligation === "child") await holdChild(db, ids.workspaceId, ids.workerId);
                    else {
                        const entryId = await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "node", pathname: "/12345678",
                            channel: "stdout", content: "Ready for input.", mimetype: "text/plain", state: "active" });
                        await ChannelWrite.openSubscription(db, { workerId: ids.workerId, entryId, scheme: "node", handle: "/12345678", publishedChannel: "stdout" });
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
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: ids.workerId });
            assert.equal(sources.find((row) => row.turn_id === token.turnId && row.kind === "outside")?.content, response, "the text is the turn's outside source, not confirmation of completion");
            assert.equal((await turn()).status, 200);
            const result = await answer();
            assert.ok("content" in result);
            assert.equal(result.content, "Four, precisely.");
        } finally { await db.close(); }
    });
}

test("{§outside-text}: outside fragments are one source in order, never a row, and siblings run without a strike", async () => {
    const source = `Before.\n\n${PlurnkParser.frame("NOTE", "remember")}\n\nBetween.\n\n${send("Four.")}\n\nAfter.`;
    const { db, engine, provider, ids, notices } = await setup([said(source), said(conclude())]);
    try {
        const result = await engine.runLoop({ ...ids, provider, maxTurns: 4, maxStrikes: 1, messages: [] });
        assert.equal(result.result.status, 200, "commentary does not strike even at a one-strike threshold");
        assert.equal(provider.received.length, 2);
        const turnId = result.turnIds.at(-2)!;
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string; rx: string }>({ turn_id: turnId });
        const operations = rows.filter(({ origin, op }) => origin === "model" && ["SEND", "NOTE"].includes(op));
        assert.deepEqual(operations.map(({ op, tx }) => [op, op === "SEND" ? JSON.parse(tx).body.raw : JSON.parse(tx).body]),
            [["NOTE", "remember"], ["SEND", "Four."]], "only the authored operations are rows");
        assert.equal(rows.some(({ op }) => op === "error"), false, "stray text is not a failed operation");
        const text = "Before.\n\nBetween.\n\nAfter.";
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: ids.workerId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "outside")?.content, text, "every outside span in source order, joined by a blank line");
        assert.deepEqual(notices.filter(({ level }) => level === "warn" || level === "error").map(({ kind, message }) => [kind, message]),
            [["outside_text", `${contentWeight(text)} tokens emitted outside OPs. Discarded.`]], "the one complaint is the weight of what was discarded");
    } finally { await db.close(); }
});

test("{§outside-text}: a mixed turn stores its text as the turn's outside source, and the next packet's Notices carry its weight", async () => {
    const prose = ["Let me check the input first.", "That settles it."];
    const source = `${prose[0]}\n\n${PlurnkParser.frame("READ (worker:///input.txt)", null)}\n\n${prose[1]}`;
    const { db, turn, ids, notices } = await setup([said(source), said(conclude())]);
    try {
        await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "worker", pathname: "/input.txt",
            channel: "body", content: "input-witness", mimetype: "text/plain", state: "static" });
        const mixed = await turn();
        assert.equal(mixed.status, 102);
        assert.equal(mixed.emptyTurn, false, "the READ is an authored operation");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: mixed.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["READ"], "no NOTE row is minted for the text");
        const text = prose.join("\n\n");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string; model_call_id: number | null }>({ worker_id: ids.workerId });
        const outside = sources.find((row) => row.turn_id === mixed.turnId && row.kind === "outside");
        assert.equal(outside?.content, text, "every outside span, in source order, joined by a blank line");
        assert.equal(typeof outside?.model_call_id, "number", "the source cites the admitted call");
        const line = `${contentWeight(text)} tokens emitted outside OPs. Discarded.`;
        assert.deepEqual(notices.filter(({ kind }) => kind === "outside_text").map(({ source: from, level, message }) => [from, level, message]),
            [["engine:turn", "warn", line]]);
        const next = await turn();
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        assert.ok(packetSection(packet, "notices").split("\n").includes(`* outside_text: ${line}`), "the next packet's Notices section carries the exact line");
        assert.doesNotMatch(packetSection(packet, "log"), /Let me check the input first\./u, "the text itself never enters a packet");
    } finally { await db.close(); }
});

// The recorded shape (#853, run286 pytest-5103): a length-cut response repeating `Proceeding.` beside a
// fence minted 2,858 NOTE rows in one turn, one per fragment.
test("{§outside-text}: a repetitive response stores its outside text as one source, however many fragments, and mints no NOTE", async () => {
    const fragments = Array.from({ length: 400 }, () => `Proceeding.\n\n${PlurnkParser.frame("NOTE", "waiting")}`).join("\n\n");
    const { db, engine, provider, ids } = await setup([said(`${fragments}\n\n${send("Four.")}\n\nProceeding`), said(conclude())]);
    try {
        const result = await engine.runLoop({ ...ids, provider, maxTurns: 4, maxStrikes: 1, messages: [] });
        const turnId = result.turnIds.at(-2)!;
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string }>({ turn_id: turnId });
        assert.equal(rows.filter(({ origin, op, tx }) => origin === "model" && op === "NOTE" && JSON.parse(tx).body !== "waiting").length, 0, "no NOTE carries outside text");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: ids.workerId });
        assert.deepEqual(sources.filter((row) => row.turn_id === turnId && row.kind === "outside").map(({ content }) => content),
            [[...Array.from({ length: 400 }, () => "Proceeding."), "Proceeding"].join("\n\n")], "one outside source holds every fragment");
    } finally { await db.close(); }
});

test("{§empty-turn}: operations beside stray text reset the no-operation strike streak", async () => {
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

for (const [label, response, reasoning, notes, outside] of [
    ["prose", "Four.", null, [], "Four."],
    ["prose with reasoning", "Four.", "I should verify the arithmetic.", [], "Four."],
    ["empty response", "", null, [], undefined],
] as const) {
    test(`{§empty-turn} {§reasoning-row}: ${label} preserves sources and strikes; an optional preview is not authored work`, async () => {
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
            const reads = await db.test_reasoning_reads.all<{ origin: string; pathname: string; turn_id: number; rx: string }>({ worker_id: ids.workerId });
            assert.deepEqual(reads.filter(({ origin, pathname }) => origin === "_plurnk" && pathname === `/1/${sequence}`)
                .map(({ turn_id, rx }) => [turn_id, JSON.parse(rx).content]), reasoning === null ? [] : [[modelTurn, reasoning]],
                "the optional preview belongs to this turn and does not prevent its no-operation strike");
            assert.equal(provider.received.length, 1, "the preview causes no extra inference");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; source: string; origin: string; tx: string; status_rx: number }>({ turn_id: modelTurn });
            assert.equal(rows.some(({ op, source }) => op === "error" && source === "grammar"), false);
            assert.deepEqual(rows.filter(({ op, origin }) => op === "error" && origin === "_plurnk").map(({ status_rx }) => status_rx), [422], "the strike is one error row on the turn");
            assert.deepEqual(rows.filter(({ op, origin }) => op === "NOTE" && origin === "model").map(({ tx }) => JSON.parse(tx).body), [...notes],
                "a reasoning NOTE beside an empty program is a row of its own; outside text is none");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: ids.workerId });
            assert.equal(sources.find((row) => row.turn_id === modelTurn && row.kind === "outside")?.content, outside, "a prose-only turn still records its outside source ({§outside-text})");
            assert.equal(sources.find((row) => row.turn_id === modelTurn && row.kind === "reasoning")?.content, reasoning ?? undefined,
                "the reasoning source is retained independently of its preview");
        } finally { await db.close(); }
    });
}

for (const [failure, operation, failedOp] of [
    ["parser", "````EDIT (worker:///broken.md) <bad>\nnot a message\n````", "error"],
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
    test(`{§wait-obligation-matrix}: stray text beside ${op} is stored outside the turn, and ${op === "WAIT" ? "the explicit park holds" : "work continues before automatic parking"}`, async () => {
        const { db, turn, ids, notices } = await setup([said(`Working.\n\n${PlurnkParser.frame(op, "Await the child.")}`)]);
        try {
            await holdChild(db, ids.workspaceId, ids.workerId);
            const result = await turn();
            assert.equal(result.status, op === "WAIT" ? 202 : 102);
            const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; status_rx: number }>({ turn_id: result.turnId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]),
                [[op, op === "WAIT" ? 202 : 200]], "the stray text is no row, and never delivered ({§outside-text})");
            assert.deepEqual(notices.filter(({ level, kind }) => (level === "warn" || level === "error") && kind !== "outside_text"), []);
        } finally { await db.close(); }
    });
}

test("{§send-response-receipt}: SEND bodies that resemble operations remain literal messages", async () => {
    const body = "KILL (worker:///important.md)\nThis is an example, not an operation.";
    const { db, turn, answer } = await setup([said(send(body))]);
    try {
        assert.equal((await turn()).status, 102);
        const result = await answer();
        assert.ok("content" in result);
        assert.equal(result.content, body);
    } finally { await db.close(); }
});

test("{§empty-turn}: bounded malformed operations consume one turn and expose their diagnostics without resampling", async () => {
    const source = "````EDIT (worker:///broken.md) <bad>\nnot a message\n````";
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
            "{§empty-turn} the strike is silent: the next packet carries the turn, not a complaint about it");
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

test("{§empty-turn} {§reasoning-operations}: a reasoning NOTE is the turn's work; a response with no content program is not empty", async () => {
    const { db, turn, provider } = await setup([said("", PlurnkParser.frame("NOTE", "Still calculating.")), said(conclude("Four."))]);
    try {
        const noted = await turn();
        assert.equal(noted.status, 102);
        assert.equal(noted.emptyTurn, false, "an admitted reasoning NOTE is an authored operation, exactly as a content NOTE");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: noted.turnId });
        assert.deepEqual(rows.map(({ origin, op }) => `${origin}:${op}`).filter((row) => row !== "_plurnk:SEND"),
            ["_plurnk:READ", "model:NOTE"], "the optional reasoning preview and authored NOTE, with no strike row");
        assert.equal((await turn()).status, 200);
        assert.doesNotMatch(JSON.stringify(provider.received[1]), /No valid Operation Syntax OPs detected\./,
            "the next packet carries the turn, not a complaint about it");
    } finally { await db.close(); }
});

test("{§empty-turn}: a reasoning NOTE is work, not a request to wait, after the messages are answered", async () => {
    const { db, turn, ids } = await setup([said("Four."), said("", PlurnkParser.frame("NOTE", "Still checking."))]);
    try {
        assert.equal((await turn()).status, 102);
        await holdChild(db, ids.workspaceId, ids.workerId);
        const empty = await turn();
        assert.equal(empty.emptyTurn, false, "the reasoning NOTE is an authored operation");
        assert.equal(empty.status, 102, "a NOTE is never a request to wait; only WAIT parks on the child");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: empty.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["NOTE"]);
    } finally { await db.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { statement } from "./reasoning-fixture.ts";

const said = (content: string, reasoning: string | null = null): MockResponse => ({ assistant: { content, reasoning } });
const send = (content = "") => PlurnkParser.frame("SEND", content);

const setup = async (responses: MockResponse[]) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `send-conclusion-${crypto.randomUUID()}`);
    const parentId = await insertWorker(db, workspaceId, null, "lead");
    const workerId = await insertWorker(db, workspaceId, parentId, "alice");
    const loopId = await insertLoop(db, workerId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await engine.injectIntoLoop(loopId, "What is two plus two?", [], "worker://lead");
    const provider = new Mock({ contextWindow: 100_000, responses });
    const ids = { workspaceId, workerId, loopId };
    return {
        db, engine, provider, ids, parentId,
        turn: () => engine.runTurn({ provider, ...ids, messages: [] }),
        answer: () => engine.look({ ...ids, statement: statement("````READ (ops://alice/1)````") }),
    };
};

for (const final of ["Four, precisely.", ""]) {
    test(`{§send-response-receipt}: a ${final ? "corrected" : "silent"} final SEND retains the child's answer for its parent`, async () => {
        const { db, engine, turn, answer, ids, parentId } = await setup([said("Four."), said(send(final))]);
        try {
            const recovered = await turn();
            assert.equal(recovered.status, 102, "recovered text cannot conclude");
            assert.equal(recovered.emptyTurn, true, "recovery does not invent an authored operation");
            const firstRows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string; rx: string }>({ turn_id: recovered.turnId });
            const firstSend = firstRows.find(({ op, origin }) => op === "SEND" && origin === "model");
            assert.ok(firstSend, "the text is delivered through an ordinary SEND");
            assert.equal(JSON.parse(firstSend.tx).body.raw, "Four.");
            const answers: string[] = JSON.parse(firstSend.rx).answers;
            assert.equal(answers.length, 1, "the recovered answer answers the original message");

            const concluded = await turn();
            assert.equal(concluded.status, 200);
            const result = await answer();
            assert.equal(result.status, 200);
            assert.ok("content" in result);
            assert.equal(result.content, final || "Four.");
            const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: concluded.turnId });
            assert.deepEqual(JSON.parse(rows.find(({ op }) => op === "SEND")!.rx).answers, final ? answers : undefined, "an empty SEND has no reply receipt");
            const history = await db.message_history.all<{ direction: string; body: string }>({
                workspace_id: ids.workspaceId, worker_id: ids.workerId, loop_id: ids.loopId,
            });
            assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), final ? ["Four.", final] : ["Four."], "completion without delivery does not add an empty history message");

            const loopId = await insertLoop(db, parentId, 1, "Observe the result.");
            await engine.runTurn({ workspaceId: ids.workspaceId, workerId: parentId, loopId, messages: [],
                provider: new Mock({ contextWindow: 100_000, responses: [said(PlurnkParser.frame("NOTE", "Observed."))] }),
            });
            const parentRows = await db.engine_render_log.all<{ source: string; op: string; rx: string }>({ worker_id: parentId });
            const childRows = parentRows.filter(({ source }) => source === "worker://alice");
            assert.deepEqual(childRows.map(({ op }) => op), ["READ"], "the parent receives one conclusion, not a duplicate child message or activity");
            assert.equal(JSON.parse(childRows[0]!.rx).content, final || "Four.", "the parent's actual conclusion READ contains the child's final answer");
        } finally { await db.close(); }
    });
}

test("{§send-response-receipt}: original-message fallback cannot acknowledge an unpublished arrival", async (t) => {
    const { db, engine, provider, turn, answer, ids } = await setup([
        said("Provisional answer."), said(send("Four, precisely.")), said(send("The follow-up is answered too.")),
    ]);
    const generate = provider.generate.bind(provider);
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (provider.received.length === 1) await engine.injectIntoLoop(ids.loopId, "Also answer this follow-up.", [], "worker://lead");
        return generate(...args);
    });
    try {
        assert.equal((await turn()).status, 102);
        const correction = await turn();
        assert.equal(correction.status, 102, "the unpublished arrival blocks completion despite a valid final SEND");
        const correctedAnswer = await answer();
        assert.ok("content" in correctedAnswer);
        assert.equal(correctedAnswer.content, "Four, precisely.", "the fallback still answers the original message");
        assert.equal((await turn()).status, 200);
        assert.match(JSON.stringify(provider.received[2]), /Also answer this follow-up\./);
        const finalAnswer = await answer();
        assert.ok("content" in finalAnswer);
        assert.equal(finalAnswer.content, "Four, precisely.", "answering a follow-up does not replace the original task's corrected result");
    } finally { await db.close(); }
});

for (const [label, response, reasoning, expected] of [
    ["only SEND", send("Four."), null, 200],
    ["SEND with a reasoning NOTE", send("Four."), PlurnkParser.frame("NOTE", "Arithmetic checked."), 200],
    ["SEND with a response NOTE", `${send("Four.")}\n\n${PlurnkParser.frame("NOTE", "Arithmetic checked.")}`, null, 102],
    ["two SENDs", `${send("Four.")}\n\n${send("Precisely four.")}`, null, 102],
    ["text before SEND", `Preface.\n\n${send("Four.")}`, null, 102],
    ["text after SEND", `${send("Four.")}\n\nPostscript.`, null, 102],
    ["NOTE only", PlurnkParser.frame("NOTE", "Still thinking."), null, 102],
] as const) {
    test(`{§send-conclusion}: ${label}`, async () => {
        const { db, turn } = await setup([said(response, reasoning)]);
        try { assert.equal((await turn()).status, expected); }
        finally { await db.close(); }
    });
}

test("{§send-conclusion}: a NOTE after the messages were answered does not silently conclude", async () => {
    const { db, turn } = await setup([said("Four."), said(PlurnkParser.frame("NOTE", "Arithmetic checked.")), said(send())]);
    try {
        assert.equal((await turn()).status, 102);
        assert.equal((await turn()).status, 102);
        assert.equal((await turn()).status, 200);
    } finally { await db.close(); }
});

for (const response of ["200", "````markdown\nFour.\n````", "````md\nFour.\n````"]) {
    test(`{§send-conclusion}: ${JSON.stringify(response)} cannot confirm a previous free response`, async () => {
        const { db, turn, answer } = await setup([said("Four."), said(response), said(send("Four, precisely."))]);
        try {
            assert.equal((await turn()).status, 102);
            const recovered = await turn();
            assert.equal(recovered.status, 102, "neither a numeric token nor a Markdown envelope requests completion");
            assert.equal(recovered.emptyTurn, true);
            const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string }>({ turn_id: recovered.turnId });
            assert.equal(JSON.parse(rows.find(({ op, origin }) => op === "SEND" && origin === "model")!.tx).body.raw, response, "outside text is literal, never unwrapped or substituted");
            assert.equal((await turn()).status, 200);
            const result = await answer();
            assert.ok("content" in result);
            assert.equal(result.content, "Four, precisely.");
        } finally { await db.close(); }
    });
}

test("{§response-text-recovery}: outside fragments and valid siblings execute in order; the turn earns one strike", async () => {
    const source = `Before.\n\n${PlurnkParser.frame("NOTE", "remember")}\n\nBetween.\n\n${send("Four.")}\n\nAfter.`;
    const { db, engine, provider, ids } = await setup([said(source), said(send())]);
    try {
        const result = await engine.runLoop({ ...ids, provider, maxTurns: 4, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 200, "multiple fragments earn one strike, so the next turn can recover");
        assert.equal(provider.received.length, 2);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string; rx: string }>({ turn_id: result.turnIds.at(-2)! });
        const operations = rows.filter(({ origin, op }) => origin === "model" && ["SEND", "NOTE"].includes(op));
        assert.deepEqual(operations.map(({ op }) => op), ["SEND", "NOTE", "SEND", "SEND", "SEND"]);
        assert.deepEqual(operations.filter(({ op }) => op === "SEND").map(({ tx }) => JSON.parse(tx).body.raw), ["Before.\n\n", "\n\nBetween.\n\n", "Four.", "\n\nAfter."]);
        const problems = rows.map(({ rx }) => JSON.parse(rx)).filter(({ problem }) => problem?.detail === "Only valid Operation Syntax OPs allowed. No free response.");
        assert.equal(problems.length, 1);
    } finally { await db.close(); }
});

test("{§send-conclusion}: SEND bodies that resemble operations remain literal messages", async () => {
    const body = "KILL (worker:///important.md)\nThis is an example, not an operation.";
    const { db, turn, answer } = await setup([said(send(body))]);
    try {
        assert.equal((await turn()).status, 200);
        const result = await answer();
        assert.ok("content" in result);
        assert.equal(result.content, body);
    } finally { await db.close(); }
});

test("{§empty-turn}: bounded malformed operations consume one turn and expose their diagnostics without resampling", async () => {
    const source = "````EDIT (worker:///broken.md) <bad>\nnot a message\n````";
    const { db, turn, provider } = await setup([said(source), said(send("Recovered."))]);
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
        assert.match(JSON.stringify(provider.received[1]), /No valid Operation Syntax OPs detected\./);
    } finally { await db.close(); }
});

test("{§send-conclusion}: a provider output cutoff cannot certify a final response", async () => {
    const cut = { assistant: { content: send("Partial answer."), reasoning: null, finishReason: "length" as const } };
    const { db, turn } = await setup([cut, said(send("Complete answer."))]);
    try {
        assert.equal((await turn()).status, 102);
        assert.equal((await turn()).status, 200);
    } finally { await db.close(); }
});

test("{§empty-turn}: reasoning NOTEs do not rescue a response with no authored operations", async () => {
    const { db, turn, provider } = await setup([said("", PlurnkParser.frame("NOTE", "Still calculating.")), said(send("Four."))]);
    try {
        const empty = await turn();
        assert.equal(empty.status, 102);
        assert.equal(empty.emptyTurn, true);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string }>({ turn_id: empty.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["NOTE"]);
        assert.equal((await turn()).status, 200);
        assert.match(JSON.stringify(provider.received[1]), /No valid Operation Syntax OPs detected\./);
    } finally { await db.close(); }
});

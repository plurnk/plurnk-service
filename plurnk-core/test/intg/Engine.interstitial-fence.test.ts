import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { Mock, type ProviderAccounting, type ProviderRequestAccounting, type MockResponse } from "@plurnk/plurnk-providers";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, holdChild } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type Db } from "../../src/core/Db.ts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { testDeferredProviderCapacity } from "./_provider.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { statement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { testExecutors, quiesceExecs } from "./_execs.ts";
import { serverProposals } from "./_approval.ts";

describe("Engine.interstitial-fence", () => {
const memory = "await plurnk.note({\"text\":\"Examples reviewed.\"});";

const engineRun = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, sessionId: number, loopId: number, content: string, prompt: string) =>
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }),
        workspaceId, sessionId, loopId, maxTurns: 3, maxStrikes: 3, messages: [{ role: "user", content: prompt }],
    });

test("{§fence-pairing}: a SEND quoting an operation never runs the quoted call, and surrounding prose becomes NOTE rows", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interstitial-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Show the examples.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/quoted.md", content: "Keep this one too." });
        const source = [
            "A SEND quotes an operation in its text:",
            "await plurnk.send({\"text\":\"await plurnk.kill({\\\"path\\\":\\\"workspace:///quoted.md\\\"});\"});",
            memory,
        ].join("\n\n");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: source, reasoning: null } },
                { assistant: { content: "await plurnk.done({});", reasoning: null } },
            ] }),
            workspaceId, sessionId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "Show the examples." }],
        });
        assert.equal(result.result.status, 200);
        const turnId = result.turnIds.at(-2)!;
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: turnId });
        const model = rows.filter(({ origin, op }) => origin === "model" && op !== null);
        assert.deepEqual(model.map(({ op, status_rx }) => [op, status_rx]), [["note", 200], ["send", 200], ["note", 200]]);
        assert.match(JSON.parse(model[0].tx).body, /^A SEND quotes an operation in its text:$/u,
            "the prose before the SEND is the turn's NOTE, literally ({§outside-text})");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "outside"), undefined, "beside operations there is no outside source");
        assert.equal(JSON.parse(model[1].tx).body.raw, "await plurnk.kill({\"path\":\"workspace:///quoted.md\"});", "the quoted call stayed body inside SEND");
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, source, "/ops stays exact");
        const quoted = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/quoted.md", scheme: "workspace", name: "body" });
        assert.equal(quoted?.content, "Keep this one too.", "the quoted KILL never ran");
    } finally { await db.close(); }
});

test("{§whitespace-contract}: a Markdown-fenced Code Mode operation unwraps silently and runs", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fenced-codemode-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Read the note.");
        const body = "The recovery marker is MARIGOLD-43.";
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: body });
        const content = "```ts\nawait plurnk.read({\"path\":\"workspace:///notes.md\"});\n```";
        const reasoning = "Deliberating before reading.";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content, reasoning } },
            { assistant: { content: `await plurnk.done({"text":${JSON.stringify(body)}});`, reasoning: null } },
        ] });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "Read the note." }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 2);
        const turnId = result.turnIds.at(-2)!;
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: turnId });
        const reads = rows.filter(({ op, origin }) => op === "read" && origin === "model");
        assert.deepEqual(reads.map(({ status_rx, rx }) => [status_rx, JSON.parse(rx).content]), [[200, body]], "the fenced Code Mode READ unwrapped and ran");
        assert.deepEqual(rows.filter(({ op }) => op === "error"), [], "a valid operation prevents a no-operation strike");
        const next = JSON.stringify(provider.received[1]);
        assert.ok(next.includes(body), "the next request contains the successful result");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, content);
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "reasoning")?.content, reasoning);
    } finally { await db.close(); }
});

test("{§message-completion}: a final reply, code block and all, answers the open message and concludes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `send-conclusion-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "How do I run the tests?");
        const answer = "The runner is configured in the package root:\n\n```ts\nexport default { timeout: 30_000 };\n```\n\nIt takes about a minute.";
        const notices: Array<{ kind: string }> = [];
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: `await plurnk.done({"text":${JSON.stringify(answer)}});`, reasoning: "simple question" } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice) });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 3, maxStrikes: 3,
            messages: [{ role: "user", content: "How do I run the tests?" }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 1, "one model turn: the answer");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: result.turnIds.at(-1)! });
        const completions = rows.filter(({ origin, op }) => origin === "model" && op === "done");
        assert.deepEqual(completions.map(({ status_rx }) => status_rx), [200]);
        assert.equal(JSON.parse(completions[0].tx).body.raw, answer, "the exact DONE body is the reply");
        assert.equal(notices.filter(({ kind }) => kind === "turn_no_operations").length, 0, "an answer is not an empty turn");
        const rail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: loopId });
        assert.equal(rail?.strike_streak, 0);
    } finally { await db.close(); }
});

test("{§fence-pairing}: a SEND with nested examples delivers its literal body", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `nested-reply-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "How do I read a file?");
        const answer = "An operation uses plurnk.read:\n\n```ts\nawait plurnk.read({ path: \"notes.md\" });\n```";
        const result = await engineRun(db, workspaceId, sessionId, loopId,
            `await plurnk.send({"text":${JSON.stringify(answer)}});\n\nawait plurnk.done({});`, "How do I read a file?");
        assert.equal(result.result.status, 200);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds.at(-1)! });
        const send = rows.find(({ origin, op }) => origin === "model" && op === "send");
        assert.equal(JSON.parse(send!.tx).body.raw, answer, "the SEND body retains the nested example");
        assert.equal(rows.filter(({ origin, op }) => origin === "model" && op === "read").length, 0, "the quoted example never ran");
    } finally { await db.close(); }
});

// {§outside-text} {§turn-source-resources}
for (const [label, content, finishReason] of [
    ["plain narration without an operation", "Let me check the notes first.", "stop"],
    ["prose cut at the output allowance", "The findings give me precise integration points. Now I'll", "length"],
] as const) {
    test(`{§outside-text}: ${label} is an empty turn with one strike and an error row, never an answer`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `empty-turn-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "Do the thing.");
            const notices: Array<{ kind: string }> = [];
            const reasoning = Array.from({ length: 120 }, (_, index) => `thinking about it ${index + 1}`).join("\n");
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content, reasoning, finishReason } },
                { assistant: { content: "await plurnk.done({\"text\":\"Done.\"});", reasoning: null } },
            ] });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice) });
            const result = await engine.runLoop({
                provider, workspaceId, sessionId, loopId, maxTurns: 4, maxStrikes: 3,
                messages: [{ role: "user", content: "Do the thing." }],
            });
            assert.equal(result.result.status, 200);
            assert.equal(result.turnIds.length, 3, "initialization, the empty turn, the answer: no private resample, no read-back turn");
            const emptyTurn = result.turnIds[1];
            const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: emptyTurn });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [1], "admitted on its only attempt");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
            assert.equal(sources.find((row) => row.turn_id === emptyTurn && row.kind === "ops")?.content, content);
            assert.equal(sources.find((row) => row.turn_id === emptyTurn && row.kind === "reasoning")?.content, reasoning, "the reasoning source is kept whole at its address");
            assert.deepEqual(notices.filter(({ kind }) => kind === "turn_no_operations"), [], "{§outside-text} the strike sends no notice");
            const strikes = (await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: emptyTurn }))
                .filter(({ origin, op }) => origin === "_plurnk" && op === "error");
            assert.deepEqual(strikes.map(({ status_rx, rx }) => [status_rx, JSON.parse(rx).problem.detail]), [[422, "The turn performed no operation."]], "{§outside-text} the strike is one error row on the turn");
            const readBack = (await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; scheme: string | null }>({ turn_id: result.turnIds[2] }))
                .filter(({ origin, op, scheme }) => origin === "_plurnk" && op === "read" && scheme === "reasoning");
            assert.deepEqual(readBack, [], "no separate read-back turn is manufactured after an empty turn");
            const answer = await db.test_get_turn.get<{ packet: string }>({ id: result.turnIds.at(-1)! });
            const errors = JSON.parse(packetSection(JSON.parse(answer!.packet), "errors") || "[]") as Array<{ status: number }>;
            assert.deepEqual(errors.map(({ status }) => status), [422], "the strike rides the next packet's errors");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds.at(-1)! });
            assert.equal(JSON.parse(rows.find(({ op, origin }) => origin === "model" && op === "done")!.tx).body.raw, "Done.", "the later completion reply answered");
            const rail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: loopId });
            assert.equal(rail?.strike_streak, 0, "the answer cleared the streak the empty turn earned");
        } finally { await db.close(); }
    });
}

test("{§outside-text}: prose-only turns store their text outside the turn, verbatim, without suppressing recovery", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interstitial-privilege-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Do the thing.");
        const narration = "Let me look at the failing test first.";
        const prose = "The investigation is still in progress.";
        const untranslated = '<tool_call>\n{"name": "read_file", "arguments": {"path": "workspace:///notes.md"}}\n</tool_call>';
        const secondNarration = "Checking the source.";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: `${narration}\n\nawait plurnk.note({"text":"plan"});`, reasoning: null, finishReason: "stop" } },
            { assistant: { content: prose, reasoning: null, finishReason: "stop" } },
            { assistant: { content: untranslated, reasoning: "Read the note first.", finishReason: "stop" } },
            { assistant: { content: `${secondNarration}\n\nawait plurnk.note({"text":"still here"});`, reasoning: null, finishReason: "stop" } },
            { assistant: { content: "await plurnk.done({\"text\":\"Done.\"});", reasoning: null } },
        ] });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Do the thing." }] });
        assert.equal(result.result.status, 200);
        assert.equal(result.turnIds.length, 6, "{§outside-text} no runtime read-back turn follows an empty turn");
        const [, workingTurn, proseTurn, untranslatedTurn, secondWorkingTurn] = result.turnIds;
        const rowsOf = async (turnId: number) => await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: turnId });
        const notesOf = async (turnId: number) => (await rowsOf(turnId))
            .filter(({ origin, op }) => origin === "model" && op === "note").map(({ tx }) => JSON.parse(tx).body as string);
        const strikesOf = async (turnId: number) => (await rowsOf(turnId))
            .filter(({ origin, op }) => origin === "_plurnk" && op === "error").map(({ status_rx }) => status_rx);
        assert.deepEqual(
            [await strikesOf(workingTurn), await strikesOf(proseTurn), await strikesOf(untranslatedTurn), await strikesOf(secondWorkingTurn)],
            [[], [422], [422], []],
            "{§outside-text} each empty turn carries its one error row",
        );
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const outsideOf = (turnId: number) => sources.find((row) => row.turn_id === turnId && row.kind === "outside")?.content;
        assert.deepEqual(await notesOf(workingTurn), [narration, "plan"], "narration beside a real operation is the turn's NOTE at its position ({§outside-text})");
        assert.equal(outsideOf(workingTurn), undefined, "beside an operation there is no outside source");
        assert.deepEqual(await notesOf(proseTurn), [], "prose alone is never a NOTE");
        assert.equal(outsideOf(proseTurn), prose, "prose is stored as the outside source when the turn performed no operation");
        assert.equal((await rowsOf(proseTurn)).some(({ op }) => op === "send"), false, "storage is not message delivery");
        const following = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: untranslatedTurn }))!.packet);
        assert.doesNotMatch(packetSection(following, "log"), /The investigation is still in progress\./u, "the next packet never carries the text");
        assert.doesNotMatch(packetSection(following, "notices"), /outside_text/u, "the empty turn's error row is the one thing the model hears of it; no second notice");
        assert.notDeepEqual(JSON.parse(packetSection(following, "work")).messages, [], "the original message still needs a reply");
        assert.deepEqual(await notesOf(untranslatedTurn), []);
        assert.equal(outsideOf(untranslatedTurn), untranslated, "foreign tool-call markup is stored verbatim; nothing filters the source");
        assert.deepEqual(await notesOf(secondWorkingTurn), [secondNarration, "still here"], "narration beside an operation is the turn's NOTE");
        assert.equal(outsideOf(secondWorkingTurn), undefined);
        assert.equal(sources.find((row) => row.turn_id === untranslatedTurn && row.kind === "reasoning")?.content, "Read the note first.", "the reasoning is kept even when it is not read back");
        assert.equal(sources.find((row) => row.turn_id === proseTurn && row.kind === "ops")?.content, prose);
    } finally { await db.close(); }
});

for (const finishReason of [undefined, "stop", "length"] as const) {
    test(`{§outside-text}: reasoning without operations does not resolve a request that has only progress replies (finish=${finishReason ?? "absent"})`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `reasoning-only-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "Read the note and answer.");
            await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Recorded." });
            const reasoning = "I still need to work out the next action.";
            const notices: Array<{ kind: string }> = [];
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: "await plurnk.read({\"path\":\"workspace:///notes.md\"});\nawait plurnk.send({\"text\":\"Recorded.\"});", reasoning: null } },
                { assistant: { content: "", reasoning, ...(finishReason === undefined ? {} : { finishReason }) } },
                { assistant: { content: "await plurnk.done({});", reasoning: null } },
            ] });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice) });
            const result = await engine.runLoop({
                provider, workspaceId, sessionId, loopId, maxTurns: 4, maxStrikes: 3,
                messages: [{ role: "user", content: "Read the note and answer." }],
            });
            assert.equal(result.result.status, 200);
            assert.equal(provider.received.length, 3, "the empty turn does not infer completion; a recovery request follows");
            assert.equal(result.turnIds.length, 4, "initialization, the working turn, the empty turn, the conclusion");
            const emptyTurn = result.turnIds[2];
            const turn = await db.test_get_turn.get<{ status: number; packet: string }>({ id: emptyTurn });
            assert.equal(turn?.status, 102);
            assert.equal(JSON.parse(packetSection(JSON.parse(turn.packet), "work")).messages.length, 1, "the progress reply has not resolved the original message");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
            assert.equal(sources.find(({ turn_id, kind }) => turn_id === emptyTurn && kind === "reasoning")?.content, reasoning);
            assert.equal(notices.filter(({ kind }) => kind === "turn_no_operations").length, 0, "{§outside-text} the strike sends no notice");
            const readBack = (await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; scheme: string | null }>({ turn_id: result.turnIds[3] }))
                .filter(({ origin, op, scheme }) => origin === "_plurnk" && op === "read" && scheme === "reasoning");
            assert.deepEqual(readBack, [], "no runtime READ follows the empty turn");
            const conclusion = await db.test_get_turn.get<{ packet: string }>({ id: result.turnIds.at(-1)! });
            const errors = JSON.parse(packetSection(JSON.parse(conclusion!.packet), "errors") || "[]") as Array<{ status: number; path: string }>;
            assert.deepEqual(errors.map(({ status, path }) => [status, path]), [[422, "log:///1/3/1/error"]], "the strike rides the next packet's errors");
        } finally { await db.close(); }
    });
}
});

describe("Digest.programmatic", () => {
// {§share-packet-names}: the package subpath is a pure import and its
// selectors prune complete forensic graphs, not implementation-private arrays.














const execFileP = promisify(execFile);

interface DigestJson {
    workspaces: Array<{ id: number; accounting: ProviderAccounting }>;
    sessions: Array<{ id: number; workspace_id: number; accounting: ProviderAccounting }>;
    loops: Array<{ id: number; session_id: number; prompt: string }>;
    turns: Array<{ id: number; loop_id: number; accounting: ProviderAccounting }>;
    inference_calls: Array<{
        id: number;
        workspace_id: number;
        turn_id: number;
        kind: "emission" | "bare";
        accounting: ProviderAccounting;
    }>;
    model_calls: Array<{
        id: number;
        turn_id: number;
        kind: "emission" | "bare";
        log_entry_id: number | null;
        accounting: ProviderAccounting;
    }>;
    turn_attempts: Array<{ turn_id: number; model: string }>;
    provider_requests: Array<{ inference_call_id: number; turn_attempt_id: number | null; accounting: ProviderRequestAccounting }>;
    log_entries: Array<{ session_id: number; loop_id: number; turn_id: number; target: string | null }>;
}

const seedSessionEvidence = async (
    db: Db,
    workspaceId: number,
    marker: string,
    ordinal: number,
    op: string,
): Promise<{ sessionId: number; loopId: number; turnId: number }> => {
    const sessionId = await insertSession(db, workspaceId, null, `session-${marker}`);
    const loopId = await insertLoop(db, sessionId, 1, `prompt-${marker}`);
    const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
    const turnId = turn.id;
    await Turn.recordInference(db, turnId, {
        packet: JSON.stringify({ weight: 0, attributions: [] }),
        sections: JSON.stringify([{ name: "prompt", slot: "user", header: null, weight: 1, items: [`input-${marker}`] }]),
        usageCurationBudget: null,
        finishReason: "stop",
        model: `model-${marker}`,
        meta: "{}",
    });
    await Turn.recordSource(db, turnId, "outside", `outside-${marker}`);
    await Turn.complete(db, turnId, 200);
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: turnId,
        kind: "emission",
        attributions: "[]",
        model: `model-${marker}`,
    });
    if (modelCall === undefined) throw new Error("digest fixture model call did not open");
    const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
        model_call_id: modelCall.id,
    });
    if (attempt === undefined) throw new Error("digest fixture attempt did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:digest-fixture",
        model: `model-${marker}`,
        outcome: "response",
        usage: {
            inputTokens: ordinal * 100,
            outputTokens: ordinal * 10,
            totalTokens: ordinal * 110,
            inputTokenDetails: { noCacheTokens: ordinal * 100, cacheReadTokens: 0 },
            outputTokenDetails: { textTokens: ordinal * 9, reasoningTokens: ordinal },
        },
        cost: {
            kind: "charged",
            amount: { amount: `0.00${ordinal}`, currency: "USD" },
            source: "digest fixture",
        },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("digest fixture provider request did not open");
    const settled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(request.id, accounting),
    );
    assert.equal(settled.changes, 1);
    // A retried wire failure precedes the success (#473): outcome=error, no usage,
    // unknown cost — the shape a 429 leaves in the ledger.
    const errored = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 2,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (errored === undefined) throw new Error("digest fixture errored request did not open");
    const erroredSettled = await db.engine_settle_provider_request.run(
        providerRequestSettlementParams(errored.id, {
            provider: accounting.provider,
            model: accounting.model,
            outcome: "error",
            cost: { kind: "unknown", reason: "the provider response reported no normalized usage" },
        }),
    );
    assert.equal(erroredSettled.changes, 1);
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: JSON.stringify({ assistant: { reasoning: `reason-${marker}` } }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("digest:fixture")),
        finish_reason: "stop",
        model: `model-${marker}`,
    });
    await db.engine_classify_turn_attempt_response.run({
        id: attempt.id,
        accepted: 1,
        parse_errors: "[]",
    });
    await db.engine_insert_log_entry.run({
        session_id: sessionId,
        loop_id: loopId,
        turn_id: turnId,
        sequence: 1,
        origin: "model",
        source: null,
        model_call_id: null,
        op,
        scheme: "workspace",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: `/${marker}`,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: "{}",
        mimetype_tx: "application/json",
        rx: JSON.stringify({ status: 200, content: marker }),
        mimetype_rx: "application/json",
        status_rx: 200,
        weight: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
    return { sessionId, loopId, turnId };
};

const seedBareEvidence = async (
    db: Db,
    coordinates: { sessionId: number; loopId: number; turnId: number },
): Promise<void> => {
    const modelCall = await db.engine_open_model_call.get<{ id: number }>({
        turn_id: coordinates.turnId,
        kind: "bare",
        attributions: JSON.stringify(["provider:digest-bare"]),
        model: "digest-bare",
    });
    if (modelCall === undefined) throw new Error("digest BARE model call did not open");
    const accounting: ProviderRequestAccounting = {
        provider: "provider:digest-bare",
        model: "digest-bare",
        outcome: "response",
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        },
        cost: {
            kind: "estimated",
            amount: { amount: "0", currency: "USD" },
            source: "digest BARE fixture",
        },
    };
    const request = await db.engine_open_provider_request.get<{ id: number }>({
        inference_call_id: modelCall.id,
        sequence: 1,
        provider: accounting.provider,
        model: accounting.model,
    });
    if (request === undefined) throw new Error("digest BARE provider request did not open");
    await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, accounting));
    await db.engine_observe_model_call_response.run({
        id: modelCall.id,
        native_inputs: "[]",
        response: JSON.stringify({ assistant: { content: "Berlin", reasoning: null } }),
        failure: null,
        capacity: JSON.stringify(testDeferredProviderCapacity("digest:bare-fixture")),
        finish_reason: "stop",
        model: accounting.model,
    });
    await db.engine_insert_log_entry.run({
        session_id: coordinates.sessionId,
        loop_id: coordinates.loopId,
        turn_id: coordinates.turnId,
        sequence: 2,
        origin: "model",
        source: null,
        model_call_id: modelCall.id,
        op: "bare",
        signal: JSON.stringify(["+fact"]),
        scheme: null,
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: null,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: JSON.stringify({ op: "bare", body: "What is the capital of Germany?" }),
        mimetype_tx: "application/json",
        rx: JSON.stringify({ status: 200, content: "Berlin", mimetype: "text/plain" }),
        mimetype_rx: "application/json",
        status_rx: 200,
        weight: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
};

test("{§share-packet-names}: importing the public subpath performs no process or filesystem action", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-import-"));
    const packageRoot = resolve(import.meta.dirname, "../..");
    try {
        await writeFile(join(dir, "before-import"), "sentinel");
        const program = `
            import { writeFileSync } from "node:fs";
            process.argv = [process.execPath, "digest", "--invalid-if-parsed"];
            console.log = () => { throw new Error("digest import called console.log"); };
            console.error = () => { throw new Error("digest import called console.error"); };
            process.exit = (code) => { throw new Error(\`digest import called process.exit(\${code})\`); };
            process.chdir(${JSON.stringify(dir)});
            await import("@plurnk/plurnk-digest");
            writeFileSync("after-import", "returned");
        `;
        const result = await execFileP(process.execPath, [
            "--conditions=plurnk-dev",
            "--input-type=module",
            "--eval",
            program,
        ], {
            cwd: packageRoot,
            env: {
                ...process.env,
                HOME: dir,
                NODE_NO_WARNINGS: "1",
                PLURNK_SERVICE_DB_PATH: join(dir, "must-not-exist.db"),
            },
        });
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
        assert.deepEqual((await readdir(dir)).toSorted(), ["after-import", "before-import"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§share-packet-names}: selectors prune emitted evidence and each selection writes its own folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-programmatic-"));
    const dbPath = join(dir, "plurnk.db");
    const db = await openMigrated(dbPath);
    let workspaceA = 0;
    let workspaceB = 0;
    let a1: Awaited<ReturnType<typeof seedSessionEvidence>>;
    let a2: Awaited<ReturnType<typeof seedSessionEvidence>>;
    let b1: Awaited<ReturnType<typeof seedSessionEvidence>>;
    try {
        workspaceA = await insertWorkspace(db, "digest-workspace-a");
        workspaceB = await insertWorkspace(db, "digest-workspace-b");
        a1 = await seedSessionEvidence(db, workspaceA, "a1", 1, "read");
        await seedBareEvidence(db, a1);
        a2 = await seedSessionEvidence(db, workspaceA, "a2", 2, "edit");
        b1 = await seedSessionEvidence(db, workspaceB, "b1", 3, "copy");
    } finally {
        await db.close();
    }

    const { Digest } = await import("@plurnk/plurnk-digest");
    const { default: EvidenceReader } = await import("@plurnk/plurnk-service/evidence");
    const run = async (
        name: string,
        selectors: { sessionId?: number; workspaceId?: number },
    ): Promise<{ json: DigestJson; markdown: string; reasoning: string; files: string[] }> => {
        const digestDir = join(dir, name);
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir, ...selectors });
        const files = (await readdir(digestDir)).toSorted();
        return {
            json: JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as DigestJson,
            markdown: await readFile(join(digestDir, "digest.md"), "utf8"),
            reasoning: await readFile(join(digestDir, "reasoning.md"), "utf8"),
            files,
        };
    };

    try {
        const session = await run("session", { sessionId: a1.sessionId });
        // {§share-packet-names}: a turn line names its own artifact and the model's own
        // count, so a reader never subtracts harness turns or counts packet files by hand.
        assert.match(session.markdown, /^T\d+ \(model turn \d+ · session-a1-1-1\): producer=model/m);
        assert.match(session.markdown, new RegExp(`^T\\d+ \\(model turn \\d+ · session-a1-1-1\\): producer=model.* outside=${contentWeight("outside-a1")} tok`, "m"),
            "{§outside-text}: the turn line carries the weight of its outside text");
        for (const stem of session.markdown.match(/session-[a-z0-9]+-\d+-\d+/gu) ?? []) {
            assert.ok(session.files.some((file) => file.startsWith(`${stem}.`)), `${stem} names a written artifact`);
        }
        assert.deepEqual(session.json.workspaces.map(({ id }) => id), [workspaceA]);
        assert.deepEqual(session.json.sessions.map(({ id }) => id), [a1.sessionId]);
        assert.deepEqual(session.json.loops.map(({ id }) => id), [a1.loopId]);
        assert.deepEqual(session.json.turns.map(({ id }) => id), [a1.turnId]);
        assert.deepEqual(session.json.inference_calls.map(({ kind }) => kind), ["emission", "bare"]);
        assert.deepEqual(session.json.model_calls.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId]);
        assert.deepEqual(session.json.model_calls.map(({ kind }) => kind), ["emission", "bare"]);
        assert.ok(session.json.model_calls[1]?.log_entry_id !== null);
        assert.deepEqual(session.json.turn_attempts.map(({ turn_id }) => turn_id), [a1.turnId]);
        assert.equal(session.json.provider_requests.length, 3);
        assert.equal(session.json.provider_requests[2]?.turn_attempt_id, null);
        assert.deepEqual(session.json.log_entries.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId]);
        assert.deepEqual(session.json.sessions.map(({ accounting }) => accounting.costUsd), [null]);
        assert.deepEqual(session.json.sessions.map(({ accounting }) => accounting.knownCostUsd), ["0.001"]);
        assert.deepEqual(session.json.turns.map(({ accounting }) => accounting.usage), [null]);
        assert.deepEqual(session.json.turns.map(({ accounting }) => accounting.knownUsage?.inputTokens), [100]);
        assert.match(session.markdown, /prompt-a1/);
        assert.match(session.markdown, /Tokens:\s+input=100\+\? output=10\+\? reasoning=1\+\? cache-read=0\+\?/);
        assert.match(session.markdown, /Cost:\s+\$0\.001 \+ \? \(incomplete\) \(estimated — catalog rates\)/);
        assert.match(session.markdown, /Wire:\s+3 requests · 1 error \(33%\)/);
        assert.match(session.markdown, /Op mix:\s+bare=1 read=1/);
        assert.match(
            session.markdown,
            /^Owner: _plurnk$/mu,
            "the digest projects durable session ownership",
        );
        assert.doesNotMatch(session.markdown, /\[object Object\]/u);
        assert.match(session.reasoning, /reason-a1/);
        assert.doesNotMatch(`${JSON.stringify(session.json)}${session.markdown}${session.reasoning}`, /(?:prompt|reason)-(?:a2|b1)/);
        assert.doesNotMatch(session.markdown, /(?:\$0\.002000|\$0\.003000|Op mix:\s+(?:edit|copy)=1)/);
        assert.ok(session.files.includes("session-a1-1-1.user.md"));
        assert.equal(await readFile(join(dir, "session", "session-a1-1-1.user.md"), "utf8"), "input-a1");
        assert.ok(!session.files.some((file) => file.startsWith("session-a2")));

        const workspace = await run("workspace", { workspaceId: workspaceA });
        assert.deepEqual(workspace.json.workspaces.map(({ id }) => id), [workspaceA]);
        assert.ok(workspace.json.sessions.every(({ workspace_id }) => workspace_id === workspaceA));
        assert.deepEqual(
            workspace.json.sessions.filter(({ id }) => id === a1.sessionId || id === a2.sessionId).map(({ id }) => id),
            [a1.sessionId, a2.sessionId],
        );
        assert.deepEqual(workspace.json.loops.map(({ id }) => id), [a1.loopId, a2.loopId]);
        assert.deepEqual(workspace.json.turns.map(({ id }) => id), [a1.turnId, a2.turnId]);
        assert.deepEqual(workspace.json.inference_calls.map(({ kind }) => kind), [
            "emission",
            "bare",
            "emission",
        ]);
        assert.deepEqual(workspace.json.model_calls.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId, a2.turnId]);
        assert.deepEqual(workspace.json.turn_attempts.map(({ turn_id }) => turn_id), [a1.turnId, a2.turnId]);
        assert.equal(workspace.json.provider_requests.length, 5);
        assert.equal(workspace.json.workspaces[0]?.accounting.costUsd, null);
        assert.equal(workspace.json.workspaces[0]?.accounting.knownCostUsd, "0.003");
        assert.deepEqual(workspace.json.log_entries.map(({ turn_id }) => turn_id), [a1.turnId, a1.turnId, a2.turnId]);
        assert.deepEqual(
            workspace.json.sessions
                .filter(({ id }) => id === a1.sessionId || id === a2.sessionId)
                .map(({ accounting }) => accounting.knownCostUsd),
            ["0.001", "0.002"],
        );
        assert.match(workspace.markdown, /prompt-a1/);
        assert.match(workspace.markdown, /prompt-a2/);
        assert.match(workspace.markdown, /Op mix:\s+bare=1 read=1/);
        assert.match(workspace.markdown, /Op mix:\s+edit=1/);
        assert.match(workspace.markdown, /Cost:\s+\$0\.002 \+ \? \(incomplete\) \(charged\)/);
        assert.doesNotMatch(`${JSON.stringify(workspace.json)}${workspace.markdown}${workspace.reasoning}`, /(?:prompt|reason)-b1/);
        assert.doesNotMatch(workspace.markdown, /(?:\$0\.003000|Op mix:\s+copy=1)/);
        assert.ok(workspace.files.some((file) => file.startsWith("session-a1-1-1.")));
        assert.ok(workspace.files.some((file) => file.startsWith("session-a2-1-1.")));
        assert.ok(!workspace.files.some((file) => file.startsWith("session-b1-")));

        const intersection = await run("intersection", { sessionId: b1.sessionId, workspaceId: workspaceA });
        assert.deepEqual(intersection.json.workspaces, []);
        assert.deepEqual(intersection.json.sessions, []);
        assert.deepEqual(intersection.json.loops, []);
        assert.deepEqual(intersection.json.turns, []);
        assert.deepEqual(intersection.json.inference_calls, []);
        assert.deepEqual(intersection.json.model_calls, []);
        assert.deepEqual(intersection.json.turn_attempts, []);
        assert.deepEqual(intersection.json.provider_requests, []);
        assert.deepEqual(intersection.json.log_entries, []);
        assert.doesNotMatch(`${intersection.markdown}${intersection.reasoning}`, /(?:prompt|reason)-(?:a1|a2|b1)/);
        assert.ok(!intersection.files.some((file) => file.startsWith("packet")));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("note-continuity", () => {
type Row = { op: string | null; origin: string };

// {§operation-results} {§diagnostic-observation} — the card's command as the notice's directive, in callout form.
const NOTICE = "> [!WARNING]\n> YOU MUST persist all new decisions, hypotheses, and facts as `plurnk.note` tool calls. The turn continued without a `plurnk.note`. [continued_without_note]";

const noticesOf = async (db: Db, turnId: number): Promise<string> =>
    packetSection(JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: turnId }))!.packet), "notices");
const rowsOf = async (db: Db, turnId: number): Promise<Row[]> => await db.test_log_entries_by_turn.all<Row>({ turn_id: turnId });

const runLoop = async (db: Db, responses: Array<{ content: string; reasoning: string | null }>) => {
    const workspaceId = await insertWorkspace(db, `note-continuity-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Look around.");
    const provider = new Mock({ contextWindow: 100_000, responses: responses.map((assistant) => ({ assistant: { ...assistant, finishReason: "stop" } })) });
    return await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider, workspaceId, sessionId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
    });
};

for (const parked of [false, true]) for (const location of ["absent", "content", "reasoning", "both"]) {
    test(`{§operation-results} {§op-shapes}: ${parked ? "parked" : "continuing"} work with NOTE ${location}`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `optional-note-${parked}-${location}`);
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
            const context = { workspaceId, sessionId, loopId };
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const lifecycle = new LoopLifecycle(db);
            const childLoopId = parked ? await holdChild(db, workspaceId, sessionId) : null;
            const contentNote = location === "content" || location === "both";
            const reasoningNote = location === "reasoning" || location === "both";
            const expectedNotes = contentNote ? ["Kept from content."] : [];
            const operation = parked ? "await plurnk.wait({});" : "await plurnk.find({\"path\":\"workspace:///*\"});";
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: {
                    content: `${contentNote ? "await plurnk.note({\"text\":\"Kept from content.\"});\n" : ""}${operation}`,
                    reasoning: reasoningNote ? "await plurnk.note({\"text\":\"Kept from reasoning.\"});" : null,
                } },
                { assistant: { content: "await plurnk.done({\"text\":\"Done.\"});", reasoning: null } },
            ] });
            const first = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(first.status, parked ? 202 : 102, "work determines continuation independently of notes");
            if (childLoopId !== null) {
                await lifecycle.finish(childLoopId, { status: 200 });
                assert.equal(await lifecycle.wake(loopId), true);
                assert.equal((await db.drain_claim_next_loop.get({ session_id: sessionId }))?.id, loopId);
            }
            const final = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(final.status, 200, "the observed work and answered message settle without another note");
            assert.equal(provider.received.length, 2);
            assert.equal(await noticesOf(db, first.turnId), "", "the first model turn has no earlier model turn to report");
            assert.equal(await noticesOf(db, final.turnId), parked || contentNote ? "" : NOTICE,
                parked
                    ? "a parked turn takes no continued_without_note warning before its awaited work settles"
                    : contentNote
                        ? "a NOTE in the program carries the turn forward"
                        : "the turn after a continuing world/tool turn with no content NOTE is told so, once");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
            assert.deepEqual(sources.filter(({ turn_id, kind }) => turn_id === first.turnId && kind === "note").map(({ content }) => content),
                expectedNotes, "only content-authored memory persists; reasoning fences stay inert");
            for (const turn of [first, final]) {
                assert.ok((await rowsOf(db, turn.turnId)).every(({ op }) => op !== "error"), "valid work produces no failure receipt");
            }
        } finally { await db.close(); }
    });
}

test("{§operation-results} {§op-shapes}: continuing world/tool ops require continuity while session/flow ops stay silent", async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    try {
        // 1. World & tool ops on 102 without note/kill/todo emit continued_without_note
        for (const [label, op] of [
            ["find", 'plurnk.find({"path":"workspace:///*"});'],
            ["read", 'plurnk.read({"path":"workspace:///seed.txt"});'],
            ["edit", 'plurnk.edit({"path":"workspace:///edited.txt","text":"v1"});'],
            ["copy", 'plurnk.copy({"from":"workspace:///seed.txt","to":"workspace:///copied.txt"});'],
            ["move", 'plurnk.move({"from":"workspace:///seed.txt","to":"workspace:///moved.txt"});'],
            ["exec", 'plurnk.js({"text":"1 + 1"});'],
        ] as const) {
            const workspaceId = await insertWorkspace(db, `world-op-${label}-${crypto.randomUUID()}`);
            await seedEntryWithChannel(db, { workspaceId, pathname: "/seed.txt", content: "seed" });
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Inspect and report.");
            const schemes = new SchemeRegistry();
            const engine = new Engine({ db, schemes });
            if (label === "exec") {
                const executors = await testExecutors();
                engine.setExecutors(executors);
                schemes.registerRuntimeSchemes(executors);
            }
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: op, reasoning: null } },
                { assistant: { content: 'plurnk.done({"text":"Done."});', reasoning: null } },
            ] });
            const first = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.equal(first.status, 102, label);
            const final = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.equal(final.status, 200, label);
            assert.equal(await noticesOf(db, final.turnId), NOTICE, `${label} without note emits continued_without_note`);
            await quiesceExecs(schemes);
        }
        // 2. Session/flow coordination ops on 102 stay silent without continued_without_note
        {
            const workspaceId = await insertWorkspace(db, `flow-op-send-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Send a progress reply, then conclude.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: 'plurnk.send({"text":"progress update"});', reasoning: null } },
                { assistant: { content: 'plurnk.done({"text":"Sent."});', reasoning: null } },
            ] });
            const first = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.equal(first.status, 102);
            assert.ok((await rowsOf(db, first.turnId)).every(({ op }) => op !== "error"), "send succeeded cleanly with 200");
            const final = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.equal(final.status, 200);
            assert.equal(await noticesOf(db, final.turnId), "", "a pure send coordination turn stays silent");
        }
    } finally { await db.close(); }
});

test("{§operation-results} {§op-shapes}: continuing work with a TODO or KILL satisfies the continuity directive", async () => {
    const db = await openMigrated();
    try {
        for (const [label, op] of [
            ["todo", "await plurnk.todo({\"text\":\"- Survey workspace\\n- Complete task\"});"],
            ["kill", "await plurnk.kill({\"path\":\"log:///1/1/1\"});"],
        ] as const) {
            const workspaceId = await insertWorkspace(db, `optional-${label}-continuity`);
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Inspect the evidence and report the result.");
            const context = { workspaceId, sessionId, loopId };
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: `${op}\n\nawait plurnk.find({"path":"workspace:///*"});`, reasoning: null } },
                { assistant: { content: "await plurnk.done({\"text\":\"Done.\"});", reasoning: null } },
            ] });
            const first = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(first.status, 102);
            const final = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(final.status, 200);
            assert.equal(await noticesOf(db, final.turnId), "", `a ${label} alone satisfies the continuity directive without warning`);
        }
    } finally { await db.close(); }
});

test("{§operation-results} {§loop-completion}: a turn that emits DONE beside unobserved work continues without a continued_without_note warning", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "done-beside-work-no-note-warning");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Write the file and conclude.");
        const context = { workspaceId, sessionId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "await plurnk.edit({\"path\":\"workspace:///result.txt\",\"content\":\"ok\"});\n\nawait plurnk.done({\"text\":\"Done.\"});", reasoning: null } },
            { assistant: { content: "", reasoning: null } },
        ] });
        const first = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(first.status, 102);
        const final = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(final.status, 200);
        assert.equal(await noticesOf(db, final.turnId), "> [!NOTE]\n> All Open Work resolved, but 1 tool call delivered unread log receipts. Submit `plurnk.done({})` if already finished. [results_pending]");
    } finally { await db.close(); }
});

test("{§operation-results}: continued_without_note is skipped when Open Messages are resolved or another diagnostic or gate owns the turn", async () => {
    const db = await openMigrated();
    try {
        // 1. 0 unresolved Open Messages (maintenance/background turn with no open message)
        {
            const workspaceId = await insertWorkspace(db, "skip-note-zero-open");
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1);
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: 'plurnk.find({"path":"workspace:///*"});', reasoning: null } },
                { assistant: { content: "", reasoning: null } },
            ] });
            assert.equal((await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] })).status, 102);
            const second = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.doesNotMatch(await noticesOf(db, second.turnId), /\[continued_without_note\]/u);
        }
        // 2. Failed operation (status >= 400)
        {
            const workspaceId = await insertWorkspace(db, "skip-note-failed-op");
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Read the file.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: 'plurnk.read({"path":"workspace:///missing.txt"});', reasoning: null } },
                { assistant: { content: 'plurnk.done({"text":"Missing."});', reasoning: null } },
            ] });
            assert.equal((await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] })).status, 102);
            const second = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.equal(second.status, 200);
            assert.equal(await noticesOf(db, second.turnId), "");
        }
        // 3. Recoverable parse error
        {
            const workspaceId = await insertWorkspace(db, "skip-note-parse-error");
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Inspect.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: 'plurnk.find({"path":"workspace:///*"});\n\nplurnk.read(42);', reasoning: null } },
                { assistant: { content: 'plurnk.done({"text":"Fixed."});', reasoning: null } },
            ] });
            assert.equal((await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] })).status, 102);
            const second = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.equal(second.status, 200);
            assert.equal(await noticesOf(db, second.turnId), "");
        }
        // 4. Output truncated (outputCut !== null)
        {
            const workspaceId = await insertWorkspace(db, "skip-note-output-cut");
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Inspect.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: 'plurnk.find({"path":"workspace:///*"});', reasoning: null, finishReason: "length" } },
                { assistant: { content: 'plurnk.done({"text":"Done."});', reasoning: null } },
            ] });
            assert.equal((await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] })).status, 102);
            const second = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
            assert.equal(second.status, 200);
            assert.doesNotMatch(await noticesOf(db, second.turnId), /\[continued_without_note\]/u);
        }
        // 5. Over curation budget (curationOverflow !== null)
        {
            const workspaceId = await insertWorkspace(db, "skip-note-over-budget");
            const sessionId = await insertSession(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, sessionId, 1, "Curate.");
            await seedEntryWithChannel(db, { workspaceId, pathname: "/a.txt", content: "ok" });
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const wide = new Mock({ contextWindow: 1_000_000, responses: [
                { assistant: { content: `plurnk.note({"text":${JSON.stringify("Remember ".repeat(5_000))}});`, reasoning: null } },
            ] });
            assert.equal((await engine.runTurn({ workspaceId, sessionId, loopId, provider: wide, messages: [] })).status, 102);
            const prevOut = process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
            const prevReas = process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
            let tight: Mock;
            try {
                process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(1_000_000 - 12_000);
                delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
                tight = new Mock({ contextWindow: 1_000_000, responses: [
                    { assistant: { content: 'plurnk.move({"from":"workspace:///a.txt","to":"workspace:///b.txt"});', reasoning: null } },
                    { assistant: { content: 'plurnk.kill({"path":"log:///**/note"});', reasoning: null } },
                ] });
            } finally {
                if (prevOut === undefined) delete process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET;
                else process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = prevOut;
                if (prevReas === undefined) delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
                else process.env.PLURNK_PROVIDERS_REASONING_BUDGET = prevReas;
            }
            assert.equal((await engine.runTurn({ workspaceId, sessionId, loopId, provider: tight, messages: [] })).status, 102);
            const third = await engine.runTurn({ workspaceId, sessionId, loopId, provider: tight, messages: [] });
            assert.doesNotMatch(await noticesOf(db, third.turnId), /\[continued_without_note\]/u);
        }
    } finally { await db.close(); }
});

test("{§outside-text} {§operation-results}: an operation-free response keeps its failure receipt and takes no notice", async () => {
    const db = await openMigrated();
    try {
        const result = await runLoop(db, [
            { content: "Still thinking about it.", reasoning: null },
            { content: "await plurnk.done({\"text\":\"Done.\"});", reasoning: null },
        ]);
        assert.equal(result.result.status, 200);
        const [, empty, final] = result.turnIds;
        assert.ok((await rowsOf(db, empty)).some(({ origin, op }) => origin === "_plurnk" && op === "error"), "the empty turn has its row");
        assert.equal(await noticesOf(db, final), "", "the failure receipt supplies the feedback");
    } finally { await db.close(); }
});
});

describe("outside-text-notes", () => {
// Trial (#1073): text outside the fences is annotation the model wrote without its fence; it lands as a
// NOTE at its position, is frozen into the program as one, and draws no notice.








test("{§outside-text} prose before, between and after fences lands as NOTEs in order and is replayed in the model's voice", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `outside-notes-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Look around.");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            "Thinking out loud first.\n\nawait plurnk.find({\"path\":\"workspace:///*\"});\n\nBetween the two.\n\nawait plurnk.find({\"path\":\"workspace:///*\"});\n\nAnd a trailing remark.",
            "await plurnk.done({\"text\":\"Done.\"});",
        ].map((content) => ({ assistant: { content, reasoning: null, finishReason: "stop" } })) });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
        });
        assert.equal(result.result.status, 200, JSON.stringify(result.result));
        const [, prosed, final] = result.turnIds;
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: prosed });
        const notes = rows.filter(({ op, origin }) => op === "note" && origin === "model").map(({ tx }) => (JSON.parse(tx) as { body: string }).body);
        assert.deepEqual(notes, ["Thinking out loud first.", "Between the two.", "And a trailing remark."], "each span is one NOTE row, in source order");
        assert.ok(!rows.some(({ op, origin }) => op === "error" && origin === "_plurnk"), "no error row");
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: final }))!.packet) as { sections: Parameters<typeof PacketWire.renderSlot>[0] };
        assert.equal(packetSection(packet, "notices"), "", "no outside-text and no missing-NOTE notice");
        const user = PacketWire.renderSlot(packet.sections, "user");
        assert.equal([...user.matchAll(/^### log:\/\/\/1\/2\/\d+\/note · \d+/gmu)].length, 3, "each annotation retains its own receipt");
        assert.doesNotMatch(user, /Thinking out loud|Between the two|And a trailing remark/u, "receipts do not duplicate the annotations");
        const assistant = PacketWire.renderSlot(packet.sections, "assistant");
        assert.match(assistant, /^plurnk\.note\(\{"text":"Thinking out loud first\."\}\)\n\n[\s\S]*plurnk\.note\(\{"text":"Between the two\."\}\)\n\n[\s\S]*plurnk\.note\(\{"text":"And a trailing remark\."\}\)/u, `the replay carries them as NOTE statements:\n${assistant}`);
    } finally { await db.close(); }
});
});

describe("terminal-evidence", () => {
// {§outside-text} — a terminal rules the loop over and keeps its status, but never decides the
// model said nothing: it cites what the last turn left unconcluded, at the address that already
// holds it. {§engine-rails} — and it names the source that actually crossed.











const said = (content: string): MockResponse => ({ assistant: { content, reasoning: null }, assistantRaw: null });

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `terminal-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1, "What is two plus two?");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, sessionId, loopId };
};

const problemOf = (result: { result: { problem?: Record<string, unknown> } }) => {
    assert.ok(result.result.problem !== undefined, "a terminal is a failure and carries a problem");
    return result.result.problem;
};

test("{§outside-text}: a strike threshold crossed by unfenced prose keeps its 500 and cites what was said", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            said("Let me think about this."),
            said("Two plus two."),
            said("The answer is four."),
        ] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 500, "the engine ruled the loop failed and the status never softens");
        assert.equal(problem.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.match(
            problem.detail as string,
            /consecutive turns performed no operation\.$/,
            "a turn that attempted nothing did not fail an operation",
        );

        // The citation, not the bytes. Turn 1 is initialization, so the three model turns are 2-4.
        assert.equal(problem.unconcluded, "ops://alice/1/4", "the terminal cites the last unconcluded emission");
        assert.ok(!JSON.stringify(problem).includes("The answer is four"), "cited, never embedded");

        // And the citation is not a dead link.
        const cited = await clientRead(engine, db, {
            workspaceId, sessionId,
            statement: statement(`await plurnk.read({"path":"${problem.unconcluded as string}"});`),
        });
        assert.equal(cited.status, 200);
        assert.ok("content" in cited);
        assert.equal(cited.content, "The answer is four.", "what the model last said is reachable at the cited address");
    } finally { await db.close(); }
});

test("{§outside-text}: a terminal whose last turn acted carries no `unconcluded` at all", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Two empty turns strike, then a turn that performs a real operation — and the ceiling ends
        // the loop there. Nothing was left unconcluded, so nothing is cited.
        const provider = new Mock({ contextWindow: 100_000, responses: [
            said("Thinking."),
            said("Still thinking."),
            said("await plurnk.note({\"text\":\"checked\"});"),
        ] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 3, maxStrikes: 10,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 429, "the turn ceiling is its own terminal");
        assert.ok(!("unconcluded" in problem), "an absent member is not an empty one");
    } finally { await db.close(); }
});

test("{§outside-text}: the turn ceiling cites an unconcluded last turn too", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            said("await plurnk.note({\"text\":\"working\"});"),
            said("I believe the answer is four."),
        ] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 2, maxStrikes: 10,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 429);
        assert.equal(problem.unconcluded, "ops://alice/1/3", "every terminal keeps the evidence, not only the strike rail");
    } finally { await db.close(); }
});

test("{§outside-text}: an empty turn's fingerprint is its text — saying the same thing IS a cycle", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const same = said("I am thinking about it.");
        const provider = new Mock({ contextWindow: 100_000, responses: [same, same, same] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 508, "a model repeating itself verbatim is a loop, and still says so");
        assert.match(problem.detail as string, /its responses repeated without performing an operation\.$/);
        assert.equal(problem.unconcluded, "ops://alice/1/4", "a cycle terminal keeps the evidence too");
    } finally { await db.close(); }
});

test("{§engine-rails}: repeated reasoning-only responses are not reported as repeated operations", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const same: MockResponse = { assistant: { content: "", reasoning: "Considering the next step.", finishReason: "stop" }, assistantRaw: null };
        const provider = new Mock({ contextWindow: 100_000, responses: [same, same, same] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        assert.equal(loop.result.status, 508, "the cycle and strike threshold remain enforced");
        assert.equal(problemOf(loop).type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.match(problemOf(loop).detail as string, /its responses repeated without performing an operation\.$/);
        assert.equal(provider.received.length, 3, "the diagnostic does not change recovery or termination");
    } finally { await db.close(); }
});

// {§operation-results} — the ceiling cut each response, so the verdict names the ceiling: identical cut
// responses are no repetition, whether the cut left nothing to admit or cut inside an operation (#1453).
for (const [shape, content, calls] of [["before any text", "", 3], ["inside an operation", "await plurnk.read({\"path\":\"src/a", 3]] as const) {
    test(`{§operation-results} {§engine-rails}: responses the output allowance cut ${shape} cross as the allowance, never a cycle`, async () => {
        const { db, engine, workspaceId, sessionId, loopId } = await setup();
        try {
            const cut: MockResponse = { assistant: { content, reasoning: "Considering the next step.", finishReason: "length" }, assistantRaw: null };
            const provider = new Mock({ contextWindow: 100_000, responses: Array.from({ length: calls }, () => cut) });
            const loop = await engine.runLoop({
                provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 3,
                messages: [{ role: "user", content: "What is two plus two?" }],
            });
            const problem = problemOf(loop);
            assert.equal(loop.result.status, 500, "a strike threshold, never Loop Detected");
            assert.equal(problem.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
            assert.match(problem.detail as string, /its last emission was truncated at the output allowance \(\d+ tokens\)\.$/,
                "the terminal names the ceiling and its grant");
            assert.equal(provider.received.length, calls, "a cut still strikes: the threshold ends the loop on the third cut turn");
        } finally { await db.close(); }
    });
}

test("{§engine-rails}: a threshold crossed by failed operations still says operations failed", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // A READ of a session that does not exist is a hard operation failure, three turns running.
        const bad = said("await plurnk.read({\"path\":\"session://nobody/1\"});");
        const provider = new Mock({ contextWindow: 100_000, responses: [bad, bad, bad] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.ok(loop.result.status === 500 || loop.result.status === 508, "a rail crossing, by whichever source");
        assert.doesNotMatch(
            problem.detail as string,
            /performed no operation/,
            "turns that attempted operations are not reported as turns that attempted none",
        );
        assert.ok(!("unconcluded" in problem), "operations ran, so nothing was left unconcluded");
    } finally { await db.close(); }
});

test("{§outside-text}: the citation reaches the parent, the reader best placed to judge it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `terminal-parent-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "lead");
        const parentLoop = await insertLoop(db, parent, 1, "Have the reviewer look at the draft.");
        const child = await insertSession(db, workspaceId, parent, "reviewer");
        const childLoop = await insertLoop(db, child, 1, "Review the draft.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        // The child answers in prose three times and never fences: the rail rules it over.
        await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                said("Reading the draft now."),
                said("A few notes are forming."),
                said("The draft is sound but the second section drifts."),
            ] }),
            workspaceId, sessionId: child, loopId: childLoop, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "Review the draft." }],
        });

        const turn = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "await plurnk.note({\"text\":\"checking\"});", reasoning: null } }] }),
            messages: [], workspaceId, sessionId: parent, loopId: parentLoop,
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
        const observed = logEntries(packet).find(({ source, path }) => source === "session://reviewer" && path === "ops://reviewer/1");
        assert.ok(observed !== undefined, "the child's termination reaches its parent");

        const rendered = JSON.stringify(observed);
        assert.match(rendered, /ops:\/\/reviewer\/1\/4/, "the parent is handed the address of what the child last said");
        assert.doesNotMatch(rendered, /the second section drifts/, "cited, never embedded: the child's words do not ride into the parent's packet");
    } finally { await db.close(); }
});

test("{§outside-text}: an empty completion reply resolves the message without replacing the earlier answer", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [said("await plurnk.send({\"text\":\"The answer is four.\"});"), said("await plurnk.done({});")] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        assert.equal(loop.result.status, 200, "{§message-completion} resolves the request before the rail can rule");
        const answer = await clientRead(engine, db, { workspaceId, sessionId, statement: statement("await plurnk.read({\"path\":\"ops://alice/1\"});") });
        assert.ok("content" in answer);
        assert.equal(answer.content, "The answer is four.", "and the loop's own address is the answer, not a citation");
    } finally { await db.close(); }
});
});

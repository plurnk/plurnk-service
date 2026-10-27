import assert from "node:assert/strict";
import test, { describe } from "node:test";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type ProviderAccounting, type ProviderRequestAccounting, type MockResponse } from "@plurnk/plurnk-providers";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, holdChild } from "./_db.ts";
import { packetSection, logEntries } from "./_packet.ts";
import { testExecutors } from "./_execs.ts";
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

describe("Engine.interstitial-fence", () => {
const FENCE = "`".repeat(4);

const memory = PlurnkParser.frame("NOTE", "Examples reviewed.");

const engineRun = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, sessionId: number, loopId: number, content: string, prompt: string) =>
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }),
        workspaceId, sessionId, loopId, maxTurns: 3, maxStrikes: 3, messages: [{ role: "user", content: prompt }],
    });

// {§fence-pairing} — an unlabeled fence quotes: an operation inside it is shown, never run. A wider
// SEND holds the same example as body ({§operation-fences}).
test("{§fence-pairing}: an operation inside an unlabeled fence never runs, and a wider SEND quotes one", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interstitial-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Show the examples.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/quoted.md", content: "Keep this one too." });
        const source = [
            "An unlabeled fence quotes the operation inside it:",
            "```\n```KILL (workspace:///notes.md)```\n```",
            "A wider SEND quotes one too:",
            "````SEND\n```KILL (workspace:///quoted.md)```\n````",
            memory,
        ].join("\n\n");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: source, reasoning: null } },
                { assistant: { content: PlurnkParser.frame("SEND [200]", null), reasoning: null } },
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
        assert.deepEqual(model.map(({ op, status_rx }) => [op, status_rx]), [["NOTE", 200], ["SEND", 200], ["NOTE", 200]]);
        assert.match(JSON.parse(model[0].tx).body, /^An unlabeled fence quotes[\s\S]*```KILL \(workspace:\/\/\/notes\.md\)```[\s\S]*A wider SEND quotes one too:$/u,
            "the prose and its quoted KILL, one span before the SEND, are the turn's NOTE, literally ({§outside-text})");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "outside"), undefined, "beside fenced operations there is no outside source");
        assert.equal(JSON.parse(model[1].tx).body.raw, "```KILL (workspace:///quoted.md)```", "the quoted heading stayed body under the wider fence");
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, source, "/ops stays exact");
        const note = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "workspace", name: "body" });
        assert.equal(note?.content, "Keep this note.", "the quoted KILL never ran: an unlabeled fence quotes");
        const quoted = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/quoted.md", scheme: "workspace", name: "body" });
        assert.equal(quoted?.content, "Keep this one too.", "the quoted KILL never ran");
    } finally { await db.close(); }
});

test("{§outside-text} {§whitespace-contract}: an unfenced heading is never run, never outside text, and the model is told so", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `bare-heading-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Show the examples.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        const notices: Array<{ kind: string; message?: string }> = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
        const source = ["KILL (workspace:///notes.md)", PlurnkParser.frame("SEND", "Explained."), memory].join("\n\n");
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: source, reasoning: null } },
                { assistant: { content: PlurnkParser.frame("SEND [200]", null), reasoning: null } },
            ] }),
            workspaceId, sessionId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "Show the examples." }],
        });
        assert.equal(result.result.status, 200);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string }>({ turn_id: result.turnIds.at(-2)! });
        const model = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(model.map(({ op }) => op), ["SEND", "NOTE"], "the unfenced heading is not response text: never run ({§whitespace-contract})");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string }>({ session_id: sessionId });
        assert.equal(sources.some((row) => row.turn_id === result.turnIds.at(-2) && row.kind === "outside"), false, "and it is not outside text either: the turn has no outside source");
        assert.equal(JSON.parse(model[0].tx).body.raw, "Explained.", "only the authored SEND is delivered");
        assert.deepEqual(notices.filter(({ kind }) => kind === "parse_advisory").map(({ message }) => message),
            ["Unfenced `KILL` ignored."]);
        const note = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "workspace", name: "body" });
        assert.equal(note?.content, "Keep this note.");
    } finally { await db.close(); }
});

test("{§whitespace-contract}: an ignored content heading does not deny a successful reasoning operation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-and-unfenced-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Read the note.");
        const body = "The recovery marker is MARIGOLD-43.";
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: body });
        const heading = "READ (workspace:///notes.md)";
        const reasoning = PlurnkParser.frame(heading, null);
        const notices: Array<{ kind: string; message?: string }> = [];
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: heading, reasoning } },
            { assistant: { content: PlurnkParser.frame("SEND [200]", body), reasoning: null } },
        ] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "Read the note." }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 2);
        const turnId = result.turnIds.at(-2)!;
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: turnId });
        const reads = rows.filter(({ op, origin }) => op === "READ" && origin === "model");
        assert.deepEqual(reads.map(({ status_rx, rx }) => [status_rx, JSON.parse(rx).content]), [[200, body]], "the reasoning READ ran once; its unfenced repetition did not run");
        assert.deepEqual(rows.filter(({ op }) => op === "error"), [], "a valid reasoning operation prevents a no-operation strike");
        assert.deepEqual(notices.filter(({ kind }) => kind === "parse_advisory").map(({ message }) => message), ["Unfenced `READ` ignored."]);
        const next = JSON.stringify(provider.received[1]);
        assert.ok(next.includes(body), "the next request contains the successful result");
        assert.ok(next.includes("Unfenced `READ` ignored."), "the same request identifies only the ignored fragment");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, heading);
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
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: PlurnkParser.frame("SEND [200]", answer), reasoning: "simple question" } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice) });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 3, maxStrikes: 3,
            messages: [{ role: "user", content: "How do I run the tests?" }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 1, "one model turn: the answer");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: result.turnIds.at(-1)! });
        const completions = rows.filter(({ origin, op }) => origin === "model" && op === "SEND");
        assert.deepEqual(completions.map(({ status_rx }) => status_rx), [200]);
        assert.equal(JSON.parse(completions[0].tx).body.raw, answer, "the exact SEND body is the reply");
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
        const answer = "An operation opens with three backticks:\n\n```text\n```READ (notes.md)\n```\n```";
        const result = await engineRun(db, workspaceId, sessionId, loopId,
            PlurnkParser.frame("SEND", answer) + "\n\n" + PlurnkParser.frame("SEND [200]", null), "How do I read a file?");
        assert.equal(result.result.status, 200);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds.at(-1)! });
        const send = rows.find(({ origin, op }) => origin === "model" && op === "SEND");
        assert.equal(JSON.parse(send!.tx).body.raw, answer, "the SEND body retains the nested example");
        assert.equal(rows.filter(({ origin, op }) => origin === "model" && op === "READ").length, 0, "the quoted example never ran");
    } finally { await db.close(); }
});

// {§outside-text} {§turn-source-resources}
for (const [label, content, finishReason] of [
    ["an operation heading outside a fence", "Let me check.\n\nREAD (workspace:///notes.md)", "stop"],
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
                { assistant: { content: "````SEND [200]\nDone.\n````", reasoning: null } },
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
                .filter(({ origin, op, scheme }) => origin === "_plurnk" && op === "READ" && scheme === "reasoning");
            assert.deepEqual(readBack, [], "no separate read-back turn is manufactured after an empty turn");
            const answer = await db.test_get_turn.get<{ packet: string }>({ id: result.turnIds.at(-1)! });
            const errors = JSON.parse(packetSection(JSON.parse(answer!.packet), "errors") || "[]") as Array<{ status: number }>;
            assert.deepEqual(errors.map(({ status }) => status), [422], "the strike rides the next packet's errors");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds.at(-1)! });
            assert.equal(JSON.parse(rows.find(({ op, origin }) => origin === "model" && op === "SEND")!.tx).body.raw, "Done.", "the later completion reply answered");
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
        // {§fence-pairing} — native markup naming a plurnk operation is that operation, whatever the
        // family; a call naming a tool plurnk does not have is read as nothing, so its turn is empty as well as toxic.
        const toxin = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="READ">\n<｜｜DSML｜｜ parameter name="path" string="true">sh:///67f57ccd#stdout</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
        const untranslated = '<tool_call>\n{"name": "read_file", "arguments": {"path": "workspace:///notes.md"}}\n</tool_call>';
        const brokenOp = "Checking the source.\n\nREAD (workspace:///notes.md)";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: `${narration}\n\n\`\`\`\`NOTE\nplan\n\`\`\`\``, reasoning: null, finishReason: "stop" } },
            { assistant: { content: prose, reasoning: null, finishReason: "stop" } },
            { assistant: { content: toxin, reasoning: null, finishReason: "stop" } },
            { assistant: { content: untranslated, reasoning: "Read the note first.", finishReason: "stop" } },
            { assistant: { content: `${brokenOp}\n\n\`\`\`\`NOTE\nstill here\n\`\`\`\``, reasoning: null, finishReason: "stop" } },
            { assistant: { content: "````SEND [200]\nDone.\n````", reasoning: null } },
        ] });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Do the thing." }] });
        assert.equal(result.result.status, 200);
        assert.equal(result.turnIds.length, 7, "{§outside-text} no runtime read-back turn follows an empty turn");
        const [, workingTurn, proseTurn, toxinTurn, untranslatedTurn, brokenTurn] = result.turnIds;
        const rowsOf = async (turnId: number) => await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: turnId });
        const notesOf = async (turnId: number) => (await rowsOf(turnId))
            .filter(({ origin, op }) => origin === "model" && op === "NOTE").map(({ tx }) => JSON.parse(tx).body as string);
        const strikesOf = async (turnId: number) => (await rowsOf(turnId))
            .filter(({ origin, op }) => origin === "_plurnk" && op === "error").map(({ status_rx }) => status_rx);
        assert.deepEqual(
            [await strikesOf(workingTurn), await strikesOf(proseTurn), await strikesOf(toxinTurn), await strikesOf(untranslatedTurn), await strikesOf(brokenTurn)],
            [[], [422], [], [422], []],
            "{§outside-text} each empty turn carries its one error row, toxic or plain; the translated call ran, so its turn is not empty",
        );
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const outsideOf = (turnId: number) => sources.find((row) => row.turn_id === turnId && row.kind === "outside")?.content;
        assert.deepEqual(await notesOf(workingTurn), [narration, "plan"], "narration beside a real operation is the turn's NOTE at its position ({§outside-text})");
        assert.equal(outsideOf(workingTurn), undefined, "beside a fenced operation there is no outside source");
        assert.deepEqual(await notesOf(proseTurn), [], "prose alone is never a NOTE");
        assert.equal(outsideOf(proseTurn), prose, "prose is stored as the outside source when the turn fenced no operation");
        assert.equal((await rowsOf(proseTurn)).some(({ op }) => op === "SEND"), false, "storage is not message delivery");
        const following = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: toxinTurn }))!.packet);
        assert.doesNotMatch(packetSection(following, "log"), /The investigation is still in progress\./u, "the next packet never carries the text");
        assert.doesNotMatch(packetSection(following, "notices"), /outside_text/u, "the empty turn's error row is the one thing the model hears of it; no second notice");
        assert.notEqual(packetSection(following, "messages"), "[]", "the original message still needs a reply");
        assert.deepEqual(await notesOf(untranslatedTurn), []);
        assert.equal(outsideOf(untranslatedTurn), untranslated, "foreign tool-call markup is stored verbatim; nothing filters the source");
        assert.deepEqual(await notesOf(brokenTurn), ["Checking the source.", "still here"], "the narration around the unfenced heading is the turn's NOTE; the heading itself is not response text");
        assert.equal(outsideOf(brokenTurn), undefined);
        assert.equal(sources.find((row) => row.turn_id === toxinTurn && row.kind === "ops")?.content, toxin, "the exact emission stays readable at ops://");
        assert.equal(sources.find((row) => row.turn_id === untranslatedTurn && row.kind === "reasoning")?.content, "Read the note first.", "the reasoning is kept even when it is not read back");
        assert.equal(sources.find((row) => row.turn_id === proseTurn && row.kind === "ops")?.content, prose);
    } finally { await db.close(); }
});

for (const preview of ["0", "1"]) for (const finishReason of [undefined, "stop", "length"] as const) {
    test(`{§outside-text}: reasoning without operations does not resolve a request that has only progress replies (preview=${preview}, finish=${finishReason ?? "absent"})`, async (t) => {
        const previous = process.env.PLURNK_SERVICE_REASONING_ROWS;
        process.env.PLURNK_SERVICE_REASONING_ROWS = preview;
        t.after(() => { if (previous === undefined) delete process.env.PLURNK_SERVICE_REASONING_ROWS; else process.env.PLURNK_SERVICE_REASONING_ROWS = previous; });
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `reasoning-only-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "Read the note and answer.");
            await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Recorded." });
            const reasoning = "I still need to work out the next action.";
            const notices: Array<{ kind: string }> = [];
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: PlurnkParser.frame("READ (workspace:///notes.md)", "") + "\n" + PlurnkParser.frame("SEND", "Recorded."), reasoning: null } },
                { assistant: { content: "", reasoning, ...(finishReason === undefined ? {} : { finishReason }) } },
                { assistant: { content: PlurnkParser.frame("SEND [200]", null), reasoning: null } },
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
            assert.equal(JSON.parse(packetSection(JSON.parse(turn.packet), "messages")).length, 1, "the progress reply has not resolved the original message");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
            assert.equal(sources.find(({ turn_id, kind }) => turn_id === emptyTurn && kind === "reasoning")?.content, reasoning);
            const emptyRows = await db.test_log_entries_by_turn.all<{ sequence: number; attrs: string; rx: string }>({ turn_id: emptyTurn });
            const previews = emptyRows.filter(({ attrs }) => JSON.parse(attrs).kind === "reasoning");
            assert.deepEqual(previews.map(({ sequence, rx }) => [sequence, JSON.parse(rx).content]), preview === "1" ? [[1, reasoning]] : [],
                "the ordinary preview belongs to the empty turn and does not count as authored progress");
            assert.equal(notices.filter(({ kind }) => kind === "turn_no_operations").length, 0, "{§outside-text} the strike sends no notice");
            const readBack = (await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; scheme: string | null }>({ turn_id: result.turnIds[3] }))
                .filter(({ origin, op, scheme }) => origin === "_plurnk" && op === "READ" && scheme === "reasoning");
            assert.deepEqual(readBack, [], "no runtime READ follows the empty turn: its preview and source belong to that turn");
            const conclusion = await db.test_get_turn.get<{ packet: string }>({ id: result.turnIds.at(-1)! });
            const errors = JSON.parse(packetSection(JSON.parse(conclusion!.packet), "errors") || "[]") as Array<{ status: number; path: string }>;
            assert.deepEqual(errors.map(({ status, path }) => [status, path]), [[422, `log:///1/3/${preview === "1" ? 2 : 1}/error`]], "the strike rides the next packet's errors, after any reasoning row");
        } finally { await db.close(); }
    });
}

// {§outside-text} — an option a scheme does not take is dropped with one notice; the operation runs.
test("{§outside-text}: metadata on a file READ is ignored with a notice and the READ still runs", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `metadata-ignored-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Read the note.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        const notices: Array<{ kind: string; directive?: string; message?: string }> = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; directive?: string; message?: string }) });
        const source = ['````READ (workspace:///notes.md) [{"lines": "1-2"}]', "````", memory].join("\n");
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, sessionId, loopId, messages: [{ role: "user", content: "Read the note." }],
        });
        assert.deepEqual(result.outcomes.filter(({ op }) => op === "READ").map(({ op, status }) => [op, status]), [["READ", 200]], "the READ ran without its metadata");
        const notice = notices.find(({ kind }) => kind === "metadata_ignored");
        assert.ok(notice, "one metadata_ignored notice");
        assert.equal(notice.message, "READ on 'workspace' takes no [metadata]; the READ ran without it.");
        assert.equal(notice.directive, "YOU SHOULD NOT write [metadata] on an operation that takes none.", "{§diagnostic-observation}");
    } finally { await db.close(); }
});

test("{§fence-pairing}: an offset example draws no parser advisory, and does not conclude the loop", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `indented-program-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Read the note.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        const notices: Array<{ kind: string; message?: string }> = [];
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "I'll read it now.\n\n    " + FENCE + "READ (workspace:///notes.md)\n    " + FENCE, reasoning: null } },
            { assistant: { content: PlurnkParser.frame("SEND [200]", "It says: Keep this note."), reasoning: null } },
        ] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 4, maxStrikes: 3, messages: [{ role: "user", content: "Read the note." }] });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 2, "the offset example is not an answer: the model gets another turn");
        // #799: the parser presumes nothing about why a fence is offset. The turn is an empty turn
        // rather than a conclusion — proven by the second provider call above. The strike is silent
        // ({§outside-text}); the quotation remains literal in the turn's outside source ({§outside-text}).
        assert.deepEqual(notices.filter(({ kind }) => kind === "turn_no_operations"), [], "silent");
        assert.deepEqual(notices.filter(({ kind, message }) => kind !== "turn_no_operations" && /must start its line|read as prose/u.test(message ?? "")), [], "an offset example still draws no parser advisory");
        const all = await Promise.all(result.turnIds.map((id) => db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: id })));
        assert.equal(all.flat().filter(({ origin, op }) => origin === "model" && op === "READ").length, 0, "the offset example never ran");
        assert.equal(all.at(-2)!.some(({ origin, op }) => origin === "model" && op === "NOTE"), false, "the offset example is no row");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === result.turnIds.at(-2) && row.kind === "outside")?.content,
            "I'll read it now.\n\n    " + FENCE + "READ (workspace:///notes.md)\n    " + FENCE, "the offset example is retained literally, never executed");
        assert.equal(
            JSON.parse(all.at(-1)!.find(({ origin, op }) => origin === "model" && op === "SEND")!.tx).body.raw,
            "It says: Keep this note.",
            "the fenced answer concludes, stripped of its envelope",
        );
    } finally { await db.close(); }
});

// {§whitespace-contract} {§outside-text} — an executor called without its fence is a missed operation: the
// receipt rides the next packet's notices, and the turn still strikes, so three in a row end the loop (#844).
test("{§whitespace-contract} {§outside-text}: unfenced executor calls draw their receipt each turn and still strike out", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `unfenced-exec-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Build it.");
        const notices: Array<{ kind: string; message?: string }> = [];
        const provider = new Mock({ contextWindow: 100_000, responses: ["build", "test", "lint"].map((step) => (
            { assistant: { content: `Running the ${step} step.\n\nsh (${step}.sh)`, reasoning: null, finishReason: "stop" as const } }
        )) });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
        engine.setExecutors(await testExecutors());
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 6, maxStrikes: 3, messages: [{ role: "user", content: "Build it." }] });
        assert.equal(result.result.status, 500, "three empty turns cross the strike threshold");
        assert.match(JSON.stringify(result.result), /performed no operation/u, "the terminal names the source");
        assert.equal(result.turnIds.length, 4, "initialization and three empty turns; with no reasoning there is nothing to read back");
        const strikes = await Promise.all(result.turnIds.slice(1).map(async (turnId) => (await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number }>({ turn_id: turnId }))
            .filter(({ origin, op }) => origin === "_plurnk" && op === "error").map(({ status_rx }) => status_rx)));
        assert.deepEqual(strikes, [[422], [422], [422]], "{§outside-text} each strike is an error row the next packet carries");
        assert.equal(notices.filter(({ kind, message }) => kind === "parse_advisory" && message === "Unfenced `sh` ignored.").length, 3, "each turn heard its receipt");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds[1] });
        assert.equal(rows.some(({ origin, op }) => origin === "model" && op === "NOTE"), false, "the narration is no row");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        assert.equal(sources.find((row) => row.turn_id === result.turnIds[1] && row.kind === "outside")?.content,
            "Running the build step.", "only the narration is outside text, not the unfenced invocation ({§outside-text})");
    } finally { await db.close(); }
});
});

describe("Digest.programmatic", () => {
// {§digest-programmatic-surface}: the package subpath is a pure import and its
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
        op: "BARE",
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
        tx: JSON.stringify({ op: "BARE", body: "What is the capital of Germany?" }),
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

test("{§digest-programmatic-surface}: importing the public subpath performs no process or filesystem action", async () => {
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

test("{§digest-programmatic-surface}: selectors prune emitted evidence and each selection writes its own folder", async () => {
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
        a1 = await seedSessionEvidence(db, workspaceA, "a1", 1, "READ");
        await seedBareEvidence(db, a1);
        a2 = await seedSessionEvidence(db, workspaceA, "a2", 2, "EDIT");
        b1 = await seedSessionEvidence(db, workspaceB, "b1", 3, "COPY");
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
        // {§digest-programmatic-surface}: a turn line names its own artifact and the model's own
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
        assert.match(session.markdown, /Op mix:\s+BARE=1 READ=1/);
        assert.match(
            session.markdown,
            /^Owner: _plurnk$/mu,
            "the digest projects durable session ownership",
        );
        assert.doesNotMatch(session.markdown, /\[object Object\]/u);
        assert.match(session.reasoning, /reason-a1/);
        assert.doesNotMatch(`${JSON.stringify(session.json)}${session.markdown}${session.reasoning}`, /(?:prompt|reason)-(?:a2|b1)/);
        assert.doesNotMatch(session.markdown, /(?:\$0\.002000|\$0\.003000|Op mix:\s+(?:EDIT|COPY)=1)/);
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
        assert.match(workspace.markdown, /Op mix:\s+BARE=1 READ=1/);
        assert.match(workspace.markdown, /Op mix:\s+EDIT=1/);
        assert.match(workspace.markdown, /Cost:\s+\$0\.002 \+ \? \(incomplete\) \(charged\)/);
        assert.doesNotMatch(`${JSON.stringify(workspace.json)}${workspace.markdown}${workspace.reasoning}`, /(?:prompt|reason)-b1/);
        assert.doesNotMatch(workspace.markdown, /(?:\$0\.003000|Op mix:\s+COPY=1)/);
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
const NOTICE = "> [!WARNING]\n> YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn. The turn continued without a NOTE. [continued_without_note]";

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
            const expectedNotes = [
                ...(reasoningNote ? ["Kept from reasoning."] : []),
                ...(contentNote ? ["Kept from content."] : []),
            ];
            const operation = parked ? "```WAIT\n```" : "```FIND (workspace:///*)\n```";
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: {
                    content: `${contentNote ? "```NOTE\nKept from content.\n```\n\n" : ""}${operation}`,
                    reasoning: reasoningNote ? "```NOTE\nKept from reasoning.\n```" : null,
                } },
                { assistant: { content: "```SEND [200]\nDone.\n```", reasoning: null } },
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
            assert.equal(await noticesOf(db, final.turnId), location === "absent" ? NOTICE : "",
                location === "absent" ? "the turn after a continuing or parked turn with no NOTE is told so, once" : "a NOTE in the program or from reasoning carries the turn forward");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
            assert.deepEqual(sources.filter(({ turn_id, kind }) => turn_id === first.turnId && kind === "note").map(({ content }) => content),
                expectedNotes, "only authored memory persists, in reasoning then content order");
            for (const turn of [first, final]) {
                assert.ok((await rowsOf(db, turn.turnId)).every(({ op }) => op !== "error"), "valid work produces no failure receipt");
            }
        } finally { await db.close(); }
    });
}

test("{§outside-text} {§operation-results}: an operation-free response keeps its failure receipt and takes no notice", async () => {
    const db = await openMigrated();
    try {
        const result = await runLoop(db, [
            { content: "Still thinking about it.", reasoning: null },
            { content: "```SEND [200]\nDone.\n```", reasoning: null },
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
            "Thinking out loud first.\n\n```FIND (workspace:///*)\n```\n\nBetween the two.\n\n```FIND (workspace:///*)\n```\n\nAnd a trailing remark.",
            "```SEND [200]\nDone.\n```",
        ].map((content) => ({ assistant: { content, reasoning: null, finishReason: "stop" } })) });
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
        });
        assert.equal(result.result.status, 200, JSON.stringify(result.result));
        const [, prosed, final] = result.turnIds;
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: prosed });
        const notes = rows.filter(({ op, origin }) => op === "NOTE" && origin === "model").map(({ tx }) => (JSON.parse(tx) as { body: string }).body);
        assert.deepEqual(notes, ["Thinking out loud first.", "Between the two.", "And a trailing remark."], "each span is one NOTE row, in source order");
        assert.ok(!rows.some(({ op, origin }) => op === "error" && origin === "_plurnk"), "no error row");
        const packet = JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: final }))!.packet) as { sections: Parameters<typeof PacketWire.renderSlot>[0] };
        assert.equal(packetSection(packet, "notices"), "", "no outside-text and no missing-NOTE notice");
        const user = PacketWire.renderSlot(packet.sections, "user");
        assert.equal([...user.matchAll(/^### log:\/\/\/1\/2\/\d+\/NOTE · \d+/gmu)].length, 3, "each annotation retains its own receipt");
        assert.doesNotMatch(user, /Thinking out loud|Between the two|And a trailing remark/u, "receipts do not duplicate the annotations");
        const assistant = PacketWire.renderSlot(packet.sections, "assistant");
        assert.match(assistant, /```NOTE\nThinking out loud first\.\n```[\s\S]*```NOTE\nBetween the two\.\n```[\s\S]*```NOTE\nAnd a trailing remark\.\n```/u, `the replay carries them as NOTE fences:\n${assistant}`);
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
            statement: statement(`\`\`\`\`READ (${problem.unconcluded as string})\`\`\`\``),
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
            said("````NOTE\nchecked\n````"),
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
            said("````NOTE\nworking\n````"),
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
// responses are no repetition, whether the cut left nothing to admit or exhausted every emission attempt.
for (const [shape, content, calls] of [["before any text", "", 3], ["inside an operation", "````READ (src/a", 9]] as const) {
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
        const bad = said("````READ (session://nobody/1)````");
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
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````NOTE\nchecking\n````", reasoning: null } }] }),
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
        const provider = new Mock({ contextWindow: 100_000, responses: [said("````SEND\nThe answer is four.\n````"), said("````SEND [200]\n````")] });
        const loop = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        assert.equal(loop.result.status, 200, "{§message-completion} resolves the request before the rail can rule");
        const answer = await clientRead(engine, db, { workspaceId, sessionId, statement: statement("````READ (ops://alice/1)````") });
        assert.ok("content" in answer);
        assert.equal(answer.content, "The answer is four.", "and the loop's own address is the answer, not a citation");
    } finally { await db.close(); }
});
});

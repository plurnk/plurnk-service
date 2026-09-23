import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection, seedEntryWithChannel } from "./_helpers.ts";
const FENCE = "`".repeat(4);

const memory = PlurnkParser.frame("NOTE", "Examples reviewed.");

const engineRun = async (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number, workerId: number, loopId: number, content: string, prompt: string) =>
    await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }),
        workspaceId, workerId, loopId, maxTurns: 3, maxStrikes: 3, messages: [{ role: "user", content: prompt }],
    });

// {§quotation} — an unlabeled fence quotes: an operation inside it is shown, never run. A delimited
// SEND quotes the same way ({§numeric-delimiter}).
test("{§quotation}: an operation inside an unlabeled fence never runs, and a delimited SEND quotes one", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interstitial-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Show the examples.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/quoted.md", content: "Keep this one too." });
        const source = [
            "An unlabeled fence quotes the operation inside it:",
            "```\n````KILL (worker:///notes.md)````\n```",
            "A delimited SEND quotes one too:",
            "````42SEND\n````KILL (worker:///quoted.md)````\n````42",
            memory,
        ].join("\n\n");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: source, reasoning: null } },
                { assistant: { content: PlurnkParser.frame("KILL", null), reasoning: null } },
            ] }),
            workspaceId, workerId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "Show the examples." }],
        });
        assert.equal(result.result.status, 200);
        const turnId = result.turnIds.at(-2)!;
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: turnId });
        const model = rows.filter(({ origin, op }) => origin === "model" && op !== null);
        assert.deepEqual(model.map(({ op, status_rx }) => [op, status_rx]), [["NOTE", 200], ["SEND", 200], ["NOTE", 200]]);
        assert.match(JSON.parse(model[0]!.tx).body, /^An unlabeled fence quotes[\s\S]*````KILL \(worker:\/\/\/notes\.md\)````/u,
            "the prose and its quoted KILL are kept literally as the model's NOTE");
        assert.equal(JSON.parse(model[1]!.tx).body.raw, "````KILL (worker:///quoted.md)````", "the quoted heading stayed body under the delimiter");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, source, "/ops stays exact");
        const note = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "worker", name: "body" });
        assert.equal(note?.content, "Keep this note.", "the quoted KILL never ran: an unlabeled fence quotes");
        const quoted = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/quoted.md", scheme: "worker", name: "body" });
        assert.equal(quoted?.content, "Keep this one too.", "the quoted KILL never ran");
    } finally { await db.close(); }
});

test("{§response-text-note} {§unfenced-operation}: an unfenced heading is never run, never a NOTE, and the model is told so", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `bare-heading-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Show the examples.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        const notices: Array<{ kind: string; message?: string }> = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
        const source = ["KILL (worker:///notes.md)", PlurnkParser.frame("SEND", "Explained."), memory].join("\n\n");
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: source, reasoning: null } },
                { assistant: { content: PlurnkParser.frame("KILL", null), reasoning: null } },
            ] }),
            workspaceId, workerId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "Show the examples." }],
        });
        assert.equal(result.result.status, 200);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; origin: string; tx: string }>({ turn_id: result.turnIds.at(-2)! });
        const model = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(model.map(({ op }) => op), ["SEND", "NOTE"], "the unfenced heading is not response text: never run, never a NOTE ({§unfenced-operation})");
        assert.equal(JSON.parse(model[0]!.tx).body.raw, "Explained.", "only the authored SEND is delivered");
        assert.deepEqual(notices.filter(({ kind }) => kind === "parse_advisory").map(({ message }) => message),
            ["`KILL` has no fence, so it did not run."]);
        const note = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "worker", name: "body" });
        assert.equal(note?.content, "Keep this note.");
    } finally { await db.close(); }
});

test("{§kill-conclusion}: an explicit KILL, code block and all, answers the open message and concludes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `send-conclusion-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "How do I run the tests?");
        const answer = "The runner is configured in the package root:\n\n```ts\nexport default { timeout: 30_000 };\n```\n\nIt takes about a minute.";
        const notices: Array<{ kind: string }> = [];
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "\n" + FENCE + "KILL\n" + answer + "\n" + FENCE + "\n", reasoning: "simple question" } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string }) });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 3, maxStrikes: 3,
            messages: [{ role: "user", content: "How do I run the tests?" }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 1, "one model turn: the answer");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: result.turnIds.at(-1)! });
        const completions = rows.filter(({ origin, op }) => origin === "model" && op === "KILL");
        assert.deepEqual(completions.map(({ status_rx }) => status_rx), [200]);
        assert.equal(JSON.parse(completions[0]!.tx).body, answer, "the exact KILL body is the reply");
        assert.equal(notices.filter(({ kind }) => kind === "turn_no_operations").length, 0, "an answer is not an empty turn");
        const rail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: loopId });
        assert.equal(rail?.strike_streak, 0);
    } finally { await db.close(); }
});

test("{§quotation}: a SEND with nested examples delivers its literal body", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `nested-reply-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "How do I read a file?");
        const answer = "An operation opens with four backticks:\n\n```text\n````READ (notes.md)\n````\n```";
        const result = await engineRun(db, workspaceId, workerId, loopId,
            PlurnkParser.frame("SEND", answer) + "\n\n" + PlurnkParser.frame("KILL", null), "How do I read a file?");
        assert.equal(result.result.status, 200);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds.at(-1)! });
        const send = rows.find(({ origin, op }) => origin === "model" && op === "SEND");
        assert.equal(JSON.parse(send!.tx).body.raw, answer, "the SEND body retains the nested example");
        assert.equal(rows.filter(({ origin, op }) => origin === "model" && op === "READ").length, 0, "the quoted example never ran");
    } finally { await db.close(); }
});

// {§empty-turn} — an operation attempt that did not parse, or prose cut at the allowance, is not an
// answer: it is admitted as an empty turn — kept, noticed, struck once — and the loop continues.
for (const [label, content, finishReason] of [
    ["an operation heading outside a fence", "Let me check.\n\nREAD (worker:///notes.md)", "stop"],
    ["prose cut at the output allowance", "The findings give me precise integration points. Now I'll", "length"],
] as const) {
    test(`{§empty-turn}: ${label} is a silent empty turn with one strike, never an answer`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `empty-turn-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Do the thing.");
            const notices: Array<{ kind: string }> = [];
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content, reasoning: "thinking about it", finishReason } },
                { assistant: { content: "````KILL\nDone.\n````", reasoning: null } },
            ] });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string }) });
            const result = await engine.runLoop({
                provider, workspaceId, workerId, loopId, maxTurns: 4, maxStrikes: 3,
                messages: [{ role: "user", content: "Do the thing." }],
            });
            assert.equal(result.result.status, 200);
            assert.equal(result.turnIds.length, 3, "initialization, the empty turn, the answer: no private resample");
            const emptyTurn = result.turnIds[1]!;
            const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: emptyTurn });
            assert.deepEqual(attempts.map(({ accepted }) => accepted), [1], "admitted on its only attempt");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
            assert.equal(sources.find((row) => row.turn_id === emptyTurn && row.kind === "ops")?.content, content);
            assert.deepEqual(notices.filter(({ kind }) => kind === "turn_no_operations"), [], "{§empty-turn} the strike is silent");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds.at(-1)! });
            assert.equal(JSON.parse(rows.find(({ op, origin }) => origin === "model" && op === "KILL")!.tx).body, "Done.", "the later KILL answered");
            const rail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: loopId });
            assert.equal(rail?.strike_streak, 0, "the answer cleared the streak the empty turn earned");
        } finally { await db.close(); }
    });
}

test("{§response-text-note}: storing interstitial text is a privilege of a working turn, and only narration earns it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interstitial-privilege-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Do the thing.");
        const narration = "Let me look at the failing test first.";
        const toxin = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="READ">\n<｜｜DSML｜｜ parameter name="path" string="true">sh:///67f57ccd#stdout</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
        const brokenOp = "Checking the source.\n\nREAD (worker:///notes.md)";
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: `${narration}\n\n\`\`\`\`NOTE\nplan\n\`\`\`\``, reasoning: null, finishReason: "stop" } },
            { assistant: { content: narration, reasoning: null, finishReason: "stop" } },
            { assistant: { content: toxin, reasoning: null, finishReason: "stop" } },
            { assistant: { content: `${brokenOp}\n\n\`\`\`\`NOTE\nstill here\n\`\`\`\``, reasoning: null, finishReason: "stop" } },
            { assistant: { content: "````KILL\nDone.\n````", reasoning: null } },
        ] });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Do the thing." }] });
        assert.equal(result.result.status, 200);
        const [, workingTurn, proseTurn, toxinTurn, brokenTurn] = result.turnIds;
        const notesOf = async (turnId: number) => (await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: turnId }))
            .filter(({ origin, op }) => origin === "model" && op === "NOTE").map(({ tx }) => JSON.parse(tx).body as string);
        assert.deepEqual(await notesOf(workingTurn!), [narration, "plan"], "narration beside a real operation is the model's NOTE, in source order");
        assert.deepEqual(await notesOf(proseTurn!), [], "an empty turn earns no NOTE, however plain its prose");
        assert.deepEqual(await notesOf(toxinTurn!), [], "a foreign tool-call grammar retains nothing");
        assert.deepEqual(await notesOf(brokenTurn!), ["Checking the source.", "still here"], "the unfenced heading is not response text, the narration around it is, and the fenced NOTE stays");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.equal(sources.find((row) => row.turn_id === toxinTurn && row.kind === "ops")?.content, toxin, "the exact emission stays readable at ops://");
        assert.equal(sources.find((row) => row.turn_id === proseTurn && row.kind === "ops")?.content, narration);
    } finally { await db.close(); }
});

for (const finishReason of [undefined, "stop", "length"] as const) {
    test(`{§empty-turn}: reasoning without operations does not conclude settled work (finish=${finishReason ?? "absent"})`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `reasoning-only-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Read the note and answer.");
            await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Recorded." });
            const reasoning = "I still need to work out the next action.";
            const notices: Array<{ kind: string }> = [];
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: PlurnkParser.frame("READ (worker:///notes.md)", "") + "\n" + PlurnkParser.frame("SEND", "Recorded."), reasoning: null } },
                { assistant: { content: "", reasoning, ...(finishReason === undefined ? {} : { finishReason }) } },
                { assistant: { content: PlurnkParser.frame("KILL", null), reasoning: null } },
            ] });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string }) });
            const result = await engine.runLoop({
                provider, workspaceId, workerId, loopId, maxTurns: 4, maxStrikes: 3,
                messages: [{ role: "user", content: "Read the note and answer." }],
            });
            assert.equal(result.result.status, 200);
            assert.equal(provider.received.length, 3, "the empty turn does not infer completion; a recovery request follows");
            const emptyTurn = result.turnIds[2]!;
            const turn = await db.test_get_turn.get<{ status: number; packet: string }>({ id: emptyTurn });
            assert.equal(turn?.status, 102);
            assert.equal(packetSection(JSON.parse(turn!.packet), "messages"), "[]", "the original message is already answered");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
            assert.equal(sources.find(({ turn_id, kind }) => turn_id === emptyTurn && kind === "reasoning")?.content, reasoning);
            assert.equal(notices.filter(({ kind }) => kind === "turn_no_operations").length, 0, "{§empty-turn} the strike is silent");
        } finally { await db.close(); }
    });
}

// {§metadata-ignored} — an option a scheme does not take is dropped with one notice; the operation runs.
test("{§metadata-ignored}: metadata on a file READ is ignored with a notice and the READ still runs", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `metadata-ignored-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Read the note.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        const notices: Array<{ kind: string; message?: string }> = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
        const source = ['````READ (worker:///notes.md) [{"lines": "1-2"}]', "````", memory].join("\n");
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, messages: [{ role: "user", content: "Read the note." }],
        });
        assert.deepEqual(result.outcomes.filter(({ op }) => op === "READ").map(({ op, status }) => [op, status]), [["READ", 200]], "the READ ran without its metadata");
        const notice = notices.find(({ kind }) => kind === "metadata_ignored");
        assert.ok(notice, "one metadata_ignored notice");
        assert.equal(notice.message, "READ on 'worker' takes no [metadata]; the READ ran without it.");
    } finally { await db.close(); }
});

test("{§quotation}: an offset example draws no parser advisory, and does not conclude the loop", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `indented-program-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Read the note.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        const notices: Array<{ kind: string; message?: string }> = [];
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "I'll read it now.\n\n    " + FENCE + "READ (worker:///notes.md)\n    " + FENCE, reasoning: null } },
            { assistant: { content: FENCE + "KILL\nIt says: Keep this note.\n" + FENCE, reasoning: null } },
        ] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 4, maxStrikes: 3, messages: [{ role: "user", content: "Read the note." }] });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 2, "the offset example is not an answer: the model gets another turn");
        // #799: the parser presumes nothing about why a fence is offset. The turn is an empty turn
        // rather than a conclusion — proven by the second provider call above. The strike is silent
        // ({§empty-turn}); the text stays at ops:// and is not filed as a NOTE ({§response-text-note}).
        assert.deepEqual(notices.filter(({ kind }) => kind === "turn_no_operations"), [], "silent");
        assert.deepEqual(notices.filter(({ kind, message }) => kind !== "turn_no_operations" && /must start its line|read as prose/u.test(message ?? "")), [], "an offset example still draws no parser advisory");
        const all = await Promise.all(result.turnIds.map((id) => db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: id })));
        assert.equal(all.flat().filter(({ origin, op }) => origin === "model" && op === "READ").length, 0, "the offset example never ran");
        assert.deepEqual(all.at(-2)!.filter(({ origin, op }) => origin === "model" && op === "NOTE").map(({ tx }) => JSON.parse(tx).body),
            [], "an empty turn keeps no NOTE: storing interstitial text is a privilege of a working turn ({§response-text-note}); the emission stays at ops://");
        assert.equal(
            JSON.parse(all.at(-1)!.find(({ origin, op }) => origin === "model" && op === "KILL")!.tx).body,
            "It says: Keep this note.",
            "the fenced answer concludes, stripped of its envelope",
        );
    } finally { await db.close(); }
});

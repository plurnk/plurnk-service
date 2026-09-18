import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, packetSection, seedEntryWithChannel } from "./_helpers.ts";

const memory = PlurnkParser.frame("NOTE", "Examples reviewed.");

// {§interstitial-fence} — an unlabeled fence is prose and protects nothing: an operation fenced
// inside it is that operation. Quoting is a delimited SEND's job ({§numeric-delimiter}).
test("{§interstitial-fence}: an unlabeled fence is transparent; a fenced operation inside it runs, a delimited SEND quotes it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `interstitial-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Show the examples.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/quoted.md", content: "Keep this one too." });
        const source = [
            "An unlabeled fence around an operation changes nothing:",
            "```\n````KILL (worker:///notes.md)````\n```",
            "A delimited SEND is how an example is quoted:",
            "````42SEND\n````KILL (worker:///quoted.md)````\n````42",
            memory,
        ].join("\n\n");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, maxTurns: 2,
            messages: [{ role: "user", content: "Show the examples." }],
        });
        assert.equal(result.result.status, 200);
        const turnId = result.turnIds.at(-1)!;
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: turnId });
        const model = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(model.map(({ op, status_rx }) => [op, status_rx]), [["KILL", 200], ["SEND", 200], ["NOTE", 200]]);
        assert.equal(JSON.parse(model[1]!.tx).body.raw, "````KILL (worker:///quoted.md)````", "the quoted heading stayed body under the delimiter");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, source, "/ops stays exact");
        const note = await db.test_get_channel_by_pathname_scheme.get({ pathname: "/notes.md", scheme: "worker", name: "body" });
        assert.equal(note, undefined, "the fenced KILL ran; the unlabeled fence around it was prose");
        const quoted = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/quoted.md", scheme: "worker", name: "body" });
        assert.equal(quoted?.content, "Keep this one too.", "the quoted KILL never ran");
    } finally { await db.close(); }
});

// {§bare-heading-advisory} — headings outside any fence are prose; the engine delivers the
// parser's advisory as a notice on the admitted turn, and runs nothing for them.
test("{§bare-heading-advisory}: a heading outside any fence draws a parse_advisory notice on an admitted turn and never runs", async () => {
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
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, maxTurns: 2,
            messages: [{ role: "user", content: "Show the examples." }],
        });
        assert.equal(result.result.status, 200);
        const advisories = notices.filter(({ kind }) => kind === "parse_advisory");
        assert.equal(advisories.length, 1);
        assert.match(advisories[0]!.message ?? "", /^`KILL` on line 1 is outside any fence, so it is prose and nothing ran; an operation opens with ````KILL/u);
        const note = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "worker", name: "body" });
        assert.equal(note?.content, "Keep this note.");
    } finally { await db.close(); }
});

// {§prose-conclusion} — a response that is prose is the model's answer: a SEND to the open messages.
test("{§prose-conclusion}: a prose response, code block and all, answers the open message and concludes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prose-conclusion-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "How do I run the tests?");
        const answer = "The runner is configured in the package root:\n\n```ts\nexport default { timeout: 30_000 };\n```\n\nIt takes about a minute.";
        const notices: Array<{ kind: string }> = [];
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: `\n${answer}\n`, reasoning: "simple question" } }] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string }) });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 3, maxStrikes: 3,
            messages: [{ role: "user", content: "How do I run the tests?" }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 1, "one model turn: the answer");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string; status_rx: number }>({ turn_id: result.turnIds.at(-1)! });
        const sends = rows.filter(({ origin, op }) => origin === "model" && op === "SEND");
        assert.deepEqual(sends.map(({ status_rx }) => status_rx), [200]);
        assert.equal(JSON.parse(sends[0]!.tx).body.raw, answer, "the trimmed prose is the reply");
        assert.equal(notices.filter(({ kind }) => kind === "turn_no_operations").length, 0, "an answer is not an empty turn");
        const rail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: loopId });
        assert.equal(rail?.strike_streak, 0);
    } finally { await db.close(); }
});

// {§empty-turn} — an operation attempt that did not parse, or prose cut at the allowance, is not an
// answer: it is admitted as an empty turn — kept, noticed, struck once — and the loop continues.
for (const [label, content, finishReason] of [
    ["an operation heading outside a fence", "Let me check.\n\nREAD (worker:///notes.md)", "stop"],
    ["prose cut at the output allowance", "The findings give me precise integration points. Now I'll", "length"],
] as const) {
    test(`{§empty-turn}: ${label} is an empty turn with a turn_no_operations notice and one strike, never an answer`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `empty-turn-${crypto.randomUUID()}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "Do the thing.");
            const notices: Array<{ kind: string }> = [];
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content, reasoning: "thinking about it", finishReason } },
                { assistant: { content: "Done.", reasoning: null } },
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
            assert.ok(notices.some(({ kind }) => kind === "turn_no_operations"), "the packet says the turn emitted no operations");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; tx: string }>({ turn_id: result.turnIds.at(-1)! });
            assert.equal(JSON.parse(rows.find(({ op, origin }) => origin === "model" && op === "SEND")!.tx).body.raw, "Done.", "the later prose answered");
            const rail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: loopId });
            assert.equal(rail?.strike_streak, 0, "the answer cleared the streak the empty turn earned");
        } finally { await db.close(); }
    });
}

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
                { assistant: { content: memory, reasoning: null } },
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
            assert.equal(notices.filter(({ kind }) => kind === "turn_no_operations").length, 1);
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

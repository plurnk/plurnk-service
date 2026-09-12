import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";

const task = PlurnkParser.frame("TASK", '[{"content":"Show the examples.","status":"completed"}]');

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
            "````\n```KILL (worker:///notes.md)```\n````",
            "A delimited SEND is how an example is quoted:",
            "````42SEND\n````KILL (worker:///quoted.md)````\n````42",
            task,
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
        assert.deepEqual(model.map(({ op, status_rx }) => [op, status_rx]), [["KILL", 200], ["SEND", 200], ["TASK", 200]]);
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
        const source = ["KILL (worker:///notes.md)", PlurnkParser.frame("SEND", "Explained."), task].join("\n\n");
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

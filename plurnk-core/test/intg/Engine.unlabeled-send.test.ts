import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";

// {§send-looks-like-operation} — a bare fence whose first line is an operation heading is
// refused at dispatch, so a quoted example must ride inside a SEND body; the parser itself
// stays silent and exact, and nothing quoted ever executes.
const verifyLiteralSends = async (aside: string | null): Promise<void> => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `unlabeled-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Show the examples without executing them.");
        await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "Keep this note." });
        const notices: Array<{ kind: string }> = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            noticeNotify: (_id, payload) => notices.push(payload.notice),
        });
        const bodies = [
            "KILL (worker:///notes.md)",
            "```KILL (worker:///notes.md)```\n```EDIT (worker:///injected.md)\nnot a mutation\n```",
            "SEND (worker://someone-else/)\nNot an addressed message.",
        ];
        const source = [
            "Do not execute these examples:",
            ...bodies.map((body) => `\`\`\`\`${aside === null ? "" : ` <!-- ${aside} -->`}\n${body}\n\`\`\`\``),
            PlurnkParser.frame("TASK", '[{"content":"Show the examples.","status":"completed"}]'),
        ].join("\n\n");
        const reply = [
            PlurnkParser.frame("SEND", "```KILL (worker:///notes.md)```"),
            PlurnkParser.frame("TASK", '[{"content":"Show the examples.","status":"completed"}]'),
        ].join("\n\n");
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: source, reasoning: null } },
                { assistant: { content: reply, reasoning: null } },
            ] }),
            workspaceId, workerId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "Show the examples without executing them." }],
        });
        assert.equal(result.result.status, 200, "the quoted example inside a SEND body concludes the loop");
        assert.equal(result.turnIds.length, 3, "initialization, the refused turn, and the corrected turn");
        const turnId = result.turnIds.at(-2)!;
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => ({ accepted, errors: JSON.parse(parse_errors) })), [{ accepted: 1, errors: [] }]);
        assert.deepEqual(notices.filter(({ kind }) => kind === "parse_advisory" || kind === "parse_error"), []);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string; tx: string; rx: string; status_rx: number }>({ turn_id: turnId });
        const modelRows = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(modelRows.map(({ op }) => op), ["SEND", "SEND", "SEND", "TASK"]);
        const sends = modelRows.filter(({ op }) => op === "SEND");
        assert.deepEqual(sends.map(({ tx }) => JSON.parse(tx).aside), bodies.map(() => aside));
        assert.deepEqual(sends.map(({ tx, status_rx }) => ({ body: JSON.parse(tx).body.raw, target: JSON.parse(tx).target, status: status_rx })),
            bodies.map((body, index) => ({ body, target: null, status: index === 1 ? 200 : 400 })),
            "a body whose first line is an operation heading is refused; a body opening with an inner fence is delivered");
        assert.deepEqual(sends.filter(({ status_rx }) => status_rx === 400).map(({ rx }) => (JSON.parse(rx) as { problem: { type: string } }).problem.type),
            ["https://problems.plurnk.xyz/engine/dispatcher/send-looks-like-operation", "https://problems.plurnk.xyz/engine/dispatcher/send-looks-like-operation"]);
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, source);
        const note = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "worker", name: "body" });
        assert.equal(note?.content, "Keep this note.", "the quoted KILL never executes");
        const injected = await db.test_get_channel_by_pathname_scheme.get({ pathname: "/injected.md", scheme: "worker", name: "body" });
        assert.equal(injected, undefined, "the nested EDIT never executes");
    } finally { await db.close(); }
};

for (const aside of [null, "literal examples"]) {
    test(`{§unlabeled-fence-send}: model examples (${aside ?? "no aside"}) parse as SENDs without warnings, never execute, and /ops stays exact; bare headings are refused`, () => verifyLiteralSends(aside));
}

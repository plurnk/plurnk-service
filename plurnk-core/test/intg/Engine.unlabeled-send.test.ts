import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";

const verifyLiteralSends = async (annotation: string | null): Promise<void> => {
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
            ...bodies.map((body) => `\`\`\`\`${annotation === null ? "" : ` <!-- ${annotation} -->`}\n${body}\n\`\`\`\``),
            PlurnkParser.frame("TASK", '[{"content":"Show the examples.","status":"completed"}]'),
        ].join("\n\n");
        const result = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, maxTurns: 2,
            messages: [{ role: "user", content: "Show the examples without executing them." }],
        });
        assert.equal(result.result.status, 200);
        assert.equal(result.turnIds.length, 2, "initialization and one model turn; no repair turn");
        const turnId = result.turnIds.at(-1)!;
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => ({ accepted, errors: JSON.parse(parse_errors) })), [{ accepted: 1, errors: [] }]);
        assert.deepEqual(notices.filter(({ kind }) => kind === "parse_advisory" || kind === "parse_error"), []);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string; tx: string; rx: string; status_rx: number }>({ turn_id: turnId });
        const modelRows = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(modelRows.map(({ op }) => op), ["SEND", "SEND", "SEND", "TASK"]);
        const sends = modelRows.filter(({ op }) => op === "SEND");
        assert.deepEqual(sends.map(({ tx }) => JSON.parse(tx).annotation), bodies.map(() => annotation));
        assert.deepEqual(sends.map(({ tx, status_rx }) => ({ body: JSON.parse(tx).body.raw, target: JSON.parse(tx).target, status: status_rx })),
            bodies.map((body) => ({ body, target: null, status: 200 })));
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        assert.equal(sources.find((row) => row.turn_id === turnId && row.kind === "ops")?.content, source);
        const note = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "worker", name: "body" });
        assert.equal(note?.content, "Keep this note.", "the quoted KILL never executes");
        const injected = await db.test_get_channel_by_pathname_scheme.get({ pathname: "/injected.md", scheme: "worker", name: "body" });
        assert.equal(injected, undefined, "the nested EDIT never executes");
    } finally { await db.close(); }
};

for (const annotation of [null, "literal examples"]) {
    test(`{§unlabeled-fence-send}: model examples (${annotation ?? "unannotated"}) are delivered as SENDs without effects or warnings and /ops stays exact`, () => verifyLiteralSends(annotation));
}

import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { holdChild, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { packetSection } from "./_packet.ts";

type Db = Awaited<ReturnType<typeof openMigrated>>;
type Row = { op: string | null; origin: string };

// {§continued-without-note} {§notice-directive} — the card's command as the notice's directive, in callout form.
const NOTICE = "> [!WARNING]\n> YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn. The turn continued without a NOTE. [continued_without_note]";

const noticesOf = async (db: Db, turnId: number): Promise<string> =>
    packetSection(JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: turnId }))!.packet), "notices");
const rowsOf = async (db: Db, turnId: number): Promise<Row[]> => await db.test_log_entries_by_turn.all<Row>({ turn_id: turnId });

const runLoop = async (db: Db, responses: Array<{ content: string; reasoning: string | null }>) => {
    const workspaceId = await insertWorkspace(db, `note-continuity-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Look around.");
    const provider = new Mock({ contextWindow: 100_000, responses: responses.map((assistant) => ({ assistant: { ...assistant, finishReason: "stop" } })) });
    return await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider, workspaceId, workerId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
    });
};

for (const parked of [false, true]) for (const location of ["absent", "content", "reasoning", "both"]) {
    test(`{§continued-without-note} {§reasoning-operations}: ${parked ? "parked" : "continuing"} work with NOTE ${location}`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `optional-note-${parked}-${location}`);
            const workerId = await insertWorker(db, workspaceId, null, "alice");
            const loopId = await insertLoop(db, workerId, 1, "Inspect the evidence and report the result.");
            const context = { workspaceId, workerId, loopId };
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const lifecycle = new LoopLifecycle(db);
            const childLoopId = parked ? await holdChild(db, workspaceId, workerId) : null;
            const contentNote = location === "content" || location === "both";
            const reasoningNote = location === "reasoning" || location === "both";
            const expectedNotes = [
                ...(reasoningNote ? ["Kept from reasoning."] : []),
                ...(contentNote ? ["Kept from content."] : []),
            ];
            const operation = parked ? "```WAIT\n```" : "```FIND (worker:///*)\n```";
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
                assert.equal((await db.drain_claim_next_loop.get({ worker_id: workerId }))?.id, loopId);
            }
            const final = await engine.runTurn({ ...context, provider, messages: [] });
            assert.equal(final.status, 200, "the observed work and answered message settle without another note");
            assert.equal(provider.received.length, 2);
            assert.equal(await noticesOf(db, first.turnId), "", "the first model turn has no earlier model turn to report");
            assert.equal(await noticesOf(db, final.turnId), location === "absent" ? NOTICE : "",
                location === "absent" ? "the turn after a continuing or parked turn with no NOTE is told so, once" : "a NOTE in the program or from reasoning carries the turn forward");
            const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
            assert.deepEqual(sources.filter(({ turn_id, kind }) => turn_id === first.turnId && kind === "note").map(({ content }) => content),
                expectedNotes, "only authored memory persists, in reasoning then content order");
            for (const turn of [first, final]) {
                assert.ok((await rowsOf(db, turn.turnId)).every(({ op }) => op !== "error"), "valid work produces no failure receipt");
            }
        } finally { await db.close(); }
    });
}

test("{§empty-turn} {§continued-without-note}: an operation-free response keeps its failure receipt and takes no notice", async () => {
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

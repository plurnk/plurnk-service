import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Paths from "../../src/Paths.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { packetSection } from "./_packet.ts";

// {§continued-without-note} {§notice-directive} — the card's command, repeated word for word as the directive.
const COMMAND = "YOU MUST emit at least one NOTE, a summary, in every turn.";
const NOTICE = `> [!WARNING]\n> ${COMMAND} The turn continued without a NOTE. [continued_without_note]`;

type Db = Awaited<ReturnType<typeof openMigrated>>;
type Row = { op: string | null; origin: string };

// {§notice-callout}: a notices section is a list of callouts separated by a blank line.
const noticesOf = async (db: Db, turnId: number): Promise<string[]> =>
    packetSection(JSON.parse((await db.test_get_turn.get<{ packet: string }>({ id: turnId }))!.packet), "notices").split("\n\n");
const rowsOf = async (db: Db, turnId: number): Promise<Row[]> => await db.test_log_entries_by_turn.all<Row>({ turn_id: turnId });

const conversation = async (db: Db, responses: Array<{ content: string; reasoning: string | null }>) => {
    const workspaceId = await insertWorkspace(db, `note-continuity-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "Look around.");
    const provider = new Mock({ contextWindow: 100_000, responses: responses.map((assistant) => ({ assistant: { ...assistant, finishReason: "stop" } })) });
    return await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider, workspaceId, workerId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
    });
};

test("{§continued-without-note}: the directive is the card's own command, which the card states as an important callout", async () => {
    const card = await readFile(Paths.instructionsSystem, "utf8");
    assert.ok(card.includes(`> [!IMPORTANT]\n> ${COMMAND}\n`), `the card states, word for word: ${COMMAND}`);
});

test("{§continued-without-note}: a continuing turn that carried no NOTE is told so in the next packet, and only then", async () => {
    const db = await openMigrated();
    try {
        const result = await conversation(db, [
            { content: "```FIND (worker:///*)\n```", reasoning: null },
            { content: "```NOTE\nThe worker namespace is listed.\n```\n\n```FIND (worker:///*)\n```", reasoning: null },
            { content: "```FIND (worker:///*)\n```", reasoning: "Thinking.\n\n```NOTE\nKept from reasoning.\n```\n" },
            { content: "```SEND [200]\nDone.\n```", reasoning: null },
        ]);
        assert.equal(result.result.status, 200);
        const [, bare, noted, reasoned, final] = result.turnIds;
        assert.ok(!(await noticesOf(db, bare!)).includes(NOTICE), "the first model turn has no earlier model turn to report");
        assert.ok((await noticesOf(db, noted!)).includes(NOTICE), "the turn after a continuing turn with no NOTE is told so");
        assert.ok(!(await noticesOf(db, reasoned!)).includes(NOTICE), "a program NOTE carries the turn forward");
        assert.ok(!(await noticesOf(db, final!)).includes(NOTICE), "a NOTE admitted from reasoning carries the turn forward");
        assert.equal((await rowsOf(db, bare!)).some(({ origin, op }) => origin === "_plurnk" && op === "error"), false,
            "the notice is never a failure row");
    } finally { await db.close(); }
});

test("{§continued-without-note}: an empty turn keeps its own no-operation row and takes no notice", async () => {
    const db = await openMigrated();
    try {
        const result = await conversation(db, [
            { content: "Still thinking about it.", reasoning: null },
            { content: "```SEND [200]\nDone.\n```", reasoning: null },
        ]);
        assert.equal(result.result.status, 200);
        const [, empty, final] = result.turnIds;
        assert.ok((await rowsOf(db, empty!)).some(({ origin, op }) => origin === "_plurnk" && op === "error"), "the empty turn has its row");
        assert.ok(!(await noticesOf(db, final!)).includes(NOTICE), "and no NOTE notice beside it");
    } finally { await db.close(); }
});

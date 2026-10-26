import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";

// The card's NOTE examples, in the order the card teaches them.
const cardNoteAsides = async (): Promise<string[]> => [...(await readFile(new URL("../../../plurnk-contracts/plurnk.md", import.meta.url), "utf8"))
    .matchAll(/^`{3,}NOTE <!-- (.+?) -->$/gmu)].map(([, aside]) => aside);

type Db = Awaited<ReturnType<typeof openMigrated>>;
type Row = { op: string | null; origin: string; tx: string };

const rowsOf = async (db: Db, turnId: number): Promise<Row[]> => await db.test_log_entries_by_turn.all<Row>({ turn_id: turnId });

const runLoop = async (db: Db) => {
    const workspaceId = await insertWorkspace(db, `initialization-notes-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    // One workspace entry, so the workspace survey selects something.
    await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.md", channel: "body", content: "a note", mimetype: "text/markdown" });
    const loopId = await insertLoop(db, sessionId, 1, "Look around.");
    const provider = new Mock({ contextWindow: 100_000, responses: [
        { assistant: { content: "```NOTE\nReady.\n```\n\n```SEND [200]\nDone.\n```", reasoning: null, finishReason: "stop" } },
    ] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        provider, workspaceId, sessionId, loopId, maxTurns: 8, maxStrikes: 3, messages: [{ role: "user", content: "Look around." }],
    });
    return { result, sessionId };
};

const withFilesItems = async (value: string, body: (db: Db) => Promise<void>): Promise<void> => {
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = value;
    const db = await openMigrated();
    try {
        await body(db);
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
        await db.close();
    }
};

test("{§session-initialization-entry}: when the surveys run, one NOTE opens the initialization program and one closes it", async () => {
    await withFilesItems("-1", async (db) => {
        const { result, sessionId } = await runLoop(db);
        assert.equal(result.result.status, 200);
        const [initialization] = result.turnIds;
        const rows = await rowsOf(db, initialization);
        const [opening, ...rest] = rows;
        const closing = rest.pop();
        assert.deepEqual([opening?.op, opening?.origin], ["NOTE", "_plurnk"], "the opening NOTE is the first row");
        const steps = (JSON.parse(opening.tx) as { body: string }).body.split("\n");
        assert.ok(steps.length > 1 && steps.every((step, index) => step.startsWith(`${index + 1}. `)), "it is a plan in numbered steps");
        const next = steps[1].slice("2. ".length);
        assert.deepEqual([closing?.op, closing?.origin, JSON.parse(closing!.tx).body], ["NOTE", "_plurnk", next],
            "the closing NOTE is the last row, naming the plan's next step in its words");
        assert.ok(rest.length > 0 && rest.every(({ op }) => op === "FIND" || op === "READ"), "the surveys stand between them");
        const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
        const program = sources.find((row) => row.turn_id === initialization && row.kind === "ops")?.content ?? "";
        assert.ok((await cardNoteAsides()).includes("plan"), "the card teaches NOTE by labelled examples, a plan among them");
        assert.match(program, /^`{3,}NOTE <!-- plan -->\n1\. /u,
            "the recorded ops:// program begins with the plan NOTE, labelled as the card's plan example is");
        const escaped = next.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        assert.match(program.trimEnd(), new RegExp(`\\n(\`{3,})NOTE <!-- plan -->\\n${escaped}\\n\\1$`, "u"),
            "and ends with the closing NOTE, a plan of one step");
    });
});

test("{§session-initialization-entry}: with the surveys off, initialization authors no NOTE", async () => {
    await withFilesItems("0", async (db) => {
        const { result } = await runLoop(db);
        assert.equal(result.result.status, 200);
        const [initialization] = result.turnIds;
        assert.equal((await rowsOf(db, initialization)).some(({ op }) => op === "NOTE"), false, "no survey ran, so no NOTE claims one");
    });
});

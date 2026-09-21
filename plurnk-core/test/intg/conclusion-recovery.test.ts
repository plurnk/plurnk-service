// {§conclusion-recovery} — an empty turn that kept text is asked once whether that was the answer,
// and `200` alone submits it. The token releases the retained text; it never becomes the answer.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { statement } from "./reasoning-fixture.ts";

// No pre-parsed ops: the engine runs the real parser, so an unfenced reply is a real empty turn.
const said = (content: string): MockResponse => ({ assistant: { content, reasoning: null }, assistantRaw: null });

const ANSWER = "Four. Two plus two is four.";
const OFFER = "Turn contains no OPs. A final response is a `markdown` OP. Reply 200 to submit the previous turn as final.";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `recovery-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1, "What is two plus two?");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, workerId, loopId };
};

const packetOf = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) => {
    const row = await db.test_get_packet.get<{ packet: string }>({ id: turnId });
    return JSON.parse(row?.packet ?? "{}") as { sections: Array<Record<string, unknown>> };
};

const answerOf = (engine: Engine, ids: { workspaceId: number; workerId: number; loopId: number }) =>
    engine.look({ ...ids, statement: statement("````READ (ops://alice/1)````") });

test("{§conclusion-recovery}: the empty turn is offered the handshake, and `200` concludes on its retained text", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [said(ANSWER), said("200")] });
        const empty = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(empty.emptyTurn, true, "prose without the fence is an empty turn");

        const redeemed = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(
            packetSection(await packetOf(db, redeemed.turnId), "notices"),
            `* turn_no_operations: ${OFFER}`,
            "the offer reaches the model in the very next packet",
        );
        assert.equal(redeemed.emptyTurn, false, "the redeeming turn performed an operation: the answer");
        assert.equal(redeemed.status, 200, "the loop concluded");

        const answer = await answerOf(engine, { workspaceId, workerId, loopId });
        assert.ok("content" in answer);
        assert.equal(answer.content, ANSWER, "the loop answered with the text it had already written, not `200`");
    } finally { await db.close(); }
});

test("{§conclusion-recovery}: the envelope is optional — ````markdown 200 ```` redeems the same offer", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [said(ANSWER), said("````markdown\n200\n````")] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const redeemed = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(redeemed.status, 200, "an enveloped 200 is still the token, not an answer of 200");

        const answer = await answerOf(engine, { workspaceId, workerId, loopId });
        assert.ok("content" in answer);
        assert.equal(answer.content, ANSWER, "the envelope does not make `200` the answer");
    } finally { await db.close(); }
});

test("{§conclusion-recovery}: `200` with no offer standing is read as itself", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // First turn of the loop: nothing precedes it, so there is nothing to submit.
        const provider = new Mock({ contextWindow: 100_000, responses: [said("200"), said("````markdown\n200\n````")] });
        const bare = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(bare.emptyTurn, true, "an unoffered bare 200 is an ordinary empty turn");

        // That empty turn now offers the handshake — but its retained text is "200" itself, so the
        // model's enveloped 200 redeems it and submits exactly what it said.
        const next = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const answer = await answerOf(engine, { workspaceId, workerId, loopId });
        assert.equal(next.status, 200);
        assert.ok("content" in answer);
        assert.equal(answer.content, "200", "the retained text is submitted whatever it says");
    } finally { await db.close(); }
});

test("{§conclusion-recovery}: a reply that merely contains 200 redeems nothing", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [said(ANSWER), said("The status code is 200.")] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const mention = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(mention.emptyTurn, true, "a reply about 200 is prose, and prose without the fence is an empty turn");
        assert.notEqual(mention.status, 200, "the loop did not conclude");
    } finally { await db.close(); }
});

test("{§conclusion-recovery}: the offer stands for one turn — a stale `200` redeems nothing", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            said(ANSWER),
            said("````NOTE\nthinking about it\n````"),
            said("200"),
        ] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const acted = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(acted.emptyTurn, false, "the turn between them performed an operation");

        const stale = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(stale.emptyTurn, true, "the offer lapsed with the turn that acted");
        assert.notEqual(stale.status, 200, "a lapsed offer cannot be redeemed later");
    } finally { await db.close(); }
});

test("{§conclusion-recovery}: a turn that said nothing at all is offered nothing", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [said(""), said("200")] });
        const silent = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(silent.emptyTurn, true);

        const next = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(
            packetSection(await packetOf(db, next.turnId), "notices"),
            "* turn_no_operations: Turn contains no OPs. A final response is a `markdown` OP.",
            "there is nothing to submit, so the notice does not offer to submit it",
        );
        assert.equal(next.emptyTurn, true, "and `200` redeems nothing");
    } finally { await db.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, logEntries } from "./_helpers.ts";
import { statement, type Read } from "./reasoning-fixture.ts";

const next = PlurnkParser.frame("TASK", JSON.stringify([{ content: "Continue.", status: "in_progress" }]));

test("{§reasoning-initial-read}: the first model input contains initialization's complete authored rationale", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-bootstrap");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 3, "Inspect the initial program.");
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: next, reasoning: "Unrequested model reasoning." } }] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        const initial = logEntries(packet).find((row) => row.target === "reasoning:///3/1");
        assert.ok(initial);
        assert.equal(initial.origin, "_plurnk");
        // {§reasoning-initial-read} — the pattern READ plucks the NOTE: line alone; the rest of the rationale stays out of the packet.
        assert.match(String(initial.body), /^\s*2:Note: Prior reasoning can be searched with the pattern filters\.$/m);
        assert.doesNotMatch(String(initial.body), /This harness-generated turn surveys/);
        assert.doesNotMatch(String(initial.body), /Unrequested model reasoning/);
        const reads = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        assert.equal(reads.length, 1);
        assert.equal(reads[0]!.turn_seq, 1);
        assert.equal(JSON.parse(reads[0]!.rx).status, 200, "initialization performs an immediately successful ordinary READ");
        const source = await engine.look({ ...context, statement: statement(PlurnkParser.frame("READ (ops:///3/1) <1,-1>", null)) });
        assert.ok("content" in source && typeof source.content === "string");
        assert.match(source.content, /READ \(reasoning:\/\/\/3\/1\)/);
        assert.match(source.content, /READ \(ops:\/\/\/3\/1\)/);
        assert.doesNotMatch(source.content, /READ \(prompt:\/\//, "the prompt arrives as its row, never as a second READ");
        assert.equal(provider.received.length, 1, "the harness rationale costs no model inference");
    } finally { await db.close(); }
});

test("{§reasoning-history}: a model READ of its own reasoning settles in that turn and is retained for the next request", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-current");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const read = PlurnkParser.frame("READ (reasoning:///1/2) <2,2> <!-- retain this determination -->", null);
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: `${read}\n\n${next}`, reasoning: "first\nselected reasoning\nlast" } },
            { assistant: { content: next, reasoning: "Not requested." } },
        ] });
        const produced = await engine.runTurn({ ...context, provider, messages: [] });
        const before = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        const observation = before.find(({ pathname }) => pathname === "/1/2");
        assert.ok(observation);
        assert.equal(observation.turn_id, produced.turnId);
        const result = JSON.parse(observation.rx);
        assert.equal(result.status, 200, "the READ is complete before any later model turn exists");
        assert.equal(result.content, "selected reasoning");
        assert.deepEqual(result, await engine.look({ ...context, statement: statement(read) }));
        const firstPacket = (await db.test_get_packet.get<{ packet: string }>({ id: produced.turnId }))!.packet;
        const observed = await engine.runTurn({ ...context, provider, messages: [] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: observed.turnId }))!.packet);
        const receipt = logEntries(packet).find((row) => row.target === "reasoning:///1/2");
        assert.ok(receipt);
        assert.equal(receipt.aside, "retain this determination");
        assert.match(String(receipt.body), /selected reasoning/);
        assert.deepEqual(await db.test_reasoning_reads.all<Read>({ worker_id: workerId }), before, "later inference neither adds nor updates reasoning READs");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: produced.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
        const absent = await engine.dispatch({ ...context, turnId: observed.turnId, sequence: 50, origin: "model",
            statement: statement(PlurnkParser.frame("READ (reasoning:///1/4) <1,-1>", null)),
        });
        assert.equal(absent.status, 404, "future coordinates do not create acquisition obligations");
        assert.equal(absent.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/entry-not-found");
    } finally { await db.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { logEntries } from "./_packet.ts";
import { statement, type Read } from "./reasoning-fixture.ts";

const next = PlurnkParser.frame("NOTE", "Continue.");

test("{§worker-initialization-entry}: initialization is an ordinary `_plurnk` operation turn — its survey runs as a program, authors no reasoning, and fabricates no emission", async () => {
    const db = await openMigrated();
    const priorFiles = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        const workspaceId = await insertWorkspace(db, "ops-bootstrap");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 3, "Inspect the initial program.");
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: next, reasoning: "Unrequested model reasoning." } }] });
        const result = await engine.runTurn({ ...context, provider, messages: [] });
        assert.equal(result.status, 102, "the initialization NOTE does not change implicit continuation");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        assert.equal(logEntries(packet).find((row) => row.path === "reasoning://alice/3/1"), undefined, "no reasoning is authored, so nothing reads it back");
        assert.deepEqual(await db.test_reasoning_reads.all<Read>({ worker_id: workerId }), [], "initialization performs no reasoning READ");
        const reasoning = await engine.look({ ...context, statement: statement(PlurnkParser.frame("READ (reasoning://alice/3/1) <1,-1>", null)) });
        assert.equal(reasoning.status, 204, "the initialization turn has no reasoning source");
        const program = await engine.look({ ...context, statement: statement(PlurnkParser.frame("READ (ops://alice/3/1) <1,-1>", null)) });
        assert.equal(program.status, 200, "the survey is the turn's ops source, the program that ran");
        assert.ok("content" in program && typeof program.content === "string");
        const orientation = "This turn surveys tooling and environment.";
        const operations = PlurnkParser.parseStatements(program.content).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(operations[0]?.op, "NOTE");
        assert.equal(operations[0]?.op === "NOTE" ? operations[0].body : null, orientation);
        assert.ok(operations.some(({ op }) => op === "FIND"));
        assert.ok(!operations.some(({ op, target }) => op === "READ" && target?.raw.startsWith("reasoning://")), "no READ of its own reasoning");
        assert.doesNotMatch(program.content, /READ \(prompt:\/\//, "the prompt arrives as its row, never as a second READ");
        assert.deepEqual(provider.received[0]!.filter(({ role }) => role === "assistant"), [], "the survey never masquerades as a content emission");
        const notes = logEntries(packet).filter((row) => /^log:\/\/\/3\/1\/\d+\/NOTE$/.test(String(row.logPath)));
        assert.deepEqual(notes.map((row) => row.resource), ["note://alice/3/1/1"]);
        for (const note of notes) {
            assert.equal(note.origin, "_plurnk");
            assert.equal(String(note.body).trim(), `1:${orientation}`);
            const retained = await engine.look({ ...context, statement: statement(PlurnkParser.frame(`READ (${note.resource}) <1,-1>`, null)) });
            assert.equal(retained.status, 200);
            assert.equal(retained.content, orientation);
        }
        assert.equal(provider.received.length, 1, "the survey costs no model inference");
    } finally {
        await db.close();
        if (priorFiles === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = priorFiles;
    }
});

test("{§reasoning-history}: a model READ of its own reasoning settles in that turn and is retained for the next request", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-current");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const context = { workspaceId, workerId, loopId };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const read = PlurnkParser.frame("READ (reasoning://alice/1/2) <2,2> <!-- retain this determination -->", null);
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
        const receipt = logEntries(packet).find((row) => row.path === "reasoning://alice/1/2");
        assert.ok(receipt);
        assert.equal(receipt.aside, "retain this determination");
        assert.match(String(receipt.body), /selected reasoning/);
        assert.deepEqual(await db.test_reasoning_reads.all<Read>({ worker_id: workerId }), before, "later inference neither adds nor updates reasoning READs");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: produced.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
        const absent = await engine.dispatch({ ...context, turnId: observed.turnId, sequence: 50, origin: "model",
            statement: statement(PlurnkParser.frame("READ (reasoning://alice/1/4) <1,-1>", null)),
        });
        assert.equal(absent.status, 404, "future coordinates do not create acquisition obligations");
        assert.equal(absent.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/entry-not-found");
    } finally { await db.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, logEntries } from "./_helpers.ts";
import { providerWithCapacity, statement, type Read, type Resource } from "./reasoning-fixture.ts";

const task = PlurnkParser.frame("TASK", JSON.stringify([{ content: "Review the result.", status: "in_progress" }]));

for (const mode of ["fits", "overflow"] as const) test(`{§reasoning-history}: an explicit ${mode} reasoning READ uses ordinary output admission`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-budget-${mode}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId, messages: [] };
        const reasoning = Array.from({ length: 120 }, (_, index) => `Finding ${index + 1}: ${"evidence ".repeat(mode === "overflow" ? 100 : 2)}`).join("\n");
        const first = await engine.runTurn({ ...context, provider: providerWithCapacity(999_000, [
            { assistant: { content: `${PlurnkParser.frame("READ (reasoning:///1/2) <1,-1> <!-- retain reasoning -->", null)}\n\n${task}`, reasoning } },
        ]) });
        const initial = (await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).find(({ pathname }) => pathname === "/1/2")!;
        assert.equal(initial.turn_seq, 2);
        assert.equal(JSON.parse(initial.rx).content, reasoning);
        assert.deepEqual(JSON.parse(initial.lineMarker), { marks: [1, -1] }, "an explicit READ never substitutes a smaller scope");
        const firstPacket = (await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet;
        const capacity = mode === "fits" ? 999_000 : 20_000;
        const provider = providerWithCapacity(capacity, [
            { assistant: { content: task, reasoning: "This later source is not requested." } },
            { assistant: { content: task, reasoning: null } },
        ]);
        const next = await engine.runTurn({ ...context, provider });
        assert.equal(next.status, 102);
        assert.equal(next.createdTurnIds.length, 1);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const record = logEntries(packet).find(({ target }) => target === "reasoning:///1/2")!;
        assert.ok(record);
        assert.equal(record.annotation, "retain reasoning");
        if (mode === "fits") {
            assert.match(String(record.body), /120:Finding 120:/);
            assert.equal(record.overflow, undefined);
        } else {
            assert.equal(record.body, undefined);
            assert.equal(record.overflow, "120 output lines not shown; logTokensTotal exceeds tokensActiveMax");
            const exact = await engine.look({ ...context, statement: statement(PlurnkParser.frame(
                `READ (log:///${initial.loop_seq}/${initial.turn_seq}/${initial.sequence}/READ) <1,-1>`, null,
            )) });
            assert.equal(exact.status, 200);
            assert.ok("content" in exact);
            assert.equal(exact.content, reasoning, "ordinary withholding preserves the full receipt");
            const source = (await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!;
            assert.equal(source.content, reasoning);
        }
        const later = await engine.runTurn({ ...context, provider });
        assert.equal(later.status, 102);
        const laterPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: later.turnId }))!.packet);
        const laterRecord = logEntries(laterPacket).find(({ target }) => target === "reasoning:///1/2")!;
        assert.equal(laterRecord.body, record.body, "no automatic re-READ or restoration after withholding");
        const reads = (await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).filter(({ pathname }) => pathname === "/1/2");
        assert.equal(reads.length, 1);
        assert.equal(reads[0]!.id, initial.id);
        assert.equal(reads[0]!.active, 1);
        assert.equal(reads[0]!.folded, "[]");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
    } finally { await db.close(); }
});

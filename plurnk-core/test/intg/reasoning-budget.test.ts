import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { logEntries } from "./_packet.ts";
import { providerWithCapacity, statement, type Read, type Resource } from "./reasoning-fixture.ts";
import { RESULT_EXCEEDS_BUDGET } from "../../src/core/ContextFit.ts";

// {§reasoning-row} lands the harness's own READ of each turn's reasoning beside the model's; these witnesses count the model's deliberate observations, so the row is off here. Its own witnesses: reasoning-row.test.ts and Digest.reasoning-rows.test.ts.
process.env.PLURNK_SERVICE_REASONING_ROWS = "0";

const task = PlurnkParser.frame("NOTE", "Review the result.");

for (const mode of ["fits", "receipt"] as const) test(`{§reasoning-history} {§context-fit}: an explicit reasoning READ is exact — ${mode === "fits" ? "whole when it fits" : "a bodiless receipt when it does not"}`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-budget-${mode}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "Inspect the reasoning across successive turns.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId, messages: [] };
        const reasoning = Array.from({ length: 120 }, (_, index) => `Finding ${index + 1}: ${"evidence ".repeat(mode === "receipt" ? 100 : 2)}`).join("\n");
        const capacity = mode === "fits" ? 999_000 : 20_000;
        const first = await engine.runTurn({ ...context, provider: providerWithCapacity(capacity, [
            { assistant: { content: `${PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1> <!-- retain reasoning -->", null)}\n\n${task}`, reasoning } },
        ]) });
        const initial = (await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).find(({ pathname }) => pathname === "/1/2")!;
        assert.equal(initial.turn_seq, 2);
        assert.deepEqual(JSON.parse(initial.lineMarker), { marks: [1, -1] }, "an explicit READ never substitutes a smaller scope");
        const rx = JSON.parse(initial.rx) as { status: number; content: string | null; problem?: { type: string; lines: number; tokens: number; remaining: number } };
        if (mode === "fits") {
            assert.equal(rx.status, 200);
            assert.equal(rx.content, reasoning, "the whole source, exactly");
        } else {
            assert.equal(rx.status, 413, "the explicit scope is exact: it did not fit, so the row is its receipt above what fit");
            if (rx.content !== null) assert.ok(reasoning.startsWith(rx.content) && ((rx.problem as { delivered?: number } | undefined)?.delivered ?? 0) > 0, "the body is the longest prefix of lines that fit");
            assert.equal(rx.problem?.type, RESULT_EXCEEDS_BUDGET);
            assert.equal(rx.problem?.lines, 120, "the receipt names the size");
            assert.ok(rx.problem!.tokens > rx.problem!.remaining, "and what remained");
        }
        const firstPacket = (await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet;
        const provider = providerWithCapacity(capacity, [
            { assistant: { content: task, reasoning: "This later source is not requested." } },
            { assistant: { content: task, reasoning: null } },
        ]);
        const next = await engine.runTurn({ ...context, provider });
        assert.equal(next.status, 102);
        assert.equal(next.createdTurnIds.length, 1);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        const record = logEntries(packet).find(({ path: target }) => target === "reasoning://alice/1/2")!;
        assert.ok(record);
        assert.equal(record.aside, "retain reasoning");
        if (mode === "fits") {
            assert.match(String(record.body), /120:Finding 120:/);
            assert.equal(record.preview, undefined);
        } else {
            assert.equal(record.status, 413, "the receipt rides the next packet");
            assert.doesNotMatch(String(record.body ?? ""), /120:Finding 120:/, "the whole never arrives; at most the prefix that fit");
            const range = await engine.look({ ...context, statement: statement(PlurnkParser.frame("READ (reasoning://alice/1/2) <1,10>", null)) });
            assert.equal(range.status, 200, "a range READ of the source still works ({§context-verbs})");
            assert.ok("content" in range);
            assert.equal(range.content, reasoning.split("\n").slice(0, 10).join("\n"));
            const source = (await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!;
            assert.equal(source.content, reasoning, "the source stays whole");
        }
        const later = await engine.runTurn({ ...context, provider });
        assert.equal(later.status, 102);
        const laterPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: later.turnId }))!.packet);
        const laterRecord = logEntries(laterPacket).find(({ path: target }) => target === "reasoning://alice/1/2")!;
        assert.equal(laterRecord.body, record.body, "no automatic re-READ or restoration follows a receipt");
        const reads = (await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).filter(({ pathname }) => pathname === "/1/2");
        assert.equal(reads.length, 1);
        assert.equal(reads[0]!.id, initial.id);
        assert.equal(reads[0]!.active, 1);
        assert.equal(reads[0]!.folded, "[]");
        assert.equal((await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet, firstPacket);
        assert.equal(provider.received.length, 2);
    } finally { await db.close(); }
});

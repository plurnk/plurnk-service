import assert from "node:assert/strict";
import test from "node:test";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { providerWithCapacity, statement, type Read, type Resource } from "./reasoning-fixture.ts";

for (const mode of ["fits", "bounded", "unfit", "explicit"] as const) test(`{§reasoning-initial-read}: ${mode} uses ordinary READ selection and overflow`, async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-budget-${mode}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId, messages: [] };
        const reasoning = Array.from({ length: 120 }, (_, index) => `Finding ${index + 1}: ${"evidence ".repeat(mode === "unfit" ? 500 : 16)}`).join("\n");
        const first = await engine.runTurn({ ...context, provider: providerWithCapacity(999_000, [{ assistant: {
            content: "## PLAN0\n[]\n### EDIT0 (worker:///receipt.txt)\nPreserve this result.\n### READ0 (worker:///receipt.txt) <1,-1>\n### SEND0 (NEXT)\nContinue.", reasoning,
        } }]) });
        const resource = (await db.test_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!;
        const target = `reasoning://${resource.pathname}`;
        const nextSequence = (await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId }))!.next;
        const baseline = await new PacketBuilder({ db, schemes, executors: () => undefined }).buildRequestPacket({
            initialMessages: [], workspaceId, workerId, loopId, currentTurnSeq: nextSequence,
            provider: providerWithCapacity(999_000, []), gitStatus: null,
        });
        const capacity = mode === "fits" ? 999_000 : baseline.weight + 4000;
        const provider = providerWithCapacity(capacity, [{ assistant: {
            content: mode === "explicit"
                ? `## PLAN0\n[]\n### READ0 (${target}) <1,-1>\n### SEND0 (NEXT)\nReview.`
                : "## PLAN0\n[]\n### SEND0 (TERM)\nRecovered.", reasoning: null,
        } }]);
        const build = PacketBuilder.prototype.buildRequestPacket;
        let candidate: Awaited<ReturnType<typeof build>> | undefined;
        t.mock.method(PacketBuilder.prototype, "buildRequestPacket", async function (this: PacketBuilder, input: Parameters<typeof build>[0]) {
            const result = await build.call(this, input);
            if (input.pendingLog?.length) candidate = result;
            return result;
        });
        const next = await engine.runTurn({ ...context, provider });
        assert.ok(candidate);
        const reads = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        const initial = reads[0]!;
        assert.ok(initial);
        assert.equal(initial.origin, "_plurnk");
        assert.deepEqual(JSON.parse(initial.lineMarker), { marks: [1, mode === "fits" ? -1 : 16] });
        const initialResult = JSON.parse(initial.rx);
        assert.equal(initialResult.content, mode === "fits" ? reasoning : reasoning.split("\n").slice(0, 16).join("\n"));
        assert.equal(reads.filter(({ origin }) => origin === "_plurnk").length, 1, "preflight never records the discarded full READ");
        assert.equal((await db.test_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!.content, reasoning);
        const originalPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet);
        assert.equal(originalPacket.assistant.reasoning, reasoning);
        if (mode === "unfit") {
            assert.equal(next.status, 102, JSON.stringify(next));
            assert.equal(next.producer, "_plurnk");
            assert.equal(next.kind, "overflow");
            assert.equal(next.createdTurnIds.length, 1);
            assert.equal(provider.remaining, 1, "no over-budget request reaches inference");
            assert.equal(initial.active, 1);
            assert.notEqual(initial.folded, "[]", "ordinary recovery suppresses the receipt, not the source");
            const recovered = await engine.runTurn({ ...context, provider });
            assert.equal(recovered.status, 200, JSON.stringify(recovered));
            assert.equal(provider.remaining, 0);
            assert.equal((await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).length, 1, "recovery does not redeliver the same source");
            const exact = await engine.look({ ...context, statement: statement(`### READ0 (log:///${initial.loop_seq}/${initial.turn_seq}/${initial.sequence}/READ) <1,-1>`) });
            assert.ok("content" in exact);
            assert.equal(exact.content, initialResult.content);
        } else {
            assert.equal(next.producer, "model");
            assert.equal(provider.remaining, 0);
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
            const log = packet.sections.find(({ name }: { name: string }) => name === "log").content;
            const record = parseLogRecords(log).find(({ target: value }) => value === target);
            assert.ok(record);
            assert.match(String(record.body), /16:Finding 16:/);
            assert.doesNotMatch(log, /YOU MUST ONLY/);
            if (mode === "fits") {
                assert.match(String(record.body), /120:Finding 120:/);
                assert.deepEqual(packet.sections, candidate.sections, "preflight and the committed READ produce the exact same packet");
                assert.equal(packet.weight, candidate.weight);
            }
            else {
                assert.doesNotMatch(String(record.body), /17:Finding 17:/);
                assert.deepEqual(record.range, { unit: "line", total: 120, requested: [1, 16], returned: [1, 16] });
            }
            if (mode === "explicit") {
                assert.equal(reads.length, 2);
                assert.equal(reads[1]!.origin, "model");
                assert.deepEqual(JSON.parse(reads[1]!.lineMarker), { marks: [1, -1] });
                assert.equal(JSON.parse(reads[1]!.rx).content, reasoning, "the model's scope is never replaced by the automatic cap");
                const overflow = await engine.runTurn({ ...context, provider });
                assert.equal(overflow.producer, "_plurnk");
                assert.equal(overflow.status, 102, JSON.stringify(overflow));
            }
        }
    } finally { await db.close(); }
});

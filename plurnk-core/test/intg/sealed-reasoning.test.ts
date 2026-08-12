// {§encrypted-reasoning-carrier} {§agui-encrypted-reasoning} — cross-package
// coverage for core relay, AG-UI projection, cardinality, and packet exclusion.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import LogEntry from "../../src/server/logEntry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { Translator } from "@plurnk/plurnk-agui";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const BLOB = "gAAAAABqBLOB-SEALED-0123456789";

// Hydrate the real core rows, then feed them to AG-UI in durable order.
const projectThroughAgui = async (db: Db, workerId: number, turnId: number) => {
    const tr = new Translator({ threadId: "xlane", runId: "xlane", modelWorkerId: workerId });
    const refs = await db.test_log_entries_by_worker.all<{ id: number; turn_id: number }>({ worker_id: workerId });
    const events = [];
    for (const { id, turn_id } of refs) {
        if (turn_id !== turnId) continue;
        const row = await LogEntry.fetchLogEntry(db, id);
        events.push(...tr.logEntry({ entry: {
            ...row,
            coordinate: `${row.loop_seq}/${row.turn_seq}/${row.sequence}${row.op === null ? "" : `/${row.op}`}`,
        } as never }));
    }
    return events;
};

test("core preserves the normalized item list, AG-UI correlates it, and the packet excludes it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sealed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "<|PLAN|>\n<|SEND[102]>one<SEND|>", reasoning: null, reasoningEncrypted: [{ id: "rs_1", subtype: "message", encrypted: [{ data: BLOB, format: "openai-responses-v1" }] }] } },
            { assistant: { content: "<|PLAN|>\n<|SEND[200]>done<SEND|>", reasoning: null } },
        ] as never });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });

        // Core preserves the provider-normalized list without reinterpretation.
        const rows = await db.test_model_emission_rows.all<{ attrs: string }>({ worker_id: workerId });
        const row = rows.find((r) => (JSON.parse(r.attrs) as { reasoning?: unknown }).reasoning !== undefined);
        assert.ok(row, "the mirror row carries attrs.reasoning");
        const list = (JSON.parse(row!.attrs) as { reasoning: Array<{ id: string | null; subtype: string; encrypted: Array<{ data: string; format: string | null }> }> }).reasoning;
        assert.ok(Array.isArray(list), "attrs.reasoning is the item LIST (the standard shape)");
        assert.deepEqual(list, [{ id: "rs_1", subtype: "message", encrypted: [{ data: BLOB, format: "openai-responses-v1" }] }], "core relays the normalized item unchanged");

        // 2. Cross-lane conformance: real core rows → hydration → AG-UI Translator.
        const events = await projectThroughAgui(db, workerId, t1.turnId);
        const assistant = events.find((e) => e.type === "TEXT_MESSAGE_START") as { messageId?: string } | undefined;
        const ev = events.find((e) => e.type === "REASONING_ENCRYPTED_VALUE") as { entityId?: string; encryptedValue?: string; subtype?: string } | undefined;
        assert.ok(ev, "agui projected REASONING_ENCRYPTED_VALUE from core's real serialization");
        assert.ok(assistant?.messageId, "the same turn projected a real SEND assistant message");
        assert.equal(ev!.entityId, assistant!.messageId, "encrypted evidence targets the actual SEND entity");
        assert.notEqual(ev!.entityId, "rs_1", "provider detail identity never masquerades as a client entity");
        assert.equal(ev!.encryptedValue, BLOB, "the sealed value reaches the seam intact");
        assert.ok(!events.some((e) => e.type === "REASONING_START" || e.type === "REASONING_END"), "no unbacked reasoning span is invented");

        // 3. Weight safety: the NEXT packet's render must not contain the blob anywhere.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const packet = (await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId }))!.packet;
        const sections = (JSON.parse(packet) as { sections?: Array<{ content: string }> }).sections ?? [];
        assert.ok(sections.every((s) => !s.content.includes(BLOB)), "no packet section carries the sealed blob — the model never pays for what it cannot read");
        assert.ok(t1.turnId > 0);
    } finally { await db.close(); }
});

test("multiple encrypted-reasoning items remain distinct forensic evidence without collapsing into AG-UI", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sealed-multi-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const A = `${BLOB}-A`, B = `${BLOB}-B`;
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "<|PLAN|>\n<|SEND[200]>done<SEND|>", reasoning: null, reasoningEncrypted: [
                { id: "rs_a", subtype: "message", encrypted: [{ data: A, format: "openai-responses-v1" }] },
                { id: "rs_b", subtype: "message", encrypted: [{ data: B, format: "openai-responses-v1" }] },
            ] } },
        ] as never });
        const turn = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });

        const rows = await db.test_model_emission_rows.all<{ attrs: string }>({ worker_id: workerId });
        const row = rows.find((r) => (JSON.parse(r.attrs) as { reasoning?: unknown }).reasoning !== undefined)!;
        const list = (JSON.parse(row.attrs) as { reasoning: Array<{ id: string; encrypted: Array<{ data: string }> }> }).reasoning;
        assert.deepEqual(list.map(({ id, encrypted }) => [id, encrypted[0]?.data]), [["rs_a", A], ["rs_b", B]], "the forensic row retains both provider details distinctly");
        const events = await projectThroughAgui(db, workerId, turn.turnId);
        assert.ok(!events.some((e) => e.type === "REASONING_ENCRYPTED_VALUE"), "the single AG-UI message slot does not select, join, or overwrite multiple values");
    } finally { await db.close(); }
});

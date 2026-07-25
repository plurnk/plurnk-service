// {§sealed-reasoning-carrier} → [§sealed-reasoning-carrier] (#482) — a provider's SEALED reasoning
// (o-class encrypted items, normalized by providers as assistant.reasoningEncrypted) rides the
// model mirror row's `attrs.reasoning` VERBATIM as the OpenAI/AG-UI item LIST: per-turn on the
// log/entry broadcast + readLog (agui's seam), never decoded, and NEVER rendered into a packet — a
// multi-KB blob leaking into the log render would tax every subsequent turn.
//
// The CROSS-LANE conformance drive (client's, dep-correct here since core→agui already): core's real
// write feeds agui's real Translator in one test, so a future non-meeting seam is a RED gate pre-push,
// not a shipped-broken main (the guard that would have caught the original double-unmatched landing).
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { Translator } from "@plurnk/plurnk-agui";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const BLOB = "gAAAAABqBLOB-SEALED-0123456789";

// Feed a mirror row's serialized attrs to agui's real Translator; return the projected events.
const projectThroughAgui = (workerId: number, attrs: string) => {
    const tr = new Translator({ threadId: "xlane", runId: "xlane", modelWorkerId: workerId });
    return tr.logEntry({ entry: { id: 9, op: "model", origin: "model", coordinate: "1/1/9/model", turn_id: 1, tx: "", attrs, worker_id: workerId } as never });
};

test("the item list lands verbatim on attrs.reasoning AND agui projects a correlated span; the packet never carries the blob", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sealed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "<<PLAN::PLAN\n<<SEND[102]:one:SEND", reasoning: null, reasoningEncrypted: [{ id: "rs_1", subtype: "message", encrypted: [{ data: BLOB, format: "openai-responses-v1" }] }] } },
            { assistant: { content: "<<PLAN::PLAN\n<<SEND[200]:done:SEND", reasoning: null } },
        ] as never });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });

        // 1. The carrier: attrs.reasoning is the item LIST, blobs verbatim.
        const rows = await db.test_log_entries_by_run_op.all<{ attrs: string }>({ worker_id: workerId, op: "model" });
        const row = rows.find((r) => (JSON.parse(r.attrs) as { reasoning?: unknown }).reasoning !== undefined);
        assert.ok(row, "the mirror row carries attrs.reasoning");
        const list = (JSON.parse(row!.attrs) as { reasoning: Array<{ id: string | null; subtype: string; encrypted: Array<{ data: string; format: string | null }> }> }).reasoning;
        assert.ok(Array.isArray(list), "attrs.reasoning is the item LIST (the standard shape)");
        assert.deepEqual(list, [{ id: "rs_1", subtype: "message", encrypted: [{ data: BLOB, format: "openai-responses-v1" }] }], "the item rides verbatim — id/subtype/blob unsynthesized");

        // 2. Cross-lane conformance: core's real attrs → agui's real Translator → the standard event.
        const events = projectThroughAgui(workerId, row!.attrs);
        const ev = events.find((e) => e.type === "REASONING_ENCRYPTED_VALUE") as { entityId?: string; encryptedValue?: string; subtype?: string } | undefined;
        assert.ok(ev, "agui projected REASONING_ENCRYPTED_VALUE from core's real serialization");
        assert.equal(ev!.entityId, "rs_1", "correlated by the wire id");
        assert.equal(ev!.encryptedValue, BLOB, "the sealed value reaches the seam intact");
        assert.equal((events.find((e) => e.type === "REASONING_START") as { messageId?: string } | undefined)?.messageId, "rs_1", "the span correlates to the same id");

        // 3. Weight safety: the NEXT packet's render must not contain the blob anywhere.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const packet = (await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId }))!.packet;
        const sections = (JSON.parse(packet) as { sections?: Array<{ content: string }> }).sections ?? [];
        assert.ok(sections.every((s) => !s.content.includes(BLOB)), "no packet section carries the sealed blob — the model never pays for what it cannot read");
        assert.ok(t1.turnId > 0);
    } finally { await db.close(); }
});

test("a MULTI-item turn serves N correlated spans — the array residual is closed (#482)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sealed-multi-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const A = `${BLOB}-A`, B = `${BLOB}-B`;
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "<<PLAN::PLAN\n<<SEND[200]:done:SEND", reasoning: null, reasoningEncrypted: [
                { id: "rs_a", subtype: "message", encrypted: [{ data: A, format: "openai-responses-v1" }] },
                { id: "rs_b", subtype: "message", encrypted: [{ data: B, format: "openai-responses-v1" }] },
            ] } },
        ] as never });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });

        const rows = await db.test_log_entries_by_run_op.all<{ attrs: string }>({ worker_id: workerId, op: "model" });
        const row = rows.find((r) => (JSON.parse(r.attrs) as { reasoning?: unknown }).reasoning !== undefined)!;
        // core relays BOTH items (not a collapsed first) → agui projects TWO correlated sealed values.
        const values = projectThroughAgui(workerId, row.attrs)
            .filter((e) => e.type === "REASONING_ENCRYPTED_VALUE") as Array<{ entityId: string; encryptedValue: string }>;
        assert.equal(values.length, 2, "both reasoning items serve — no collapse-to-first");
        assert.deepEqual(values.map((v) => [v.entityId, v.encryptedValue]).sort(), [["rs_a", A], ["rs_b", B]], "each item correlated to its own id + blob");
    } finally { await db.close(); }
});

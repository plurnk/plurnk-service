// {§sealed-reasoning-carrier} → [§sealed-reasoning-carrier] (#482) — a provider's SEALED reasoning
// (o1-class encrypted blobs, normalized by providers as assistant.reasoningEncrypted) rides the
// model mirror row's attrs VERBATIM: per-turn on the log/entry broadcast + readLog (agui's seam),
// never decoded, and NEVER rendered into a packet — a multi-KB blob leaking into the log render
// would tax every subsequent turn.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const MESSAGES = [{ role: "system" as const, content: "SD" }, { role: "user" as const, content: "go" }];
const BLOB = "gAAAAABqBLOB-SEALED-0123456789";

test("[§sealed-reasoning-carrier] sealed blobs land verbatim on the mirror row's attrs; the packet render never carries them", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `sealed-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            { assistant: { content: "<<PLAN::PLAN\n<<SEND[102]:one:SEND", reasoning: null, reasoningEncrypted: [{ data: BLOB, format: "openai-responses-v1" }] } },
            { assistant: { content: "<<PLAN::PLAN\n<<SEND[200]:done:SEND", reasoning: null } },
        ] as never });
        const t1 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 1 });

        // 1. The carrier: the mirror row's attrs hold the blobs verbatim — agui's per-turn seam.
        const rows = await (db.test_log_entries_by_run_op as PrepMethod).all<{ attrs: string }>({ worker_id: workerId, op: "model" });
        const sealed = rows.map((r) => JSON.parse(r.attrs) as { reasoningEncrypted?: Array<{ data: string; format: string | null }> })
            .find((a) => a.reasoningEncrypted !== undefined);
        assert.ok(sealed, "the mirror row carries reasoningEncrypted");
        assert.deepEqual(sealed!.reasoningEncrypted, [{ data: BLOB, format: "openai-responses-v1" }], "blobs verbatim — never decoded, never synthesized");

        // 2. Weight safety: the NEXT packet's render must not contain the blob anywhere.
        const t2 = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: MESSAGES, turnNumber: 2 });
        const packet = (await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId }))!.packet;
        const sections = (JSON.parse(packet) as { sections?: Array<{ content: string }> }).sections ?? [];
        assert.ok(sections.every((s) => !s.content.includes(BLOB)), "no packet section carries the sealed blob — the model never pays for what it cannot read");
        assert.ok(t1.turnId > 0);
    } finally { await db.close(); }
});

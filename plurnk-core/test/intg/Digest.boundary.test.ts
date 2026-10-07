import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import Turn from "../../src/core/Turn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

test("{§digest-programmatic-surface}: removed service report exports have no compatibility path", async () => {
    for (const path of ["@plurnk/plurnk-service/digest", "@plurnk/plurnk-service/share"]) {
        await assert.rejects(import(path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    }
});

test("{§digest-evidence-reader}: the public reader supplies canonical packets to the independent report package", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const db = await openMigrated(dbPath);
    const packet = StoredPacket.assert({
        weight: 1, attributions: [],
        sections: [{ name: "log", slot: "user", header: "Log", content: "observed evidence", weight: 1 }],
        assistant: { content: "", ops: [], reasoning: "independent report witness" },
        assistantRaw: { retained: "provider bytes" },
    });
    try {
        const workspaceId = await insertWorkspace(db, "reader-contract");
        const workerId = await insertWorker(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, workerId, 1, "report the evidence");
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        await Turn.recordInference(db, turn.id, {
            packet: StoredPacket.stringify(packet), sections: StoredPacket.sections(packet),
            usageCurationBudget: null, finishReason: "stop", model: "fixture", meta: "{}",
        });
        await Turn.complete(db, turn.id, 200);
    } finally { await db.close(); }
    using evidence = EvidenceReader.open(dbPath);
    const [turn] = evidence.rows().turns;
    const view = evidence.packet(turn).packet;
    assert.ok(view);
    assert.deepEqual(view.messages(new Map()), PacketWire.packetToWireMessages(packet, new Map()));
    assert.equal(view.slot("user"), PacketWire.renderSlot(packet.sections, "user"));
    assert.equal(view.assistant?.reasoning, "independent report witness");
    assert.deepEqual(view.assistantRaw, { retained: "provider bytes" });
    const digestDir = join(root, "digest");
    Digest.run({ dbPath, digestDir, openEvidence: EvidenceReader.open });
    assert.match(await readFile(join(digestDir, "reasoning.md"), "utf8"), /independent report witness/);
    assert.deepEqual(JSON.parse(await readFile(join(digestDir, "witness-1-1.wire.json"), "utf8")), view.messages(new Map()));
});

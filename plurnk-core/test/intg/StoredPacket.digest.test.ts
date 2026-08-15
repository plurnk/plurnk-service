import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Digest from "../../src/digest/Digest.ts";
import JournalTurn from "../../src/core/JournalTurn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("Digest: journal-only and request-only turns remain visibly distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-packet-algebra-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "packet-algebra");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "packet states");
        await JournalTurn.insert(db, loopId);
        await db.test_turns_insert.run({
            loop_id: loopId,
            sequence: 2,
            status: 502,
            packet: StoredPacket.stringify({ weight: 0, sections: [], attributions: [] }),
        });
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
        assert.match(
            await readFile(join(digestDir, "packet000.packet.md"), "utf8"),
            /journal-only turn dispatched operations without assembling a model request/,
        );
        assert.match(
            await readFile(join(digestDir, "packet001.response.md"), "utf8"),
            /No provider response was admitted/,
        );
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /T1:.*\n  ↳ model packet: \(none\)/);
        assert.match(markdown, /T2:.*\n  ↳ emission: \(none admitted\)/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

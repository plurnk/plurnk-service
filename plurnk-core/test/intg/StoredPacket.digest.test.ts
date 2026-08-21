import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Digest from "../../src/digest/Digest.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("Digest: operation and request-only turns remain visibly distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-packet-algebra-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "packet-algebra");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "packet states");
        const operation = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
        await Turn.complete(db, operation.id, 200);
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
        await assert.rejects(() => access(join(digestDir, "packet000.packet.md")));
        assert.match(
            await readFile(join(digestDir, "packet001.response.md"), "utf8"),
            /No provider response was admitted/,
        );
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /Tokens:\s+no provider requests/);
        assert.match(markdown, /Cost:\s+n\/a/);
        assert.match(markdown, /T1: producer=client kind=operation status=200/);
        assert.doesNotMatch(markdown, /T1:.*(?:model=|input=|cost=)/);
        assert.match(markdown, /T2:.*\n  ↳ emission: \(none admitted\)/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

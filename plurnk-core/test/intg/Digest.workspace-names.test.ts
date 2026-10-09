// {§share-packet-names} — a workspace named by its path still shares: its packet folder is a slug of
// the name, the digest text keeps the name verbatim, and two names that slug alike stay apart (#1001).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { contentWeight } from "../../src/core/content-weight.ts";
import type { DurablePacket } from "../../src/core/StoredPacket.ts";
import { insertLoop, insertPacketTurn, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const packet = (turn: number): DurablePacket => ({
    weight: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: "You are a worker.", weight: contentWeight("You are a worker.") },
        { name: "log", slot: "user", header: "Log", content: `turn ${turn}`, weight: 1 },
    ],
    attributions: [],
    assistant: { content: "emission", ops: [], reasoning: null },
    assistantRaw: null,
});

test("{§share-packet-names}: a workspace named by its path is slugged for its packet folder and named verbatim in the digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-names-"));
    const dbPath = join(dir, "plurnk.db");
    const db = await openMigrated(dbPath);
    try {
        for (const [name, worker] of [["~/ptl/plurnk-service", "clerk9"], ["~/ptl/plurnk-service/", "scout"], ["service", "mx1"]] as const) {
            const workspaceId = await insertWorkspace(db, name);
            const workerId = await insertWorker(db, workspaceId, null, worker);
            const loopId = await insertLoop(db, workerId, 1, "work");
            await insertPacketTurn(db, loopId, 1, packet(1), 200);
        }
    } finally { await db.close(); }
    const digestDir = join(dir, "digest");
    assert.doesNotThrow(() => Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir }), "a path-named workspace shares");
    const folders = (await readdir(digestDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.ok(folders.includes("ptl-plurnk-service"), `the first path-named workspace slugs to ptl-plurnk-service: ${folders.join(", ")}`);
    assert.ok(folders.some((name) => /^ptl-plurnk-service-\d+$/u.test(name)), `the second, slugging alike, carries its id: ${folders.join(", ")}`);
    assert.ok(folders.includes("service"), "a name that can name a file is kept as it is");
    assert.ok((await readdir(join(digestDir, "ptl-plurnk-service"))).some((name) => name.startsWith("clerk9-1-1")), "the worker's packet files sit in the slugged folder");
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /~\/ptl\/plurnk-service/u, "the digest text keeps the workspace's name verbatim");
    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { turns: Array<{ artifact: string }> };
    assert.ok(json.turns.some((turn) => turn.artifact === "ptl-plurnk-service/clerk9-1-1"), "digest.json records the slugged stem");
    for (const { artifact } of json.turns) {
        const page = await readFile(join(digestDir, `${artifact}.request.md`), "utf8");
        assert.match(page, /\[Digest\]\(\.\.\/digest\.md\)/u);
        assert.doesNotMatch(page, /\[(?:Previous|Next)\]/u, "navigation cannot cross workers or workspaces");
        assert.ok(markdown.includes(`](${artifact}.request.md)`));
    }
});

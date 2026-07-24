import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Digest from "../../src/digest/Digest.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

test("digest Markdown exposes amplification as exact aggregates while JSON preserves every row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-cardinality-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "digest-cardinality");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "amplify");
        const turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (sequence: number, origin: "model" | "plurnk", op: "READ" | "EDIT", pathname: string, attrs: object): Promise<void> => {
            await (db.engine_insert_log_entry as PrepMethod).run({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                origin, source: null, op, suffix: "", signal: null,
                scheme: "https", username: null, password: null, hostname: null, port: null,
                pathname, params: null, fragment: null, lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify({ status: 200, content: "x" }), mimetype_rx: "application/json",
                status_rx: 200, tokens: 1, state: "resolved", outcome: null,
                attrs: JSON.stringify(attrs),
            });
        };
        for (let i = 1; i <= 50; i++) await insert(i, "model", "READ", "/example.test/whale", {});
        for (let i = 51; i <= 62; i++) await insert(i, "plurnk", "EDIT", `/result${i}.test/`, { kind: "entry_materialized" });
    } finally {
        await db.close();
    }

    try {
        Digest.run({ dbPath, digestDir });
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as { log_entries: unknown[] };
        assert.match(markdown, /READ\[200\] https:\/\/\/example\.test\/whale ×50 \(seq 1–50\)/);
        assert.match(markdown, /materialized entries\[200\] ×12 \(seq 51–62\)/);
        assert.equal(json.log_entries.length, 62, "machine-readable evidence remains lossless");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

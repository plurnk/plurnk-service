import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Digest from "./Digest.ts";
import type { DigestEvidence } from "./evidence.ts";

test("{§digest-evidence-reader}: reports consume an independent reader without opening SQL or loading a daemon", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-independent-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "evidence");
    await writeFile(dbPath, "not a SQLite database");
    let opened = 0;
    let closed = 0;
    const unexpected = (): never => { throw new Error("empty census has no heavy evidence"); };
    const openEvidence = (path: string): DigestEvidence => {
        assert.equal(path, dbPath);
        opened++;
        return {
            rows: () => ({
                workspaces: [], workers: [], loops: [], turns: [], inferenceCalls: [], modelCalls: [],
                turnAttempts: [], providerRequests: [], logEntries: [], editRows: [], emissionRows: [],
                reasoningRows: [], curationEffects: [], workerRollupRows: [], opMixRows: [], environmentRows: [],
                searchState: { channel_entries: 0, derivation_complete: 0, unfinished: 0 },
                derivationState: { complete: 0, building: 0 }, dispositionCounts: [], dispositions: [],
                storage: { bytes: 0, free_bytes: 0, auto_vacuum: 0 }, storageTables: [],
            }),
            packet: unexpected, response: unexpected, request: unexpected, reasoning: unexpected,
            textWeight: unexpected,
            [Symbol.dispose]: () => { closed++; },
        };
    };
    const digestDir = join(root, "report");
    Digest.run({ dbPath, digestDir, openEvidence });
    const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    assert.deepEqual(report.turns, []);
    assert.deepEqual(report.provider_requests, []);
    assert.equal(await readFile(dbPath, "utf8"), "not a SQLite database");
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    assert.throws(() => Digest.run({ dbPath, digestDir, openEvidence }), {
        message: `digest: ${digestDir} already exists and is not an empty folder; remove it first`,
    });
    assert.equal(opened, 1, "a refused destination never opens evidence");
});

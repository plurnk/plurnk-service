// #561 — the requiem is a synthetic out-of-band model call (the exit interview, after the run,
// outside any live worker turn). A plurnk-endpoint witness requires FULL turn identity on every
// call — Plurnk-Worker-Id AND Plurnk-Worker-Primary — and rejects an identity-less call 400. The
// interview has no live worker tree, so it identifies as its OWN root (primaryWorkerId == workerId):
// a testimony call is a primary, graded by the strong model. This pins that contract — the class
// that went untested because every prior requiem ran against a witness that ignores the headers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import Digest from "../../src/digest/Digest.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

// A witness that records the identity of every generate() call the requiem makes.
class WitnessMock extends Mock {
    calls: Array<{ workerId?: string; primaryWorkerId?: string }> = [];
    override async generate(args: Parameters<Mock["generate"]>[0] & { workerId?: string; primaryWorkerId?: string }): ReturnType<Mock["generate"]> {
        this.calls.push({ workerId: args.workerId, primaryWorkerId: args.primaryWorkerId });
        return super.generate(args);
    }
}

const MODEL_PACKET = (worker: string) => JSON.stringify({
    tokens: 0,
    sections: [
        { name: "system", slot: "system", header: null, content: `system for ${worker}`, tokens: 1 },
        { name: "log", slot: "user", header: "Log", content: `log for ${worker}`, tokens: 1 },
    ],
    telemetryErrors: [],
    assistant: { content: `last emission of ${worker}`, ops: [], reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 }, finishReason: "stop", model: "mock" },
    assistantRaw: null,
});

test("[#561] the requiem interview identifies as its own root — primaryWorkerId == workerId on every call", async () => {
    const dbPath = join(process.cwd(), "test/intg/.tmp", `requiem-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "requiem-identity");
        const worker = await insertWorker(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, worker, 1, "go");
        // A turn carrying a MODEL packet (non-empty sections) so the requiem picks this worker up.
        await db.test_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence: 1, status: 200, packet: MODEL_PACKET("witness") });
    } finally { await db.close(); }

    const provider = new WitnessMock({ contextWindow: 100000, responses: [{ assistant: { content: "the testimony", reasoning: null, ops: [], finishReason: "stop" } }] });
    const digestDir = join(process.cwd(), "test/intg/.tmp", `requiem-out-${crypto.randomUUID()}`);
    const { path, workers } = await Digest.requiem({ dbPath, digestDir, provider });

    assert.equal(workers, 1, "the one model-bearing worker was interviewed");
    assert.equal(provider.calls.length, 1, "one generate call — the exit interview");
    const call = provider.calls[0];
    assert.ok(call.workerId !== undefined && call.workerId.length > 0, "the interview carries the worker's id");
    assert.equal(call.primaryWorkerId, call.workerId, "primaryWorkerId == workerId — the interview is its own root, so the endpoint's both-headers gate is satisfied and the strong model witnesses");

    const requiem = readFileSync(path, "utf8");
    assert.match(requiem, /the testimony/, "the testimony was written");
});

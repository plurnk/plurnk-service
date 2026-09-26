import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, testDeferredProviderCapacity } from "./_helpers.ts";
import Turn from "../../src/core/Turn.ts";
import StoredPacket from "../../src/core/StoredPacket.ts";

const execFileP = promisify(execFile);

test("{§digest-forensic-fidelity}: exports repeated large wire evidence under a bounded heap without losing records", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-memory-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    const digestDir = join(root, "digest");
    const db = await openMigrated(dbPath);
    const payload = "🌍".repeat(512 * 1024);
    const count = 16;
    try {
        const workspaceId = await insertWorkspace(db, "large-evidence");
        const workerId = await insertWorker(db, workspaceId, null, "witness");
        const loopId = await insertLoop(db, workerId, 1, "retain every response");
        for (let index = 0; index < count; index++) {
            const content = `response-${index}`;
            const assistant = { content, ops: [], reasoning: `reasoning-${index}` };
            const assistantRaw = { content, evidence: payload };
            const packet = {
                weight: 1, attributions: [],
                sections: [{ name: "log", slot: "user", header: "Log", content: `request-${index}`, weight: 1 }],
                assistant, assistantRaw,
            } as const;
            const turnId = (await Turn.open(db, { loopId, producer: "model", kind: "inference" })).id;
            await Turn.recordInference(db, turnId, {
                packet: StoredPacket.stringify(StoredPacket.assert(packet)), sections: StoredPacket.sections(StoredPacket.assert(packet)),
                usageCurationBudget: null, finishReason: "stop", model: "fixture", meta: "{}",
            });
            const call = await db.engine_open_model_call.get<{ id: number }>({
                turn_id: turnId, kind: "emission", attributions: "[]", model: "fixture",
            });
            assert.ok(call);
            const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({ model_call_id: call.id });
            assert.ok(attempt);
            await db.engine_observe_model_call_response.run({
                id: call.id, native_inputs: "[]", response: JSON.stringify({ assistant, assistantRaw }),
                failure: null, capacity: JSON.stringify(testDeferredProviderCapacity("digest:memory")),
                finish_reason: "stop", model: "fixture",
            });
            await db.engine_classify_turn_attempt_response.run({ id: attempt.id, accepted: 1, parse_errors: "[]" });
            await Turn.recordSource(db, turnId, "ops", content, { modelCallId: call.id });
            await Turn.complete(db, turnId, 200);
        }
    } finally {
        await db.close();
    }
    await execFileP(process.execPath, [
        "--max-old-space-size=192", "--conditions=plurnk-dev", "src/service.ts", "share", dbPath, digestDir,
    ], { cwd: resolve(import.meta.dirname, "../.."), timeout: 20000, maxBuffer: 1024 * 1024 });
    const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    assert.equal(digest.turns.length, count);
    assert.equal(digest.model_calls.length, count);
    assert.equal(digest.turn_attempts.length, count);
    for (let index = 0; index < count; index++) {
        const stem = `packet${String(index).padStart(3, "0")}`;
        assert.equal(await readFile(join(digestDir, `${stem}.assistant.md`), "utf8"), `response-${index}`);
        assert.equal(JSON.parse(await readFile(join(digestDir, `${stem}.assistantRaw.json`), "utf8")).evidence, payload);
        assert.equal(digest.model_calls[index].response.assistantRaw.evidence, payload);
        assert.equal(digest.turn_attempts[index].response.assistantRaw.evidence, payload);
    }
    assert.match(await readFile(join(digestDir, "reasoning.md"), "utf8"), /reasoning-15/);
});

// SPEC §14.5 — the environment delta. At pre-turn build the engine reconciles
// each tracked entry against this run's watermark; a change since the run last
// looked materializes a system-authored EDIT carrying the §14.6 result span.
// Here the change is simulated by mutating a channel directly (an exec stream
// or a sibling would do the same out-of-band), bypassing editSessionEntry so
// the watermark is NOT reconciled the way the model's own edits are.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { SendStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, seedEntryWithChannel } from "./_helpers.ts";

const okSend = (): MockResponse => ({
    assistant: {
        content: "",
        ops: [{ op: "SEND", suffix: "", signal: 200, target: null, lineMarker: null, body: { raw: "ok", json: null }, position: { line: 1, column: 1 } } as SendStatement],
        reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    },
});
const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];

const makeEngine = (db: Db): Engine => {
    process.env.PLURNK_BUDGET_CEILING = "1000000";  // never overflow — keep the grinder out of it
    const e = new Engine({ db, schemes: new SchemeRegistry() });
    delete process.env.PLURNK_BUDGET_CEILING;
    return e;
};

test("an out-of-band change to a tracked entry surfaces next turn as a system delta-EDIT (§14.5)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ed-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const entryId = await seedEntryWithChannel(db, { sessionId, content: "line1\nline2" });
        const eng = makeEngine(db);
        const provider = new Mock({ contextSize: 4096, responses: [okSend(), okSend()] });

        // Turn 1: the entry is first-sighted → watermark set, no delta.
        await eng.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 1 });
        const afterT1 = await (db.engine_render_log as PrepMethod).all<{ scheme: string | null; origin: string; op: string }>({ run_id: runId });
        assert.ok(!afterT1.some((r) => r.scheme === "known" && r.origin === "system" && r.op === "EDIT"), "first sight reconciles silently — no delta yet");

        // Out-of-band append (exec stream / sibling): mutate the channel directly,
        // NOT through editSessionEntry, so the watermark stays unreconciled.
        await (db.ops_upsert_channel as PrepMethod).run({ entry_id: entryId, name: "body", content: "line1\nline2\nline3-new", mimetype: "text/plain", tokens: 0 });

        // Turn 2: the build detects the change → a system EDIT delta with the new span.
        await eng.runTurn({ provider, sessionId, runId, loopId, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ scheme: string | null; origin: string; op: string; rx: string; source: string | null }>({ run_id: runId });
        const delta = rows.find((r) => r.scheme === "known" && r.origin === "system" && r.op === "EDIT");
        assert.ok(delta, "the out-of-band change materialized a system delta-EDIT");
        assert.equal(delta!.source, null, "a self/ambient change is self-attributed — no run= label");
        assert.match(JSON.parse(delta!.rx).span as string, /3:\tline3-new/, "the delta carries the changed span, line-numbered (§14.6)");
    } finally { await db.close(); }
});

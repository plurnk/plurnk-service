// Regression guard for the live/demo exec failure: a model runs an EXEC,
// the entry is created + indexed in the DB — but it must also appear in the
// NEXT turn's rendered index, or the model is blind to its own output and
// loops forever. The bug hid because it only manifested in the e2e tier
// (model-in-loop); this reproduces it deterministically with a Mock model so
// it runs in the normal intg suite. No live model required.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement, SendStatement, PlurnkStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import Yolo from "../../src/server/yolo.ts";
import { openMigrated, insertSession, insertRun, insertLoop, testExecutors } from "./_helpers.ts";
import { readFile } from "node:fs/promises";
import { Paths } from "../../src/index.ts";

const SYSTEM_PROMPT = await readFile(Paths.instructionsSystem, "utf8");
const PERSONA = await readFile(Paths.defaultPersona, "utf8");
const REQUIREMENTS = await readFile(Paths.defaultRequirements, "utf8");

const execStmt = (runtime: string, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});
const sendStmt = (status: number): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: "", json: null }, position: { line: 1, column: 1 },
});
const response = (ops: PlurnkStatement[]) => ({ assistant: { content: "", ops, reasoning: null } });

test("regression: a model's EXEC result appears in the NEXT turn's index, not just the DB", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        Yolo.attachYolo(engine, db);

        const sessionId = await insertSession(db, `exec-surface-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "run a command");
        await (db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });

        // Turn 1: EXEC. Turn 2: SEND (terminate). The Mock model is blind to
        // the index — we assert the ENGINE put the exec result in turn 2's packet.
        const mock = new Mock({ contextSize: 100000, responses: [
            response([execStmt("sh", "echo plurnk-index-probe")]),
            response([sendStmt(200)]),
        ] });
        const result = await engine.runLoop({
            provider: mock, sessionId, runId, loopId, maxTurns: 4,
            messages: [{ role: "system", content: "go" }, { role: "user", content: "run it" }],
        });
        await exec.idle();

        assert.ok(result.turnIds.length >= 2, `expected at least 2 turns; got ${result.turnIds.length}`);
        const turn2 = result.turnIds[1];
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turn2 });
        const packet = JSON.parse(row?.packet ?? "{}") as { system?: { index?: Array<{ scheme: string | null; pathname: string }> } };
        const paths = (packet.system?.index ?? []).map((e) => `${e.scheme}://${e.pathname}`);
        assert.ok(
            paths.some((p) => p.startsWith("exec://")),
            `turn-2 index must contain the exec result so the model can read it; got ${JSON.stringify(paths)}`,
        );
    } finally { await db.close(); }
});

test("regression-replica: under the FULL base context (sysprompt + persona + requirements) the exec result still surfaces", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        Yolo.attachYolo(engine, db);

        const sessionId = await insertSession(db, `exec-replica-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "what is the hostname of this machine?");
        await (db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });

        const mock = new Mock({ contextSize: 100000, responses: [
            response([execStmt("sh", "hostname")]),
            response([sendStmt(200)]),
        ] });
        const result = await engine.runLoop({
            provider: mock, sessionId, runId, loopId, maxTurns: 4,
            persona: PERSONA, requirements: REQUIREMENTS,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "what is the hostname of this machine?" }],
        });
        await exec.idle();

        const turn2 = result.turnIds[1];
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turn2 });
        const packet = JSON.parse(row?.packet ?? "{}") as { system?: { index?: Array<{ scheme: string | null; pathname: string }> } };
        const paths = (packet.system?.index ?? []).map((e) => `${e.scheme}://${e.pathname}`);
        assert.ok(
            paths.some((p) => p.startsWith("exec://")),
            `demo-replica: exec result must surface under full base context; got ${JSON.stringify(paths)}`,
        );
    } finally { await db.close(); }
});

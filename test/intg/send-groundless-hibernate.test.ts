// §send-groundless-hibernate — a SEND[202] alongside a same-turn READ, with no wake edge, orphans the
// READ's result — it folds back on a next turn the park would never reach (the config-lookup dead-park:
// PLAN → READ → SEND[202] hung a demo tier for 40 minutes). Stays engine-side: the wake-edge test is
// RUNTIME state, not a shape the parser can judge.
// A bare park holding nothing stays LEGAL (the voice door, §actor-boundary-passive-wake) — only the
// orphaning shape refuses. Engine-level A/B so it's race-free.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertSession, insertRun, insertLoop, seedEntryWithChannel, DEFAULT_MIMETYPES } from "./_helpers.ts";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { sendStmt, readStmt, execStmt, urlPath } from "./_dsl.ts";

const setup = async (label: string) => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `${label}-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "park");
    await seedEntryWithChannel(db, { sessionId, scheme: "known", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, sessionId, runId, loopId, engine };
};

const readConfig = () => readStmt(urlPath("known", "/config.json"));

test("[§send-groundless-hibernate] READ + SEND[202] with no wake edge is refused 409 on the record + steers — the result is never orphaned", async () => {
    const { db, sessionId, runId, loopId, engine } = await setup("groundless");
    try {
        const result = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readConfig(), sendStmt(202, null, "waiting for the value")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "the turn stays a continue — the loop never parked");
        assert.equal(result.steerStruck, true, "the groundless-hibernate steer fired");
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "the LOOP stays 102 — a park that orphans its READ never lands");
        // The record is faithful: the SEND row keeps its [202] emission, stamped 409 (refused),
        // auto-surfacing in the errors section (status≥400) — never erased or rewritten.
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.equal(rows.find((r) => r.op === "SEND")?.status_rx, 409, "the SEND[202] row records the refusal as 409");
    } finally { await db.close(); }
});

test("[§send-groundless-hibernate] FIND + SEND[202] with no wake edge is refused 409 — the retrieval twin (benchmarks/run15)", async () => {
    // The live wedge: FIND(known:///**) returns 200, the model parks, nothing wakes it — an eternal
    // park that rode the READ-only scan. FIND/OPEN results fold back next turn exactly like READ.
    const { db, sessionId, runId, loopId, engine } = await setup("groundless-find");
    try {
        const find: PlurnkStatement = { op: "FIND", suffix: "", signal: null, target: { kind: "url", raw: "known:///**", scheme: "known", username: null, password: null, hostname: null, port: null, pathname: "/**", params: {}, fragment: null }, lineMarker: null, body: { dialect: "regex", raw: "#apple|lemon#", pattern: "apple|lemon", flags: "" }, position: { line: 1, column: 1 } };
        const result = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [find, sendStmt(202, null, "awaiting the survey")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "the turn stays a continue — the FIND-park never lands");
        assert.equal(result.steerStruck, true, "the groundless-hibernate steer fired on the FIND shape");
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.equal(rows.find((r) => r.op === "SEND")?.status_rx, 409, "the SEND[202] row records the refusal as 409");
    } finally { await db.close(); }
});

test("[§send-groundless-hibernate] a bare SEND[202] holding nothing parks cleanly — the voice door stays open", async () => {
    // No submitted READ → nothing orphaned. A sibling irc / operator inject can wake it
    // (§actor-boundary-passive-wake); the daemon surfaces the idle park as loop/quiesced.
    const { db, sessionId, runId, loopId, engine } = await setup("voice-door");
    try {
        const result = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(202, null, "awaiting instructions")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 202, "the bare park lands");
        assert.equal(result.steerStruck, false, "no steer for the voice door");
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 202, "the loop parked (resumable)");
    } finally { await db.close(); }
});

test("[§send-groundless-hibernate] READ + SEND[202] with a live CHILD parks cleanly — the wake delivers the result", async () => {
    const { db, sessionId, runId, loopId, engine } = await setup("grounded-child");
    try {
        // A live child run: its conclusion wakes the parked parent (§run-lifecycle-child-wake), whose
        // resumed turn then folds the READ result back — nothing is orphaned.
        const childRun = await insertRun(db, sessionId, runId);
        await insertLoop(db, childRun, 1, "worker");
        const result = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readConfig(), sendStmt(202, null, "awaiting worker")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 202, "the hibernate lands — the child is a wake edge");
        assert.equal(result.steerStruck, false, "no steer for a grounded park");
    } finally { await db.close(); }
});

test("[§send-groundless-hibernate] READ + EXEC + SEND[202] parks cleanly — a same-turn spawn grounds the park from the emission", async () => {
    const { db, sessionId, runId, loopId, engine } = await setup("grounded-spawn");
    try {
        // The pre-dispatch snapshot precedes the turn's own ops, so the spawn isn't held YET — the
        // emission scan grounds it (a wake-capable op this turn spares the park).
        const result = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readConfig(), execStmt("sh", "sleep 1"), sendStmt(202, null, "awaiting spawn")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.steerStruck, false, "a spawn-then-hibernate emission never strikes the groundless steer");
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.notEqual(rows.find((r) => r.op === "SEND")?.status_rx, 409, "the SEND[202] is not refused");
    } finally { await db.close(); }
});

test("[§send-groundless-hibernate] a model that won't stop orphan-parking STRIKES OUT — it can never dead-park", async () => {
    const { db, sessionId, runId, loopId, engine } = await setup("groundless-spinout");
    try {
        const provider = new Mock({ contextSize: 100000, responses: Array.from({ length: 6 }, () => ({ assistant: { content: "", reasoning: null, ops: [readConfig(), sendStmt(202, null, "waiting")] } })) });
        const result = await engine.runLoop({ provider, sessionId, runId, loopId, messages: [], maxTurns: 10, maxStrikes: 3 });
        // The rails abandon it (identical repeats may trip cycle 508 before the strike 500); either
        // way the guarantee holds: the orphaning park terminates legibly, it never hangs the runtime.
        assert.ok([500, 508].includes(result.finalStatus), `orphan-park spammer abandons via the rails; got ${result.finalStatus}`);
        assert.notEqual(result.finalStatus, 202, "the orphaning park NEVER lands");
    } finally { await db.close(); }
});

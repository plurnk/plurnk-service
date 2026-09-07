import test from "node:test";
import assert from "node:assert/strict";
import StrikeRail, { type StrikeOutcome } from "../../src/core/StrikeRail.ts";
import type { Db } from "../../src/core/Db.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

let db: Db;
let loopId: number;
test.beforeEach(async () => {
    db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "strike-state");
    const workerId = await insertWorker(db, workspaceId);
    loopId = await insertLoop(db, workerId, 1);
});
test.afterEach(async () => { await db.close(); });

const base = { waitRevision: 0, fingerprint: "READ(x)", steerStruck: false, minCycles: 3, maxCyclePeriod: 4, maxStrikes: 3 };
const outcome = (op: StrikeOutcome["op"], status: number): StrikeOutcome => ({ op, status });

test("a 409 status alone is soft because Engine supplies the premature-terminate strike", async () => {
    const rail = new StrikeRail(db);
    const verdict = await rail.assess(loopId, { ...base, outcomes: [outcome("SEND", 409)] });
    assert.equal(verdict.thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 0, "the status is not counted separately from Engine's steerStruck ruling");
});

test("a premature-terminate 409 strikes through steerStruck", async () => {
    const rail = new StrikeRail(db);
    // Same 409 status, but steerStruck TRUE (Engine sets it for a live-work refusal). Strikes.
    let crossed = false;
    for (const fp of ["SEND(a)", "SEND(b)", "SEND(c)"]) crossed = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [outcome("SEND", 409)], steerStruck: true })).thresholdCrossed || crossed;
    assert.equal(crossed, true, "discarding live work strikes out — steerStruck decides, not the raw 409");
});

test("a genuinely-spinning model is still caught — identical turns cycle-strike (508 backstop)", async () => {
    const rail = new StrikeRail(db);
    // The retrieval-preemie no-strike leaves the cycle detector as the backstop: a model repeating
    // the IDENTICAL read+conclude turn is loop-detected even with 409 soft.
    let cycleHit = false;
    for (let i = 0; i < 8; i++) cycleHit = (await rail.assess(loopId, { ...base, fingerprint: "READ(page)+SEND", outcomes: [outcome("SEND", 409)] })).cycleDetected || cycleHit;
    assert.equal(cycleHit, true, "identical repetition is loop-detected — the spin backstop survives the soft 409");
});

test("a non-EXEC hard failure (500-class status) still strikes normally", async () => {
    const rail = new StrikeRail(db);
    let crossed = false;
    for (const fp of ["EDIT(a)", "EDIT(b)", "EDIT(c)"]) crossed = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [outcome("EDIT", 500)] })).thresholdCrossed || crossed;
    assert.equal(crossed, true, "a non-soft failure status accrues strikes as ever");
});

test("executor evidence never strikes, wherever it surfaces (#425 F1)", async () => {
    // run14's shape: the engine materializes a failed command as a READ[500] carrying the
    // executor's problem identity; the model reads a failed stream and gets the same 500.
    const rail = new StrikeRail(db);
    const evidence = (op: StrikeOutcome["op"]): StrikeOutcome => ({ op, status: 500, problemType: "https://problems.plurnk.xyz/executor/subprocess/nonzero-exit" });
    let crossed = false;
    for (const fp of ["EXEC(a)", "EXEC(b)", "EXEC(c)", "EXEC(d)"]) crossed = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [evidence("READ"), evidence("READ")] })).thresholdCrossed;
    assert.equal(crossed, false, "four turns of red test runs are evidence, not strikes");
    assert.equal(await rail.streak(loopId), 0);
    // The same status without executor identity is a hard failure and strikes as before.
    let struck = false;
    for (const fp of ["READ(a)", "READ(b)", "READ(c)"]) struck = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [{ op: "READ", status: 500, problemType: "https://problems.plurnk.xyz/engine/dispatcher/scheme-handler-threw" }] })).thresholdCrossed;
    assert.equal(struck, true, "a non-executor 500 still strikes to the threshold");
});

test("EXEC errors are soft regardless of status", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, fingerprint: "EXEC(python3)", outcomes: [outcome("EXEC", 400)] });
    await rail.assess(loopId, { ...base, fingerprint: "EXEC(sh)", outcomes: [outcome("EXEC", 500)] });
    assert.equal(await rail.streak(loopId), 0, "an executor error remains evidence without pricing experimentation into the strike rail");
});

test("hard outcomes and terminal steering are the two non-cycle strike sources", async () => {
    const rail = new StrikeRail(db);
    assert.equal((await rail.assess(loopId, { ...base, fingerprint: "hard", outcomes: [outcome(null, 400)] })).thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 1);
    assert.equal((await rail.assess(loopId, { ...base, fingerprint: "steer", outcomes: [], steerStruck: true })).thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 2);
});

test("multiple sources still count once per turn, and a clean turn resets the streak", async () => {
    const rail = new StrikeRail(db);
    const struck = await rail.assess(loopId, {
        ...base,
        outcomes: [outcome("EDIT", 500)],
        steerStruck: true,
        maxStrikes: 2,
    });
    assert.equal(struck.thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 1, "one admitted turn contributes at most one strike");
    await rail.assess(loopId, { ...base, fingerprint: "clean", outcomes: [] });
    assert.equal(await rail.streak(loopId), 0);
});

test("{§loop-rail-continuity}: clean recovery after a park resets only this loop's streak", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, outcomes: [outcome("READ", 403)] });
    const lifecycle = new LoopLifecycle(db);
    assert.equal(await lifecycle.park(loopId), true);
    assert.equal(await lifecycle.wake(loopId), true);
    const resumed = new StrikeRail(db);
    assert.equal(await resumed.streak(loopId), 1);
    assert.equal((await resumed.assess(loopId, { ...base, waitRevision: 1, outcomes: [] })).cycleDetected, false);
    assert.equal(await resumed.streak(loopId), 0);

    const workspaceId = await insertWorkspace(db, "independent-rail");
    const workerId = await insertWorker(db, workspaceId);
    const otherLoopId = await insertLoop(db, workerId, 1);
    await resumed.assess(otherLoopId, { ...base, outcomes: [outcome("READ", 403)] });
    assert.equal(await resumed.streak(otherLoopId), 1);
    assert.equal(await resumed.streak(loopId), 0);
});

test("{§loop-rail-continuity}: reconstructing an owner does not renew the bounded cycle window", async () => {
    for (let i = 0; i < 2; i++) {
        assert.equal((await new StrikeRail(db).assess(loopId, { ...base, outcomes: [] })).cycleDetected, false);
    }
    assert.equal((await new StrikeRail(db).assess(loopId, { ...base, outcomes: [] })).cycleDetected, true);
    for (let i = 0; i < 20; i++) await new StrikeRail(db).assess(loopId, { ...base, outcomes: [] });
    const state = await db.strike_rail_state.get<{ cycle_history: string }>({ loop_id: loopId });
    assert.equal(JSON.parse(state!.cycle_history).length, base.minCycles * base.maxCyclePeriod);
});

test("{§loop-rail-continuity}: an unsuccessful park does not create a new cycle window", async () => {
    const lifecycle = new LoopLifecycle(db);
    assert.equal(await lifecycle.park(loopId), true);
    for (let i = 0; i < 2; i++) {
        assert.equal(await lifecycle.park(loopId), false, "an already parked loop cannot park twice");
        await new StrikeRail(db).assess(loopId, { ...base, waitRevision: 1, outcomes: [] });
    }
    assert.equal((await new StrikeRail(db).assess(loopId, { ...base, waitRevision: 1, outcomes: [] })).cycleDetected, true);
});

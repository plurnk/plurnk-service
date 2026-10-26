import test from "node:test";
import assert from "node:assert/strict";
import StrikeRail, { type StrikeOutcome } from "../../src/core/StrikeRail.ts";
import type { Db } from "../../src/core/Db.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop } from "./_db.ts";

let db: Db;
let loopId: number;
test.beforeEach(async () => {
    db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "strike-state");
    const sessionId = await insertSession(db, workspaceId);
    loopId = await insertLoop(db, sessionId, 1);
});
test.afterEach(async () => { await db.close(); });

const base = { waitRevision: 0, fingerprint: "READ(x)", progressed: false, cut: false, minCycles: 3, maxCyclePeriod: 4, maxStrikes: 3 };
const outcome = (op: StrikeOutcome["op"], status: number): StrikeOutcome => ({ op, status });

test("{§engine-rails} a 409 status alone is soft; no completion claim strikes ({§completion-joins-live-work}, {§completion-defers-to-results})", async () => {
    const rail = new StrikeRail(db);
    const verdict = await rail.assess(loopId, { ...base, outcomes: [outcome("SEND", 409)] });
    assert.equal(verdict.thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 0, "a soft status is never counted");
});

test("{§engine-rails} a genuinely-spinning model is still caught — identical turns cycle-strike (508 backstop)", async () => {
    const rail = new StrikeRail(db);
    // The retrieval-preemie no-strike leaves the cycle detector as the backstop: a model repeating
    // the IDENTICAL read+conclude turn is loop-detected even with 409 soft.
    let cycleHit = false;
    for (let i = 0; i < 8; i++) cycleHit = (await rail.assess(loopId, { ...base, fingerprint: "READ(page)+SEND", outcomes: [outcome("SEND", 409)] })).cycleDetected || cycleHit;
    assert.equal(cycleHit, true, "identical repetition is loop-detected — the spin backstop survives the soft 409");
});

test("{§engine-rails} a non-execution hard failure (500-class status) still strikes normally", async () => {
    const rail = new StrikeRail(db);
    let crossed = false;
    for (const fp of ["EDIT(a)", "EDIT(b)", "EDIT(c)"]) crossed = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [outcome("EDIT", 500)] })).thresholdCrossed || crossed;
    assert.equal(crossed, true, "a non-soft failure status accrues strikes as ever");
});

test("{§engine-rails} executor evidence never strikes, wherever it surfaces", async () => {
    // The engine materializes a failed command as a READ[500] carrying the
    // executor's problem identity; the model reads a failed stream and gets the same 500.
    const rail = new StrikeRail(db);
    const evidence = (op: StrikeOutcome["op"]): StrikeOutcome => ({ op, status: 500, problemType: "https://problems.plurnk.xyz/executor/subprocess/spawn-failed" });
    let crossed = false;
    for (const fp of ["execution(a)", "execution(b)", "execution(c)", "execution(d)"]) crossed = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [evidence("READ"), evidence("READ")] })).thresholdCrossed;
    assert.equal(crossed, false, "four turns of red test runs are evidence, not strikes");
    assert.equal(await rail.streak(loopId), 0);
    // The same status without executor identity is a hard failure and strikes as before.
    let struck = false;
    for (const fp of ["READ(a)", "READ(b)", "READ(c)"]) struck = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [{ op: "READ", status: 500, problemType: "https://problems.plurnk.xyz/engine/dispatcher/scheme-handler-threw" }] })).thresholdCrossed;
    assert.equal(struck, true, "a non-executor 500 still strikes to the threshold");
});

test("{§engine-rails} execution errors are soft regardless of status", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, fingerprint: "execution(python3)", outcomes: [outcome("python3", 400)] });
    await rail.assess(loopId, { ...base, fingerprint: "execution(sh)", outcomes: [outcome("sh", 500)] });
    assert.equal(await rail.streak(loopId), 0, "an executor error remains evidence without pricing experimentation into the strike rail");
});

test("{§engine-rails} hard outcomes are the non-cycle strike source and accumulate a streak", async () => {
    const rail = new StrikeRail(db);
    assert.equal((await rail.assess(loopId, { ...base, fingerprint: "hard", outcomes: [outcome(null, 400)] })).thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 1);
    assert.equal((await rail.assess(loopId, { ...base, fingerprint: "hard2", outcomes: [outcome("EDIT", 500)] })).thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 2);
});

test("{§engine-rails} multiple sources still count once per turn, and a clean turn resets the streak", async () => {
    const rail = new StrikeRail(db);
    const struck = await rail.assess(loopId, {
        ...base,
        outcomes: [outcome("EDIT", 500)],
        maxStrikes: 2,
    });
    assert.equal(struck.thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 1, "one admitted turn contributes at most one strike");
    await rail.assess(loopId, { ...base, fingerprint: "clean", outcomes: [] });
    assert.equal(await rail.streak(loopId), 0);
});

test("{§strike-progress-immunity}: a hard 400 beside a successful operation is progress and clears the streak", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, fingerprint: "failed", outcomes: [outcome("EDIT", 400)] });
    assert.equal(await rail.streak(loopId), 1);
    const productive = await rail.assess(loopId, {
        ...base,
        fingerprint: "productive",
        outcomes: [outcome("READ", 200), outcome(null, 400), outcome("EDIT", 400), outcome("NOTE", 201)],
        progressed: true,
        maxStrikes: 2,
    });
    assert.equal(productive.thresholdCrossed, false, "the turn that read successfully does not cross on its hard 400");
    assert.equal(productive.crossedBy, null, "the productive turn is not struck at all");
    assert.equal(await rail.streak(loopId), 0, "a productive turn counts as progress: the streak clears");
});

test("{§strike-progress-immunity}: turns without progress strike on their hard failures", async () => {
    const rail = new StrikeRail(db);
    const turns = [
        [outcome("NOTE", 201), outcome(null, 400)],
        [outcome("EDIT", 400), outcome("WAIT", 202)],
        [outcome("NOTE", 201), outcome("READ", 404), outcome("SEND", 200), outcome("KILL", 405)],
    ];
    const verdicts = [];
    for (const [index, outcomes] of turns.entries()) verdicts.push(await rail.assess(loopId, { ...base, fingerprint: `failed-${index}`, outcomes }));
    assert.deepEqual(verdicts.map(({ crossedBy }) => crossedBy), ["operation", "operation", "operation"]);
    assert.equal(verdicts.at(-1)?.thresholdCrossed, true, "three turns with no successful operation cross the threshold");
});

test("{§strike-progress-immunity}: a successful operation does not exempt a repeating turn from the cycle backstop", async () => {
    const rail = new StrikeRail(db);
    let crossed = null;
    for (let i = 0; i < base.minCycles * 3; i++) crossed = await rail.assess(loopId, { ...base, fingerprint: "READ(same)+EDIT(bad)", progressed: true, outcomes: [outcome("READ", 200), outcome("EDIT", 400)] });
    assert.equal(crossed?.cycleDetected, true);
    assert.equal(crossed?.crossedBy, "repetition");
    assert.equal(crossed?.thresholdCrossed, true);
});

test("{§loop-rail-continuity} {§output-allowance-notice}: a cut is no repetition evidence and closes the cycle window", async () => {
    const rail = new StrikeRail(db);
    const same = { ...base, fingerprint: "empty:", outcomes: [] };
    const cut = async () => (await rail.assess(loopId, { ...same, cut: true })).cycleDetected;
    assert.deepEqual([await cut(), await cut(), await cut(), await cut()], [false, false, false, false],
        "identical cut turns never repeat: the ceiling, not the model, ended each");
    await rail.assess(loopId, same);
    await rail.assess(loopId, same);
    assert.equal(await cut(), false);
    assert.equal((await rail.assess(loopId, same)).cycleDetected, false, "no repetition spans a cut");
    assert.equal((await rail.assess(loopId, same)).cycleDetected, false);
    assert.equal((await rail.assess(loopId, same)).cycleDetected, true, "the window the cut opened detects its own repetition");
});

test("{§engine-rails} {§output-allowance-notice}: a cut turn's strike is the allowance's, whatever else it struck on", async () => {
    const rail = new StrikeRail(db);
    const sources = [
        { emptyTurn: true, outcomes: [] },
        { emptyTurn: false, outcomes: [outcome(null, 500)] },
        { emptyTurn: false, outcomes: [outcome("EDIT", 400)] },
    ];
    const verdicts = [];
    for (const [index, turn] of sources.entries()) verdicts.push(await rail.assess(loopId, { ...base, ...turn, fingerprint: `cut-${index}`, cut: true }));
    assert.deepEqual(verdicts.map(({ crossedBy }) => crossedBy), ["output_allowance", "output_allowance", "output_allowance"]);
    assert.deepEqual(verdicts.map(({ cycleDetected }) => cycleDetected), [false, false, false]);
    assert.equal(verdicts.at(-1)?.thresholdCrossed, true, "a cut still strikes, so a model that keeps reaching the allowance stops");
    const progressed = await rail.assess(loopId, { ...base, cut: true, progressed: true, outcomes: [outcome("READ", 200), outcome(null, 400)] });
    assert.equal(progressed.crossedBy, null, "a cut turn that acted on the task is progress like any other");
    assert.equal(await rail.streak(loopId), 0);
});

test("{§loop-rail-continuity}: clean recovery after a park resets only this loop's streak", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, outcomes: [outcome("READ", 403)] });
    const lifecycle = new LoopLifecycle(db);
    assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
    assert.equal(await lifecycle.wake(loopId), true);
    const resumed = new StrikeRail(db);
    assert.equal(await resumed.streak(loopId), 1);
    assert.equal((await resumed.assess(loopId, { ...base, waitRevision: 1, outcomes: [] })).cycleDetected, false);
    assert.equal(await resumed.streak(loopId), 0);

    const workspaceId = await insertWorkspace(db, "independent-rail");
    const sessionId = await insertSession(db, workspaceId);
    const otherLoopId = await insertLoop(db, sessionId, 1);
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
    assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
    for (let i = 0; i < 2; i++) {
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), false, "an already parked loop cannot park twice");
        await new StrikeRail(db).assess(loopId, { ...base, waitRevision: 1, outcomes: [] });
    }
    assert.equal((await new StrikeRail(db).assess(loopId, { ...base, waitRevision: 1, outcomes: [] })).cycleDetected, true);
});

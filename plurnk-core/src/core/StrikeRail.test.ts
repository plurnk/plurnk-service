import test from "node:test";
import assert from "node:assert/strict";
import StrikeRail from "./StrikeRail.ts";

const base = { fingerprint: "READ(x)", noOps: false, budgetStruck: false, steerStruck: false, minCycles: 3, maxCyclePeriod: 4, maxStrikes: 3 };

test("[§send-premature-terminate] a retrieval-only 409 (steerStruck=false) does NOT strike — 409 is soft (#346 gap, firefast)", () => {
    const rail = new StrikeRail();
    // Three consecutive retrieval-preemie refusals: distinct fingerprints (varied targets, so no
    // cycle), status 409, steerStruck FALSE. The ruling: never a strike. Before the 409-soft fix,
    // recordedFailed counted each → streak 3 → 500. Now: soft, streak stays 0.
    for (const fp of ["READ(a)", "READ(b)", "READ(c)"]) {
        const v = rail.assess(1, { ...base, fingerprint: fp, statuses: [409] });
        assert.equal(v.thresholdCrossed, false, `retrieval-409 on ${fp} must not cross the strike threshold`);
    }
    assert.equal(rail.streak(1), 0, "no strikes accrued — retrieval preemies teach without striking");
});

test("[§send-premature-terminate] a stream/child 409 STILL strikes — via steerStruck, the authority", () => {
    const rail = new StrikeRail();
    // Same 409 status, but steerStruck TRUE (Engine sets it for a live-work refusal). Strikes.
    let crossed = false;
    for (const fp of ["SEND(a)", "SEND(b)", "SEND(c)"]) crossed = rail.assess(1, { ...base, fingerprint: fp, statuses: [409], steerStruck: true }).thresholdCrossed || crossed;
    assert.equal(crossed, true, "discarding live work strikes out — steerStruck decides, not the raw 409");
});

test("[§grinder-strike-coupling] a genuinely-spinning model is still caught — identical turns cycle-strike (508 backstop)", () => {
    const rail = new StrikeRail();
    // The retrieval-preemie no-strike leaves the cycle detector as the backstop: a model repeating
    // the IDENTICAL read+conclude turn is loop-detected even with 409 soft.
    let cycleHit = false;
    for (let i = 0; i < 8; i++) cycleHit = rail.assess(1, { ...base, fingerprint: "READ(page)+SEND", statuses: [409] }).cycleDetected || cycleHit;
    assert.equal(cycleHit, true, "identical repetition is loop-detected — the spin backstop survives the soft 409");
});

test("a real hard failure (500-class status) still strikes normally", () => {
    const rail = new StrikeRail();
    let crossed = false;
    for (const fp of ["EDIT(a)", "EDIT(b)", "EDIT(c)"]) crossed = rail.assess(1, { ...base, fingerprint: fp, statuses: [500] }).thresholdCrossed || crossed;
    assert.equal(crossed, true, "a non-soft failure status accrues strikes as ever");
});

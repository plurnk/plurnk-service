import test from "node:test";
import assert from "node:assert/strict";
import StrikeRail from "./StrikeRail.ts";
import { parsePath, type ReadStatement } from "@plurnk/plurnk-contracts";

const base = { fingerprint: "READ(x)", noOps: false, budgetStruck: false, steerStruck: false, minCycles: 3, maxCyclePeriod: 4, maxStrikes: 3 };

test("a 409 status alone is soft because Engine supplies the premature-terminate strike", () => {
    const rail = new StrikeRail();
    const verdict = rail.assess(1, { ...base, statuses: [409] });
    assert.equal(verdict.thresholdCrossed, false);
    assert.equal(rail.streak(1), 0, "the status is not counted separately from Engine's steerStruck ruling");
});

test("a premature-terminate 409 strikes through steerStruck", () => {
    const rail = new StrikeRail();
    // Same 409 status, but steerStruck TRUE (Engine sets it for a live-work refusal). Strikes.
    let crossed = false;
    for (const fp of ["SEND(a)", "SEND(b)", "SEND(c)"]) crossed = rail.assess(1, { ...base, fingerprint: fp, statuses: [409], steerStruck: true }).thresholdCrossed || crossed;
    assert.equal(crossed, true, "discarding live work strikes out — steerStruck decides, not the raw 409");
});

test("a genuinely-spinning model is still caught — identical turns cycle-strike (508 backstop)", () => {
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

test("network query and channel coordinates remain distinct cycle fingerprints", () => {
    const statement = (raw: string): ReadStatement => ({
        op: "READ",
        suffix: "",
        signal: null,
        target: parsePath(raw),
        lineMarker: null,
        body: null,
        position: { line: 1, column: 1 },
    });
    const first = StrikeRail.fingerprintTurn([statement("https://example.org/x?a=1&b=2#body")]);
    const reordered = StrikeRail.fingerprintTurn([statement("https://example.org/x?b=2&a=1#body")]);
    const channel = StrikeRail.fingerprintTurn([statement("https://example.org/x?a=1&b=2#header")]);
    assert.notEqual(first, reordered);
    assert.notEqual(first, channel);
});

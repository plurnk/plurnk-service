import test from "node:test";
import assert from "node:assert/strict";
import StrikeRail, { type StrikeOutcome } from "./StrikeRail.ts";
import { parsePath, type BareStatement, type ReadStatement } from "@plurnk/plurnk-contracts";

const base = { fingerprint: "READ(x)", steerStruck: false, minCycles: 3, maxCyclePeriod: 4, maxStrikes: 3 };
const outcome = (op: StrikeOutcome["op"], status: number): StrikeOutcome => ({ op, status });

test("a 409 status alone is soft because Engine supplies the premature-terminate strike", () => {
    const rail = new StrikeRail();
    const verdict = rail.assess(1, { ...base, outcomes: [outcome("SEND", 409)] });
    assert.equal(verdict.thresholdCrossed, false);
    assert.equal(rail.streak(1), 0, "the status is not counted separately from Engine's steerStruck ruling");
});

test("a premature-terminate 409 strikes through steerStruck", () => {
    const rail = new StrikeRail();
    // Same 409 status, but steerStruck TRUE (Engine sets it for a live-work refusal). Strikes.
    let crossed = false;
    for (const fp of ["SEND(a)", "SEND(b)", "SEND(c)"]) crossed = rail.assess(1, { ...base, fingerprint: fp, outcomes: [outcome("SEND", 409)], steerStruck: true }).thresholdCrossed || crossed;
    assert.equal(crossed, true, "discarding live work strikes out — steerStruck decides, not the raw 409");
});

test("a genuinely-spinning model is still caught — identical turns cycle-strike (508 backstop)", () => {
    const rail = new StrikeRail();
    // The retrieval-preemie no-strike leaves the cycle detector as the backstop: a model repeating
    // the IDENTICAL read+conclude turn is loop-detected even with 409 soft.
    let cycleHit = false;
    for (let i = 0; i < 8; i++) cycleHit = rail.assess(1, { ...base, fingerprint: "READ(page)+SEND", outcomes: [outcome("SEND", 409)] }).cycleDetected || cycleHit;
    assert.equal(cycleHit, true, "identical repetition is loop-detected — the spin backstop survives the soft 409");
});

test("a non-EXEC hard failure (500-class status) still strikes normally", () => {
    const rail = new StrikeRail();
    let crossed = false;
    for (const fp of ["EDIT(a)", "EDIT(b)", "EDIT(c)"]) crossed = rail.assess(1, { ...base, fingerprint: fp, outcomes: [outcome("EDIT", 500)] }).thresholdCrossed || crossed;
    assert.equal(crossed, true, "a non-soft failure status accrues strikes as ever");
});

test("EXEC errors are soft regardless of status", () => {
    const rail = new StrikeRail();
    rail.assess(1, { ...base, fingerprint: "EXEC(python)", outcomes: [outcome("EXEC", 400)] });
    rail.assess(1, { ...base, fingerprint: "EXEC(sh)", outcomes: [outcome("EXEC", 500)] });
    assert.equal(rail.streak(1), 0, "an executor error remains evidence without pricing experimentation into the strike rail");
});

test("hard outcomes and terminal steering are the two non-cycle strike sources", () => {
    const rail = new StrikeRail();
    assert.equal(rail.assess(1, { ...base, fingerprint: "hard", outcomes: [outcome(null, 400)] }).thresholdCrossed, false);
    assert.equal(rail.streak(1), 1);
    assert.equal(rail.assess(1, { ...base, fingerprint: "steer", outcomes: [], steerStruck: true }).thresholdCrossed, false);
    assert.equal(rail.streak(1), 2);
});

test("multiple sources still count once per turn, and a clean turn resets the streak", () => {
    const rail = new StrikeRail();
    const struck = rail.assess(1, {
        ...base,
        outcomes: [outcome("EDIT", 500)],
        steerStruck: true,
        maxStrikes: 2,
    });
    assert.equal(struck.thresholdCrossed, false);
    assert.equal(rail.streak(1), 1, "one admitted turn contributes at most one strike");
    rail.assess(1, { ...base, fingerprint: "clean", outcomes: [] });
    assert.equal(rail.streak(1), 0);
});

test("network query and channel coordinates remain distinct cycle fingerprints", () => {
    const statement = (raw: string): ReadStatement => ({
        op: "READ",
        delimiter: "",
        annotation: null,
        signal: null,
        target: parsePath(raw),
        metadata: null,
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

test("distinct BARE prompts remain distinct cycle activities", () => {
    const statement = (body: string): BareStatement => ({
        op: "BARE",
        delimiter: "0",
        annotation: null,
        signal: null,
        target: null,
        metadata: null,
        lineMarker: null,
        body,
        position: { line: 1, column: 1 },
    });
    assert.notEqual(
        StrikeRail.fingerprintTurn([statement("What is the capital of Germany?")]),
        StrikeRail.fingerprintTurn([statement("What is the capital of France?")]),
    );
});

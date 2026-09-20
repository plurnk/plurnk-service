import test from "node:test";
import assert from "node:assert/strict";
import LoopPolicies from "./LoopPolicies.ts";
import { OperationFailureError } from "./results.ts";

const KNOBS = ["PLURNK_SERVICE_PROPOSALS", "PLURNK_SERVICE_ATTENDED", "PLURNK_SERVICE_UNATTENDED_PROPOSALS"] as const;

const withPanel = (panel: Partial<Record<(typeof KNOBS)[number], string>>, body: () => void): void => {
    const prior = KNOBS.map((name) => [name, process.env[name]] as const);
    try {
        for (const [name, value] of Object.entries(panel)) process.env[name] = value;
        body();
    } finally {
        for (const [name, value] of prior) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
};

test("{§loop-policy-composition} the panel supplies exactly what a loop's creator left unsaid", () => {
    // The shipped panel: a creator with nothing to say gets an attended loop held for review.
    assert.deepEqual(LoopPolicies.compose({}), { proposals: "review", attended: true });
    assert.deepEqual(LoopPolicies.compose({ proposals: "reject" }), { proposals: "reject", attended: true });
    withPanel({ PLURNK_SERVICE_PROPOSALS: "accept" }, () => {
        assert.deepEqual(LoopPolicies.compose({}), { proposals: "accept", attended: true });
        assert.deepEqual(LoopPolicies.compose({ proposals: "review" }), { proposals: "review", attended: true }, "a stated field is never overruled");
    });
});

test("{§loop-policy-composition} attendance picks which disposition knob answers, so every panel state is lawful", () => {
    // `--auto` is this one statement: nobody is attending. The disposition is the panel's to supply,
    // and the shipped panel rejects — an effect nobody approved does not run.
    assert.deepEqual(LoopPolicies.compose({ attended: false }), { proposals: "reject", attended: false });
    withPanel({ PLURNK_SERVICE_UNATTENDED_PROPOSALS: "accept" }, () => {
        assert.deepEqual(LoopPolicies.compose({ attended: false }), { proposals: "accept", attended: false });
        assert.deepEqual(LoopPolicies.compose({}), { proposals: "review", attended: true }, "an attended loop never reads the unattended knob");
    });
    // A headless daemon: review stays on the panel unread, and nothing contradicts.
    withPanel({ PLURNK_SERVICE_ATTENDED: "0" }, () => {
        assert.deepEqual(LoopPolicies.compose({}), { proposals: "reject", attended: false });
        assert.deepEqual(LoopPolicies.compose({ attended: true }), { proposals: "review", attended: true });
        LoopPolicies.validateConfiguration();
    });
});

test("{§loop-attendance} only a creator's own statement can ask for a review nobody could give, and it is refused with the way out", () => {
    const refused = (stated: Parameters<typeof LoopPolicies.compose>[0]): void => {
        assert.throws(() => LoopPolicies.compose(stated), (error: unknown) => {
            assert.ok(error instanceof OperationFailureError);
            assert.equal(error.result.status, 400);
            assert.match(error.result.problem!.type, /daemon\/input\/loop-policy-invalid$/u);
            assert.match(error.result.problem!.detail!, /unattended loop cannot hold a proposal for review: nobody is present to answer/u);
            assert.equal(error.result.problem!.recovery, "State proposals accept or reject, or attend the loop.");
            return true;
        });
    };
    refused({ proposals: "review", attended: false });
    withPanel({ PLURNK_SERVICE_ATTENDED: "0" }, () => refused({ proposals: "review" }));
});

test("{§loop-policy-composition} an invalid panel fails boot by the knob's name", () => {
    LoopPolicies.validateConfiguration();
    withPanel({ PLURNK_SERVICE_PROPOSALS: "sometimes" }, () => assert.throws(
        () => LoopPolicies.validateConfiguration(),
        /PLURNK_SERVICE_PROPOSALS must be one of review, accept, reject; got "sometimes"/u,
    ));
    withPanel({ PLURNK_SERVICE_UNATTENDED_PROPOSALS: "review" }, () => assert.throws(
        () => LoopPolicies.validateConfiguration(),
        /PLURNK_SERVICE_UNATTENDED_PROPOSALS must be one of accept, reject; got "review"/u,
    ));
    withPanel({ PLURNK_SERVICE_ATTENDED: "yes" }, () => assert.throws(
        () => LoopPolicies.validateConfiguration(),
        /PLURNK_SERVICE_ATTENDED must be 0 or 1; got "yes"/u,
    ));
});

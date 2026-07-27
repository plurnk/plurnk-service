import assert from "node:assert/strict";
import test from "node:test";
import { resolveCandidateModel } from "./candidate-model.mjs";

test("candidate model overrides the operator's ordinary model", () => {
    assert.equal(resolveCandidateModel({
        PLURNK_CANDIDATE_MODEL: "firefast",
        PLURNK_MODEL: "turboderp",
    }), "firefast");
});

test("candidate model falls back to the operator's ordinary model", () => {
    assert.equal(resolveCandidateModel({ PLURNK_MODEL: "turboderp" }), "turboderp");
});

test("candidate model remains unset when neither knob is configured", () => {
    assert.equal(resolveCandidateModel({}), undefined);
});

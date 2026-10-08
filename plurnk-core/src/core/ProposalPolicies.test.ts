import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import ProposalPolicies from "./ProposalPolicies.ts";
import { OperationFailureError } from "./results.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";

const originalPolicy = process.env.PLURNK_SERVICE_PROPOSALS;
afterEach(() => {
    if (originalPolicy === undefined) delete process.env.PLURNK_SERVICE_PROPOSALS;
    else process.env.PLURNK_SERVICE_PROPOSALS = originalPolicy;
});

test("{§worker-owner-resolution}: server disposition and declared review capability determine settlement", () => {
    for (const [policy, tools, expected] of [
        ["review", ["request_approval"], { decision: "review" }],
        ["review", ["question"], { decision: "reject", outcome: "no_review_channel" }],
        ["review", [], { decision: "reject", outcome: "no_review_channel" }],
        ["accept", [], { decision: "accept" }],
        ["accept", ["request_approval"], { decision: "accept" }],
        ["reject", ["request_approval"], { decision: "reject", outcome: "policy_veto" }],
    ] as const) {
        process.env.PLURNK_SERVICE_PROPOSALS = policy;
        assert.deepEqual(ProposalPolicies.disposition(tools, false), expected);
    }
});

test("{§runtime-bookkeeping-policy}: maintenance cannot acquire approval authority, even with an invalid panel", () => {
    for (const policy of ["review", "accept", "reject", "invalid"]) {
        process.env.PLURNK_SERVICE_PROPOSALS = policy;
        assert.deepEqual(ProposalPolicies.disposition(["request_approval"], true), { decision: "reject", outcome: "runtime_bookkeeping" });
    }
});

test("{§configuration-repair-path}: invalid server disposition is diagnosed without substituting authority", () => {
    process.env.PLURNK_SERVICE_PROPOSALS = "sometimes";
    assert.throws(() => ProposalPolicies.read(), ConfigurationError);
    assert.throws(() => ProposalPolicies.disposition(["request_approval"], false), (error: unknown) => {
        assert.ok(error instanceof OperationFailureError);
        assert.equal(error.result.status, 503);
        assert.equal(error.result.problem.key, "PLURNK_SERVICE_PROPOSALS");
        assert.ok(error.cause instanceof Error);
        return true;
    });
});

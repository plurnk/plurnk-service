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

const MODEL_TURN = { maintenance: false, clientOperation: false };
const CLIENT_OPERATION = { maintenance: false, clientOperation: true };

test("{§proposal-disposition}: server disposition, the turn's producer and declared review capability determine settlement", () => {
    for (const [policy, tools, turn, expected] of [
        ["review", ["request_approval"], MODEL_TURN, { decision: "review" }],
        ["review", ["question"], MODEL_TURN, { decision: "reject", outcome: "no_review_channel" }],
        ["review", [], MODEL_TURN, { decision: "reject", outcome: "no_review_channel" }],
        ["review", ["request_approval"], CLIENT_OPERATION, { decision: "accept", outcome: "client_operation" }],
        ["review", [], CLIENT_OPERATION, { decision: "accept", outcome: "client_operation" }],
        ["accept", [], MODEL_TURN, { decision: "accept" }],
        ["accept", ["request_approval"], MODEL_TURN, { decision: "accept" }],
        ["accept", [], CLIENT_OPERATION, { decision: "accept" }],
        ["reject", ["request_approval"], MODEL_TURN, { decision: "reject", outcome: "policy_veto" }],
        ["reject", ["request_approval"], CLIENT_OPERATION, { decision: "reject", outcome: "policy_veto" }],
    ] as const) {
        process.env.PLURNK_SERVICE_PROPOSALS = policy;
        assert.deepEqual(ProposalPolicies.disposition(tools, turn), expected, `${policy}, ${turn.clientOperation ? "a client operation" : "a model turn"}, [${tools.join(", ")}]`);
    }
});

test("{§proposal-disposition}: maintenance cannot acquire approval authority, even with an invalid panel", () => {
    for (const policy of ["review", "accept", "reject", "invalid"]) {
        process.env.PLURNK_SERVICE_PROPOSALS = policy;
        for (const clientOperation of [false, true]) {
            assert.deepEqual(ProposalPolicies.disposition(["request_approval"], { maintenance: true, clientOperation }),
                { decision: "reject", outcome: "runtime_bookkeeping" });
        }
    }
});

test("{§configuration-repair-path}: invalid server disposition is diagnosed without substituting authority", () => {
    process.env.PLURNK_SERVICE_PROPOSALS = "sometimes";
    assert.throws(() => ProposalPolicies.read(), ConfigurationError);
    assert.throws(() => ProposalPolicies.disposition(["request_approval"], MODEL_TURN), (error: unknown) => {
        assert.ok(error instanceof OperationFailureError);
        assert.equal(error.result.status, 503);
        assert.equal(error.result.problem.key, "PLURNK_SERVICE_PROPOSALS");
        assert.ok(error.cause instanceof Error);
        return true;
    });
});

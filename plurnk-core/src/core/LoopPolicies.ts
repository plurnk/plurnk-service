import { PROPOSAL_POLICIES, Validator, type LoopPolicy, type LoopPolicyRequest } from "@plurnk/plurnk-contracts";
import Knob from "./Knob.ts";
import Results, { OperationFailureError } from "./results.ts";

// {§loop-policy-composition} — a loop's policy is what its creator stated over what the panel
// says, composed once, where the loop is persisted. Every panel state is lawful: attendance picks
// which disposition knob answers, so only a creator's own statement can contradict itself.
export default class LoopPolicies {
    // Nobody is present to review in an unattended loop, so review is not a choice there.
    static readonly #UNATTENDED = PROPOSAL_POLICIES.filter((policy) => policy !== "review");

    static compose(stated: LoopPolicyRequest): LoopPolicy {
        const attended = stated.attended ?? Knob.flag("PLURNK_SERVICE_ATTENDED");
        const policy = {
            proposals: stated.proposals ?? LoopPolicies.#proposals(attended),
            attended,
        };
        if (Validator.validateLoopPolicy(policy).valid) return policy;
        throw new OperationFailureError(Results.failure(
            "daemon:input",
            "loop-policy-invalid",
            400,
            "An unattended loop cannot hold a proposal for review: nobody is present to answer.",
            {},
            {
                field: "policy",
                stage: "loop-policy-composition",
                recovery: "State proposals accept or reject, or attend the loop.",
                retryable: false,
            },
        ));
    }

    // An invalid panel fails boot by the knob's name, not the first loop.
    static validateConfiguration(): void {
        Knob.flag("PLURNK_SERVICE_ATTENDED");
        LoopPolicies.#proposals(true);
        LoopPolicies.#proposals(false);
    }

    static #proposals(attended: boolean): LoopPolicy["proposals"] {
        return attended
            ? Knob.choice("PLURNK_SERVICE_PROPOSALS", PROPOSAL_POLICIES)
            : Knob.choice("PLURNK_SERVICE_UNATTENDED_PROPOSALS", LoopPolicies.#UNATTENDED);
    }
}

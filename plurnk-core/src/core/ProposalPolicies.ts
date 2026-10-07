import { PROPOSAL_POLICIES, type ProposalDisposition, type ProposalPolicy } from "@plurnk/plurnk-contracts";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import Results, { OperationFailureError } from "./results.ts";

const shedRetiredPolicy = (): void => {
    for (const key of ["PLURNK_SERVICE_ATTENDED", "PLURNK_SERVICE_UNATTENDED_PROPOSALS"]) {
        if (process.env[key] !== undefined) throw new ConfigurationError(key,
            `${key} is retired: the worker's owner handles review; use PLURNK_SERVICE_PROPOSALS for server approval.`);
    }
};

// {§worker-owner-resolution} Messages do not supply policy; connection presence is irrelevant.
export default class ProposalPolicies {
    static read(): ProposalPolicy {
        shedRetiredPolicy();
        return Knob.choice("PLURNK_SERVICE_PROPOSALS", PROPOSAL_POLICIES);
    }

    static disposition(tools: readonly string[], maintenance: boolean): ProposalDisposition {
        // {§runtime-bookkeeping-policy} Unexpected maintenance effects never acquire authority.
        if (maintenance) return { decision: "reject", outcome: "runtime_bookkeeping" };
        try {
            const decision = ProposalPolicies.read();
            if (decision !== "review") return { decision, ...(decision === "reject" ? { outcome: "policy_veto" } : {}) };
            return tools.includes("request_approval")
                ? { decision: "review" }
                : { decision: "reject", outcome: "no_review_channel" };
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
    }

}

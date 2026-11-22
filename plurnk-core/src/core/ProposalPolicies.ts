import { PROPOSAL_POLICIES, type ProposalDisposition, type ProposalPolicy } from "@plurnk/plurnk-contracts";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import Results, { OperationFailureError } from "./results.ts";
import type { StandingPermission } from "./workspace-settings.ts";

// {§session-ownership} The server's approval disposition; review routes to the session's owner.
export default class ProposalPolicies {
    static read(): ProposalPolicy {
        return Knob.choice("PLURNK_SERVICE_PROPOSALS", PROPOSAL_POLICIES);
    }

    static effective(
        workspacePolicy: ProposalPolicy | null,
        sessionPolicy: ProposalPolicy | null = null,
        loopPolicy: ProposalPolicy | null = null,
    ): ProposalPolicy {
        if (loopPolicy !== null) return loopPolicy;
        if (sessionPolicy !== null) return sessionPolicy;
        if (workspacePolicy !== null) return workspacePolicy;
        try {
            return ProposalPolicies.read();
        } catch (cause) {
            if (cause instanceof ConfigurationError) return "review";
            throw cause;
        }
    }

    static disposition(
        tools: readonly string[],
        turn: {
            readonly maintenance: boolean;
            readonly clientOperation: boolean;
            readonly workspacePolicy?: ProposalPolicy | null;
            readonly sessionPolicy?: ProposalPolicy | null;
            readonly loopPolicy?: ProposalPolicy | null;
            readonly standing?: StandingPermission;
        },
    ): ProposalDisposition {
        // {§proposal-disposition} Unexpected maintenance effects never acquire authority.
        if (turn.maintenance) return { decision: "reject", outcome: "runtime_bookkeeping" };
        try {
            const policy =
                turn.loopPolicy ??
                turn.sessionPolicy ??
                turn.workspacePolicy ??
                ProposalPolicies.read();
            if (policy !== "review") return { decision: policy, ...(policy === "reject" ? { outcome: "policy_veto" } : {}) };
            // {§proposal-disposition} A person's client operation is that person's decision already.
            if (turn.clientOperation) return { decision: "accept", outcome: "client_operation" };
            if (turn.standing === "allow_always") return { decision: "accept", outcome: "allow_always" };
            if (turn.standing === "reject_always") return { decision: "reject", outcome: "reject_always" };
            return tools.includes("request_approval")
                ? { decision: "review" }
                : { decision: "reject", outcome: "no_review_channel" };
        } catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
    }
}

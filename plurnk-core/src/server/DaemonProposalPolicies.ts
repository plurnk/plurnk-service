// {§methods} {§proposal} — Daemon boundary validation and persistence for proposals, client interactions,
// and workspace/session proposal policies.

import {
    PROPOSAL_POLICIES,
    type ApplicationOwnerIdentity,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type ProposalPolicy,
    type ProposalProjection,
    type ProposalResolution,
} from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import ProposalPolicies from "../core/ProposalPolicies.ts";
import WorkspaceConfig from "../core/WorkspaceConfig.ts";
import ClientInput from "./client-input.ts";
import { daemonFailure } from "./daemon-results.ts";
import type SessionModels from "./SessionModels.ts";

export interface DaemonProposalPolicyResult {
    readonly policy: ProposalPolicy | null;
    readonly effective: ProposalPolicy;
}

const assertOptionalProposalPolicy = (policy: ProposalPolicy | null): void => {
    if (policy !== null && (typeof policy !== "string" || !(PROPOSAL_POLICIES as readonly string[]).includes(policy))) {
        throw daemonFailure(
            "daemon:input",
            "proposal-policy-invalid",
            400,
            `policy must be null or one of ${PROPOSAL_POLICIES.join(", ")}.`,
            { field: "policy", allowedPolicies: [...PROPOSAL_POLICIES], retryable: false },
        );
    }
};

export const readPendingProposals = (engine: Engine, workspaceId: number): Promise<ProposalProjection[]> =>
    engine.pendingProposals(ClientInput.assertId("pendingProposals", "workspaceId", workspaceId));

export const resolvePendingProposal = async (
    db: Db,
    engine: Engine,
    logEntryId: number,
    resolution: ProposalResolution,
    owner: ApplicationOwnerIdentity,
): Promise<void> => {
    const checkedLogEntryId = ClientInput.assertId("resolveProposal", "logEntryId", logEntryId);
    const checkedResolution = ClientInput.assertProposalResolution("resolveProposal", resolution);
    const workspaceId = ClientInput.assertId("resolveProposal", "workspaceId", owner.workspaceId);
    const pending = await db.session_owner_for_proposal.get<{ workspaceId: number; owner: string }>({
        log_entry_id: checkedLogEntryId,
    });
    if (pending !== undefined && (pending.workspaceId !== workspaceId || pending.owner !== owner.address)) {
        throw daemonFailure(
            "proposal:resolution",
            "owner-mismatch",
            403,
            "Only the session's owner may resolve this proposal.",
            { logEntryId: checkedLogEntryId },
        );
    }
    await engine.resolveProposal(checkedLogEntryId, checkedResolution, owner.address);
};

export const readPendingClientInteractions = (
    engine: Engine,
    workspaceId: number,
): Promise<ClientInteractionProjection[]> =>
    engine.pendingClientInteractions(ClientInput.assertId("pendingClientInteractions", "workspaceId", workspaceId));

export const resolvePendingClientInteraction = async (
    engine: Engine,
    interactionId: number,
    resolution: ClientInteractionResolution,
    respondent: ApplicationOwnerIdentity,
    message?: { readonly body: string; readonly source: string; readonly envelope: Readonly<Record<string, unknown>> },
): Promise<void> => {
    const checkedInteractionId = ClientInput.assertId("resolveClientInteraction", "interactionId", interactionId);
    const checkedResolution = ClientInput.assertClientInteractionResolution("resolveClientInteraction", resolution);
    if (message !== undefined) {
        ClientInput.assertPrompt("resolveClientInteraction", message.body);
        ClientInput.assertOptionalSource("resolveClientInteraction", message.source);
    }
    ClientInput.assertId("resolveClientInteraction", "workspaceId", respondent.workspaceId);
    await engine.resolveClientInteraction(checkedInteractionId, checkedResolution, respondent, message);
};

const readStoredWorkspaceProposalPolicy = async (db: Db, workspaceId: number): Promise<ProposalPolicy | null> => {
    const raw = await WorkspaceConfig.readRawKey(db, workspaceId, "PLURNK_SERVICE_PROPOSALS");
    if (raw === undefined) return null;
    const matched = PROPOSAL_POLICIES.find((candidate) => candidate === raw);
    if (matched === undefined) {
        throw new Error(`Workspace ${workspaceId} has invalid persisted proposal policy ${JSON.stringify(raw)}.`);
    }
    return matched;
};

export const readWorkspacePolicy = async (db: Db, rawWorkspaceId: number): Promise<DaemonProposalPolicyResult> => {
    const workspaceId = ClientInput.assertId("workspace.proposalPolicy.get", "workspaceId", rawWorkspaceId);
    const row = await db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId });
    if (row === undefined) {
        throw daemonFailure("daemon:workspace", "workspace-not-found", 404, `Workspace ${workspaceId} does not exist.`, {
            workspaceId,
        });
    }
    const policy = await readStoredWorkspaceProposalPolicy(db, workspaceId);
    return { policy, effective: ProposalPolicies.effective(policy) };
};

export const setWorkspacePolicy = async (
    db: Db,
    rawWorkspaceId: number,
    policy: ProposalPolicy | null,
): Promise<DaemonProposalPolicyResult> => {
    const workspaceId = ClientInput.assertId("workspace.proposalPolicy.set", "workspaceId", rawWorkspaceId);
    assertOptionalProposalPolicy(policy);
    const row = await db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId });
    if (row === undefined) {
        throw daemonFailure("daemon:workspace", "workspace-not-found", 404, `Workspace ${workspaceId} does not exist.`, {
            workspaceId,
        });
    }
    if (policy === null) {
        await WorkspaceConfig.remove(db, workspaceId, "PLURNK_SERVICE_PROPOSALS");
    } else {
        await WorkspaceConfig.put(db, workspaceId, "PLURNK_SERVICE_PROPOSALS", policy);
    }
    return { policy, effective: ProposalPolicies.effective(policy) };
};

export const readSessionPolicy = async (
    db: Db,
    sessionModels: SessionModels,
    rawWorkspaceId: number,
    rawSessionId: number,
): Promise<DaemonProposalPolicyResult> => {
    const workspaceId = ClientInput.assertId("session.proposalPolicy.get", "workspaceId", rawWorkspaceId);
    const sessionId = ClientInput.assertId("session.proposalPolicy.get", "sessionId", rawSessionId);
    await sessionModels.assertModelSession(workspaceId, sessionId);
    const [workspacePolicy, sessionRow] = await Promise.all([
        readStoredWorkspaceProposalPolicy(db, workspaceId),
        db.session_proposal_policy_read.get<{ proposal_policy: ProposalPolicy | null }>({
            workspace_id: workspaceId,
            id: sessionId,
        }),
    ]);
    const policy = sessionRow?.proposal_policy ?? null;
    return { policy, effective: ProposalPolicies.effective(workspacePolicy, policy) };
};

export const setSessionPolicy = async (args: {
    readonly db: Db;
    readonly engine: Engine;
    readonly sessionModels: SessionModels;
    readonly announceSessionPolicy: (sessionId: number) => Promise<void>;
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly policy: ProposalPolicy | null;
}): Promise<DaemonProposalPolicyResult> => {
    const { db, engine, sessionModels, announceSessionPolicy, policy } = args;
    const workspaceId = ClientInput.assertId("session.proposalPolicy.set", "workspaceId", args.workspaceId);
    const sessionId = ClientInput.assertId("session.proposalPolicy.set", "sessionId", args.sessionId);
    await sessionModels.assertModelSession(workspaceId, sessionId);
    assertOptionalProposalPolicy(policy);
    await db.session_proposal_policy_update.get<{ id: number }>({
        workspace_id: workspaceId,
        id: sessionId,
        policy,
    });
    const workspacePolicy = await readStoredWorkspaceProposalPolicy(db, workspaceId);
    const effective = ProposalPolicies.effective(workspacePolicy, policy);
    await announceSessionPolicy(sessionId);
    if (effective === "accept") {
        const pending = await engine.pendingProposals(workspaceId);
        for (const item of pending) {
            if (item.sessionId !== sessionId || item.disposition.decision !== "review") continue;
            try {
                await engine.resolveProposal(item.logEntryId, { decision: "accept", outcome: "policy_accept" }, item.owner);
            } catch {
                // Already settled concurrently.
            }
        }
    }
    return { policy, effective };
};

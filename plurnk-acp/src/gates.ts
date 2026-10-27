// {§acp-proposal-resolve} {§acp-session-owner} Permission and elicitation gate translation and first-responder-wins peer arbitration.

import {
    methods,
    type CreateElicitationRequest,
    type ElicitationSchema,
    type RequestPermissionRequest,
    type SessionUpdate,
    type ToolCallContent,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    Problems,
    isRecord,
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type ProblemDetails,
    type ProposalProjection,
    type ProposalResolution,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { buildUnifiedDiff } from "./diff.ts";
import { OWNER_ADDRESS, type AcpPeer, type BoundSession } from "./sessions.ts";
import SessionTranslator from "./SessionTranslator.ts";

interface Resolution extends ProposalResolution {
    readonly logEntryId: number;
}

interface InteractionResolution {
    readonly interactionId: number;
    readonly resolution: ClientInteractionResolution;
}

const proposalKey = (logEntryId: number): string => `proposal:${logEntryId}`;

const interactionToolCallId = (interactionId: number): string => `int:${interactionId}`;

const STANDARD_PERMISSION_OPTIONS = [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" as const },
    { optionId: "allow_always", name: "Allow always", kind: "allow_always" as const },
    { optionId: "reject_once", name: "Reject once", kind: "reject_once" as const },
    { optionId: "reject_always", name: "Reject always", kind: "reject_always" as const },
];

const proposalToolCall = (
    proposal: ProposalProjection,
): Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> => {
    const attrs = isRecord(proposal.attrs) ? proposal.attrs : {};
    const target =
        proposal.target?.pathname ??
        proposal.target?.scheme ??
        (typeof attrs.path === "string" ? attrs.path : null);
    const subject = proposal.subject;
    const title = subject?.type === "tool_call"
        ? subject.title
        : target === null
            ? proposal.op
            : `${proposal.op} (${target})`;
    const kind = subject?.type === "tool_call"
        ? subject.kind
        : SessionTranslator.toolKindOf(proposal.op, proposal.target?.scheme ?? null);
    const locations = subject?.type === "tool_call"
        ? subject.locations
        : target !== null
            ? [{ path: target }]
            : undefined;
    const content: ToolCallContent[] = [];
    if (subject?.type === "tool_call" && subject.diff !== undefined) {
        content.push({
            type: "diff",
            changes: [{ operation: "modify", path: subject.diff.path }],
            patch: {
                format: "git_patch",
                text: subject.diff.patch,
            },
        });
    } else if (typeof attrs.patch === "string" && attrs.patch.length > 0) {
        const path = target ?? "";
        content.push({
            type: "diff",
            changes: [{ operation: "modify", path }],
            patch: {
                format: "git_patch",
                text: attrs.patch,
            },
        });
    } else if (typeof attrs.original === "string" && typeof attrs.patched === "string") {
        const path = target ?? "";
        content.push({
            type: "diff",
            changes: [{ operation: "modify", path }],
            patch: {
                format: "git_patch",
                text: buildUnifiedDiff(path, attrs.original, attrs.patched),
            },
        });
    } else {
        const bodyText = typeof proposal.body === "string"
            ? proposal.body
            : typeof attrs.body === "string"
                ? attrs.body
                : "";
        if (bodyText.length > 0) {
            content.push({
                type: "content",
                content: { type: "text", text: bodyText },
            });
        }
    }
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: proposalKey(proposal.logEntryId),
        name: proposal.op,
        title,
        kind,
        status: "pending",
        ...(locations !== undefined ? { locations } : {}),
        ...(content.length > 0 ? { content } : {}),
        rawInput: {
            op: proposal.op,
            target: proposal.target ?? null,
            ...(proposal.body !== undefined && proposal.body !== null ? { body: proposal.body } : {}),
        },
        _meta: {
            plurnk: {
                proposal,
            },
        },
    };
};

const proposalPermissionRequest = (
    sessionId: string,
    proposal: ProposalProjection,
): RequestPermissionRequest => {
    const attrs = isRecord(proposal.attrs) ? proposal.attrs : {};
    const target =
        proposal.target?.pathname ??
        proposal.target?.scheme ??
        (typeof attrs.path === "string" ? attrs.path : null);
    const title = target === null ? proposal.op : `${proposal.op} (${target})`;

    if (proposal.subject?.type === "command") {
        return {
            sessionId,
            title,
            description: "Review the requested command.",
            subject: {
                type: "command",
                command: proposal.subject.command,
                cwd: proposal.subject.cwd,
            },
            options: [...STANDARD_PERMISSION_OPTIONS],
            _meta: {
                plurnk: {
                    proposal,
                },
            },
        };
    }

    const toolCall = proposalToolCall(proposal);
    const { sessionUpdate: _, ...toolCallFields } = toolCall;
    return {
        sessionId,
        title: toolCall.title ?? title,
        description: "Review the requested action.",
        subject: {
            type: "tool_call",
            toolCall: toolCallFields,
        },
        options: [...STANDARD_PERMISSION_OPTIONS],
        _meta: {
            plurnk: {
                proposal,
            },
        },
    };
};

const resolutionFromPermissionResponse = (
    logEntryId: number,
    response: unknown,
): Resolution | null => {
    if (!Number.isSafeInteger(logEntryId) || logEntryId <= 0) return null;
    if (!isRecord(response) || !isRecord(response.outcome)) return null;

    const kind = response.outcome.outcome;
    if (kind === "cancelled") {
        return { logEntryId, decision: "cancel" };
    }
    if (kind === "selected") {
        const optionId = response.outcome.optionId;
        if (optionId === "allow_once") {
            return { logEntryId, decision: "accept", scope: "once" };
        }
        if (optionId === "allow_always") {
            return { logEntryId, decision: "accept", scope: "always", outcome: "allow_always" };
        }
        if (optionId === "reject_once") {
            return { logEntryId, decision: "reject", scope: "once" };
        }
        if (optionId === "reject_always") {
            return { logEntryId, decision: "reject", scope: "always", outcome: "reject_always" };
        }
    }
    return null;
};

const interactionToolCall = (interaction: ClientInteractionProjection): SessionUpdate => ({
    sessionUpdate: "tool_call_update",
    toolCallId: interactionToolCallId(interaction.interactionId),
    name: interaction.request.toolName,
    title: interaction.request.toolName,
    kind: "other",
    status: "in_progress",
    rawInput: interaction.request,
    _meta: {
        plurnk: {
            interaction,
        },
    },
});

const interactionToolCallResult = (
    interactionId: number,
    resolution: ClientInteractionResolution,
): SessionUpdate => ({
    sessionUpdate: "tool_call_update",
    toolCallId: interactionToolCallId(interactionId),
    status: resolution.action === "accept" ? "completed" : "failed",
    rawOutput: resolution,
    content: [{ type: "content", content: { type: "text", text: JSON.stringify(resolution) } }],
});

const interactionElicitationRequest = (
    sessionId: string,
    interaction: ClientInteractionProjection,
): CreateElicitationRequest => {
    const { request } = interaction;
    if (request.mode === "url") {
        return {
            scope: "session",
            sessionId,
            toolCallId: interactionToolCallId(interaction.interactionId),
            mode: "url",
            message: request.message,
            elicitationId: request.elicitationId,
            url: request.url,
            _meta: {
                plurnk: {
                    interaction,
                },
            },
        };
    }
    const rawSchema = request.requestedSchema;
    const schema = rawSchema.type === "object"
        ? { properties: {}, ...rawSchema }
        : {
            type: "object",
            properties: {
                value: rawSchema,
            },
        };
    return {
        scope: "session",
        sessionId,
        toolCallId: interactionToolCallId(interaction.interactionId),
        mode: "form",
        message: request.message,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        requestedSchema: schema as unknown as ElicitationSchema,
        _meta: {
            plurnk: {
                interaction,
            },
        },
    };
};

const interactionResolutionFromResponse = (
    interactionId: number,
    response: unknown,
): InteractionResolution | null => {
    if (!Number.isSafeInteger(interactionId) || interactionId <= 0) return null;
    if (!isRecord(response)) return null;

    if (response.action === "cancel" || response.action === "decline") {
        return { interactionId, resolution: { action: response.action } };
    }
    if (response.action === "accept") {
        return {
            interactionId,
            resolution: {
                action: "accept",
                ...(isRecord(response.content) ? { content: response.content } : {}),
            },
        };
    }
    return null;
};

export interface ActiveGate {
    readonly key: string;
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly kind: "proposal" | "interaction";
    readonly proposal?: ProposalProjection;
    readonly interaction?: ClientInteractionProjection;
    readonly peerControllers: Map<AcpPeer, AbortController>;
    settled: boolean;
}

export class GateTracker {
    readonly #activeGates = new Map<string, ActiveGate>();

    openOrGet(
        workspaceId: number,
        sessionId: number,
        kind: "proposal" | "interaction",
        proposal?: ProposalProjection,
        interaction?: ClientInteractionProjection,
    ): ActiveGate {
        const id = kind === "proposal" ? proposal!.logEntryId : interaction!.interactionId;
        const key = `${workspaceId}:${kind}:${id}`;
        let gate = this.#activeGates.get(key);
        if (gate === undefined || gate.settled) {
            gate = {
                key,
                workspaceId,
                sessionId,
                kind,
                proposal,
                interaction,
                peerControllers: new Map(),
                settled: false,
            };
            this.#activeGates.set(key, gate);
        }
        return gate;
    }

    cancelProposalIfSettled(workspaceId: number, entryId: number, state: string): void {
        if (state === "proposed") return;
        const gateKey = `${workspaceId}:proposal:${entryId}`;
        const existingGate = this.#activeGates.get(gateKey);
        if (existingGate !== undefined) {
            existingGate.settled = true;
            this.#activeGates.delete(gateKey);
            for (const ctrl of existingGate.peerControllers.values()) ctrl.abort();
            existingGate.peerControllers.clear();
        }
    }

    cancelSessionGates(workspaceId: number, sessionId: number): void {
        for (const [key, gate] of this.#activeGates.entries()) {
            if (gate.workspaceId === workspaceId && gate.sessionId === sessionId) {
                gate.settled = true;
                this.#activeGates.delete(key);
                for (const ctrl of gate.peerControllers.values()) ctrl.abort();
                gate.peerControllers.clear();
            }
        }
    }

    removePeer(peer: AcpPeer): void {
        for (const gate of this.#activeGates.values()) {
            const ctrl = gate.peerControllers.get(peer);
            if (ctrl !== undefined) {
                ctrl.abort();
                gate.peerControllers.delete(peer);
            }
        }
    }

    clear(): void {
        for (const gate of this.#activeGates.values()) {
            gate.settled = true;
            for (const ctrl of gate.peerControllers.values()) ctrl.abort();
            gate.peerControllers.clear();
        }
        this.#activeGates.clear();
    }

    dispatchToPeer(
        gate: ActiveGate,
        peer: AcpPeer,
        session: BoundSession,
        seam: ApplicationPort,
        peers: ReadonlySet<AcpPeer>,
        notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
        broadcastSessionUpdate: (
            workspaceId: number,
            sessionId: number,
            buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
        ) => void,
    ): void {
        if (peer.client === null || gate.settled) return;
        if (gate.peerControllers.has(peer)) return;

        const controller = new AbortController();
        gate.peerControllers.set(peer, controller);

        if (gate.kind === "proposal" && gate.proposal !== undefined) {
            const proposal = gate.proposal;
            notifyPeerSession(peer, session.acpSessionId, proposalToolCall(proposal));
            const req = proposalPermissionRequest(session.acpSessionId, proposal);
            void peer.client
                .request(methods.client.session.requestPermission, req, { cancellationSignal: controller.signal })
                .then(async (response) => {
                    if (gate.settled || controller.signal.aborted) return;
                    const resolution = resolutionFromPermissionResponse(proposal.logEntryId, response);
                    if (resolution === null) return;
                    await this.#settle(
                        gate,
                        peer,
                        session,
                        async () => {
                            await seam.resolveProposal(
                                resolution.logEntryId,
                                {
                                    decision: resolution.decision,
                                    ...(resolution.scope !== undefined ? { scope: resolution.scope } : {}),
                                    ...(resolution.outcome !== undefined ? { outcome: resolution.outcome } : {}),
                                },
                                { workspaceId: gate.workspaceId, address: OWNER_ADDRESS },
                            );
                        },
                        notifyPeerSession,
                        broadcastSessionUpdate,
                    );
                })
                .catch(() => {
                    gate.peerControllers.delete(peer);
                });
        } else if (gate.kind === "interaction" && gate.interaction !== undefined) {
            const interaction = gate.interaction;
            notifyPeerSession(peer, session.acpSessionId, interactionToolCall(interaction));
            const req = interactionElicitationRequest(session.acpSessionId, interaction);
            void peer.client
                .request(methods.client.elicitation.create, req, { cancellationSignal: controller.signal })
                .then(async (response) => {
                    if (gate.settled || controller.signal.aborted) return;
                    const resolved = interactionResolutionFromResponse(interaction.interactionId, response);
                    if (resolved === null) return;
                    await this.#settle(
                        gate,
                        peer,
                        session,
                        async () => {
                            await seam.resolveClientInteraction(
                                resolved.interactionId,
                                resolved.resolution,
                                { workspaceId: gate.workspaceId, address: OWNER_ADDRESS },
                            );
                            for (const p of peers) {
                                if (p.client !== null) {
                                    void p.client
                                        .notify(methods.client.elicitation.complete, {
                                            elicitationId:
                                                interaction.request.mode === "url"
                                                    ? interaction.request.elicitationId
                                                    : String(interaction.interactionId),
                                        })
                                        .catch(() => undefined);
                                }
                            }
                            broadcastSessionUpdate(gate.workspaceId, gate.sessionId, (s) => [
                                {
                                    sessionId: s.acpSessionId,
                                    update: interactionToolCallResult(resolved.interactionId, resolved.resolution),
                                },
                            ]);
                        },
                        notifyPeerSession,
                        broadcastSessionUpdate,
                    );
                })
                .catch(() => {
                    gate.peerControllers.delete(peer);
                });
        }
    }

    async #settle(
        gate: ActiveGate,
        winner: AcpPeer,
        session: BoundSession,
        resolveInCore: () => Promise<void>,
        notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
        broadcastSessionUpdate: (
            workspaceId: number,
            sessionId: number,
            buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
        ) => void,
    ): Promise<void> {
        if (gate.settled) return;
        try {
            await resolveInCore();
        } catch (err) {
            gate.peerControllers.delete(winner);
            const problem =
                Problems.fromError(err) ??
                (isRecord(err) && isRecord(err.problem)
                    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                      (err.problem as unknown as ProblemDetails)
                    : null);
            if (problem !== null) {
                notifyPeerSession(winner, session.acpSessionId, {
                    sessionUpdate: "notice",
                    severity: "error",
                    title: problem.title,
                    description: problem.detail,
                    _meta: {
                        plurnk: {
                            problem,
                        },
                    },
                });
            }
            return;
        }
        gate.settled = true;
        this.#activeGates.delete(gate.key);

        for (const [peer, ctrl] of gate.peerControllers.entries()) {
            if (peer !== winner) {
                ctrl.abort();
            }
        }
        gate.peerControllers.clear();

        const hasRemainingSessionGate = [...this.#activeGates.values()].some(
            (g) => !g.settled && g.workspaceId === gate.workspaceId && g.sessionId === gate.sessionId,
        );
        if (!hasRemainingSessionGate) {
            broadcastSessionUpdate(gate.workspaceId, gate.sessionId, (s) => [
                {
                    sessionId: s.acpSessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "running",
                    },
                },
            ]);
        }
    }
}

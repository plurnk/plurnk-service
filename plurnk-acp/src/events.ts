// {§acp-session-owner} {§acp-proposal-resolve} {§acp-topology-scope}
// Translates daemon workspace/session events into ACP v2 session/update notifications and gate dispatches.

import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    isRecord,
    isSafeInteger,
    type ApplicationLoopPacket,
    type ClientInteractionProjection,
    type Notice,
    type OutsideEventNotification,
    type ProposalProjection,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { GateTracker } from "./gates.ts";
import { attrRecord, parseJsonOrValue, txBody } from "./log-entry-projection.ts";
import type SessionTranslator from "./SessionTranslator.ts";
import {
    formatSessionId,
    isDescendantSession,
    selectBoundSessionForTarget,
    type AcpPeer,
    type BoundSession,
} from "./sessions.ts";

const isLogEntryPayload = (v: unknown): v is Parameters<SessionTranslator["logEntry"]>[0] => isRecord(v);
const isReasoningEvent = (v: unknown): v is ReasoningEventNotification =>
    isRecord(v) && typeof v.sessionId === "number";
const isOutsideEvent = (v: unknown): v is OutsideEventNotification =>
    isRecord(v) && typeof v.sessionId === "number";
const isLoopPacket = (v: unknown): v is ApplicationLoopPacket =>
    isRecord(v) && typeof v.sessionId === "number";
const isTerminatedEvent = (v: unknown): v is TerminatedNotification =>
    isRecord(v) && typeof v.sessionId === "number" && isRecord(v.result);
const isProposalProjection = (v: unknown): v is ProposalProjection =>
    isRecord(v) && typeof v.sessionId === "number";
const isClientInteractionProjection = (v: unknown): v is ClientInteractionProjection =>
    isRecord(v) && typeof v.sessionId === "number";
const isNoticePayload = (v: unknown): v is { readonly notice: Notice } =>
    isRecord(v) && isRecord(v.notice);

const workspaceTaskQueues = new WeakMap<DaemonEventDispatchContext, Map<number, Promise<void>>>();

const enqueueWorkspaceSessionsTask = (
    ctx: DaemonEventDispatchContext,
    workspaceId: number,
    fn: (sessions: Awaited<ReturnType<ApplicationPort["listSessions"]>>) => void,
): void => {
    let byWs = workspaceTaskQueues.get(ctx);
    if (byWs === undefined) {
        byWs = new Map();
        workspaceTaskQueues.set(ctx, byWs);
    }
    const prev = byWs.get(workspaceId) ?? Promise.resolve();
    const next = prev
        .then(async () => {
            const sessions = await ctx.seam.listSessions(workspaceId);
            fn(sessions);
        })
        .catch(() => undefined);
    byWs.set(workspaceId, next);
};

export interface DaemonEventDispatchContext {
    readonly seam: ApplicationPort;
    readonly peers: ReadonlySet<AcpPeer>;
    readonly gates: GateTracker;
    readonly streamOffsets: Map<string, number>;
    readonly notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void;
    readonly broadcastSessionUpdate: (
        workspaceId: number,
        sessionId: number,
        buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
    ) => void;
}

export const dispatchDaemonEvent = (
    ctx: DaemonEventDispatchContext,
    workspaceId: number,
    method: string,
    params: unknown,
): void => {
    const { seam, peers, gates, streamOffsets, notifyPeerSession, broadcastSessionUpdate } = ctx;
    switch (method) {
        case "log/entry": {
            if (!isRecord(params) || !isRecord(params.entry)) break;
            const entryRec = params.entry;
            const entryId = typeof entryRec.id === "number" ? entryRec.id : null;
            const sessionId = typeof entryRec.session_id === "number" ? entryRec.session_id : null;
            if (entryId === null || sessionId === null) break;
            if (typeof entryRec.state === "string") {
                gates.cancelProposalIfSettled(workspaceId, entryId, entryRec.state);
            }
            if (isLogEntryPayload(params)) {
                broadcastSessionUpdate(workspaceId, sessionId, (s) => s.translator.logEntry(params));
            }
            const hasOtherWorkspaceSession = [...peers].some((peer) => {
                for (const session of peer.sessions.values()) {
                    if (session.workspaceId === workspaceId && session.sessionId !== sessionId) {
                        return true;
                    }
                }
                return false;
            });
            if (hasOtherWorkspaceSession) {
                const attrs = attrRecord(entryRec.attrs);
                const parsedRx = parseJsonOrValue(entryRec.rx);
                const messageText = txBody(entryRec.tx, attrs, parsedRx);
                const summary = messageText.length > 0
                    ? messageText
                    : typeof entryRec.op === "string"
                      ? entryRec.op
                      : "op";
                const sessionName = typeof entryRec.session_name === "string" ? entryRec.session_name : String(sessionId);
                const childSessionId = formatSessionId(workspaceId, sessionName);
                const loopSeq = isSafeInteger(entryRec.loop_seq) ? entryRec.loop_seq : 1;
                const coord =
                    isSafeInteger(entryRec.loop_seq) &&
                    isSafeInteger(entryRec.turn_seq) &&
                    isSafeInteger(entryRec.sequence)
                        ? `${entryRec.loop_seq}/${entryRec.turn_seq}/${entryRec.sequence}`
                        : `${loopSeq}/1/1`;
                const childMeta = {
                    plurnk: {
                        id: sessionId,
                        name: sessionName,
                        coordinate: `session://${sessionName}#${coord}`,
                        subagentRunId: `ops://${sessionName}/${loopSeq}`,
                    },
                };
                enqueueWorkspaceSessionsTask(ctx, workspaceId, (sessions) => {
                    for (const peer of peers) {
                        const visited = new Set<BoundSession>();
                        for (const session of peer.sessions.values()) {
                            if (visited.has(session)) continue;
                            visited.add(session);
                            if (session.workspaceId !== workspaceId || !isDescendantSession(sessions, sessionId, session.sessionId)) {
                                continue;
                            }
                            notifyPeerSession(peer, session.acpSessionId, {
                                sessionUpdate: "subagent_update",
                                sessionId: childSessionId,
                                title: sessionName,
                                description: summary,
                                capabilities: { cancel: {} },
                                state: { state: "running" },
                                _meta: childMeta,
                            });
                            if (entryRec.op === "SEND" && messageText.length > 0) {
                                const isChildToParent = entryRec.origin === "model";
                                notifyPeerSession(peer, session.acpSessionId, {
                                    sessionUpdate: "session_message",
                                    messageId: `session://${sessionName}#${coord}`,
                                    senderSessionId: isChildToParent ? childSessionId : session.acpSessionId,
                                    recipientSessionId: isChildToParent ? session.acpSessionId : childSessionId,
                                    content: [{ type: "text", text: messageText }],
                                    _meta: childMeta,
                                });
                            }
                        }
                    }
                });
            }
            break;
        }
        case "reasoning/event": {
            if (!isReasoningEvent(params)) break;
            broadcastSessionUpdate(workspaceId, params.sessionId, (s) => s.translator.reasoning(params));
            break;
        }
        case "stream/event": {
            if (!isRecord(params)) break;
            const entryId = typeof params.entryId === "number" ? params.entryId : null;
            const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
            const target = typeof params.target === "string" ? params.target : null;
            const channel = typeof params.channel === "string" ? params.channel : null;
            if (entryId === null || sessionId === null) break;
            const streamMeta: Record<string, unknown> = {
                sessionId,
                ...(target !== null ? { target } : {}),
                ...(channel !== null ? { channel } : {}),
                ...(typeof params.state === "string" ? { state: params.state } : {}),
                ...(typeof params.contentLength === "number" ? { contentLength: params.contentLength } : {}),
            };
            broadcastSessionUpdate(workspaceId, sessionId, (s) => [
                {
                    sessionId: s.acpSessionId,
                    update: {
                        sessionUpdate: "terminal_update",
                        terminalId: `term:${entryId}`,
                        _meta: { plurnk: streamMeta },
                    },
                },
            ]);
            if (target === null || channel === null) break;
            const contentLength = typeof params.contentLength === "number" ? params.contentLength : 0;
            const offsetKey = `${workspaceId}:${entryId}:${channel}`;
            const prevOffset = streamOffsets.get(offsetKey) ?? 0;
            if (contentLength > prevOffset) {
                streamOffsets.set(offsetKey, contentLength);
                void seam
                    .readEntry({ workspaceId, sessionId, target, channel, offset: prevOffset })
                    .then((readResult) => {
                        const chunk = readResult.entry !== null
                            ? (readResult.entry.channels[channel]?.content ?? "")
                            : "";
                        if (chunk.length > 0) {
                            broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                                s.translator.terminalChunk(entryId, chunk, { sessionId, target, channel }),
                            );
                        }
                    })
                    .catch(() => undefined);
            }
            break;
        }
        case "stream/concluded": {
            if (!isRecord(params)) break;
            const entryId = typeof params.entryId === "number" ? params.entryId : null;
            const sessionId = typeof params.sessionId === "number" ? params.sessionId : null;
            const target = typeof params.target === "string" ? params.target : null;
            const status = isRecord(params.result) && typeof params.result.status === "number"
                ? params.result.status
                : 200;
            if (entryId === null || sessionId === null) break;
            const concludedMeta: Record<string, unknown> = {
                sessionId,
                ...(target !== null ? { target } : {}),
                ...(isRecord(params.result) ? { result: params.result } : {}),
                ...(isRecord(params.summary) ? { summary: params.summary } : {}),
            };
            broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                s.translator.terminalConcluded(entryId, status, concludedMeta),
            );
            break;
        }
        case "outside/event": {
            if (!isOutsideEvent(params)) break;
            broadcastSessionUpdate(workspaceId, params.sessionId, (s) => s.translator.outside(params));
            break;
        }
        case "loop/packet": {
            if (!isLoopPacket(params)) break;
            broadcastSessionUpdate(workspaceId, params.sessionId, (s) => s.translator.packet(params));
            break;
        }
        case "loop/terminated": {
            if (!isTerminatedEvent(params)) break;
            const sessionId = params.sessionId;
            gates.cancelSessionGates(workspaceId, sessionId);
            broadcastSessionUpdate(workspaceId, sessionId, (s) => s.translator.terminated(params));
            const status = params.result.status;
            const childState = params.hitMaxTurns || status === 429
                ? ({ state: "idle" as const, stopReason: "max_turn_requests" as const })
                : status === 499
                  ? ({ state: "idle" as const, stopReason: "cancelled" as const })
                  : status >= 400
                    ? ({ state: "idle" as const, stopReason: "refusal" as const })
                    : ({ state: "idle" as const, stopReason: "end_turn" as const });
            enqueueWorkspaceSessionsTask(ctx, workspaceId, (sessions) => {
                const sessionRow = sessions.find((w) => w.id === sessionId);
                const sessionName = sessionRow?.name ?? String(sessionId);
                for (const peer of peers) {
                    const visited = new Set<BoundSession>();
                    for (const session of peer.sessions.values()) {
                        if (visited.has(session)) continue;
                        visited.add(session);
                        if (session.workspaceId !== workspaceId || !isDescendantSession(sessions, sessionId, session.sessionId)) {
                            continue;
                        }
                        notifyPeerSession(peer, session.acpSessionId, {
                            sessionUpdate: "subagent_update",
                            sessionId: formatSessionId(workspaceId, sessionName),
                            state: childState,
                        });
                    }
                }
            });
            break;
        }
        case "loop/proposal": {
            if (!isProposalProjection(params)) break;
            const proposal = params;
            if (proposal.disposition.decision !== "review") break;
            const gate = gates.openOrGet(workspaceId, proposal.sessionId, "proposal", proposal);
            broadcastSessionUpdate(workspaceId, proposal.sessionId, (s) => [
                {
                    sessionId: s.acpSessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "requires_action",
                    },
                },
            ]);
            const remainingPeers: AcpPeer[] = [];
            for (const peer of peers) {
                const directSession = selectBoundSessionForTarget(peer, workspaceId, proposal.sessionId);
                if (directSession !== undefined) {
                    gates.dispatchToPeer(gate, peer, directSession, seam, peers, notifyPeerSession, broadcastSessionUpdate);
                } else {
                    for (const s of peer.sessions.values()) {
                        if (s.workspaceId === workspaceId) {
                            remainingPeers.push(peer);
                            break;
                        }
                    }
                }
            }
            if (remainingPeers.length > 0) {
                enqueueWorkspaceSessionsTask(ctx, workspaceId, (sessions) => {
                    const childRow = sessions.find((w) => w.id === proposal.sessionId);
                    const childName = childRow?.name ?? proposal.session ?? String(proposal.sessionId);
                    const childSessionId = formatSessionId(workspaceId, childName);
                    for (const peer of remainingPeers) {
                        const ancestorSession = selectBoundSessionForTarget(peer, workspaceId, proposal.sessionId, sessions);
                        if (ancestorSession !== undefined) {
                            if (ancestorSession.sessionId !== proposal.sessionId) {
                                notifyPeerSession(peer, ancestorSession.acpSessionId, {
                                    sessionUpdate: "subagent_update",
                                    sessionId: childSessionId,
                                    title: childName,
                                    capabilities: { cancel: {} },
                                    state: { state: "requires_action" },
                                });
                            }
                            gates.dispatchToPeer(gate, peer, ancestorSession, seam, peers, notifyPeerSession, broadcastSessionUpdate);
                        }
                    }
                });
            }
            break;
        }
        case "loop/interaction": {
            if (!isClientInteractionProjection(params)) break;
            const interaction = params;
            const gate = gates.openOrGet(workspaceId, interaction.sessionId, "interaction", undefined, interaction);
            broadcastSessionUpdate(workspaceId, interaction.sessionId, (s) => [
                {
                    sessionId: s.acpSessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "requires_action",
                    },
                },
            ]);
            const remainingPeers: AcpPeer[] = [];
            for (const peer of peers) {
                const directSession = selectBoundSessionForTarget(peer, workspaceId, interaction.sessionId);
                if (directSession !== undefined) {
                    gates.dispatchToPeer(gate, peer, directSession, seam, peers, notifyPeerSession, broadcastSessionUpdate);
                } else {
                    for (const s of peer.sessions.values()) {
                        if (s.workspaceId === workspaceId) {
                            remainingPeers.push(peer);
                            break;
                        }
                    }
                }
            }
            if (remainingPeers.length > 0) {
                enqueueWorkspaceSessionsTask(ctx, workspaceId, (sessions) => {
                    const childRow = sessions.find((w) => w.id === interaction.sessionId);
                    const childName = childRow?.name ?? String(interaction.sessionId);
                    const childSessionId = formatSessionId(workspaceId, childName);
                    for (const peer of remainingPeers) {
                        const ancestorSession = selectBoundSessionForTarget(peer, workspaceId, interaction.sessionId, sessions);
                        if (ancestorSession !== undefined) {
                            if (ancestorSession.sessionId !== interaction.sessionId) {
                                notifyPeerSession(peer, ancestorSession.acpSessionId, {
                                    sessionUpdate: "subagent_update",
                                    sessionId: childSessionId,
                                    title: childName,
                                    capabilities: { cancel: {} },
                                    state: { state: "requires_action" },
                                });
                            }
                            gates.dispatchToPeer(gate, peer, ancestorSession, seam, peers, notifyPeerSession, broadcastSessionUpdate);
                        }
                    }
                });
            }
            break;
        }
        case "notice/event": {
            if (!isNoticePayload(params)) break;
            const notice = params.notice;
            for (const peer of peers) {
                const visited = new Set<BoundSession>();
                for (const session of peer.sessions.values()) {
                    if (visited.has(session)) continue;
                    visited.add(session);
                    if (session.workspaceId !== workspaceId) continue;
                    for (const { sessionId, update } of session.translator.notice(notice)) {
                        notifyPeerSession(peer, sessionId, update);
                    }
                }
            }
            break;
        }
        case "workspace/preparation": {
            const preparation =
                isRecord(params) && Array.isArray(params.preparation)
                    ? params.preparation
                    : seam.workspacePreparationStatus(workspaceId);
            for (const peer of peers) {
                const visited = new Set<BoundSession>();
                for (const session of peer.sessions.values()) {
                    if (visited.has(session)) continue;
                    visited.add(session);
                    if (session.workspaceId !== workspaceId) continue;
                    notifyPeerSession(peer, session.acpSessionId, {
                        sessionUpdate: "notice",
                        severity: "info",
                        title: "workspace:preparation",
                        description: JSON.stringify(preparation),
                        _meta: {
                            plurnk: {
                                workspaceId,
                                preparation,
                            },
                        },
                    });
                }
            }
            break;
        }
        default:
            break;
    }
};

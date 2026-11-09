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
import { attrRecord, extractMessageId, extractVoice, parseJsonOrValue, txBody } from "./log-entry-projection.ts";
import type SessionTranslator from "./SessionTranslator.ts";
import {
    buildAvailableCommands,
    buildSessionDescendants,
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
const isNoticePayload = (
    v: unknown,
): v is {
    readonly sessionId?: number | null;
    readonly loopId?: number;
    readonly notice: Notice;
} => isRecord(v) && isRecord(v.notice);

const workspaceTaskQueues = new WeakMap<Map<string, number>, Map<number, Promise<void>>>();
const sessionStreamQueues = new WeakMap<Map<string, number>, Map<string, Promise<void>>>();

const enqueueOrRunSessionEvent = (
    ctx: DaemonEventDispatchContext,
    workspaceId: number,
    sessionId: number,
    fn: () => void | Promise<void>,
): void => {
    let bySession = sessionStreamQueues.get(ctx.streamOffsets);
    const key = `${workspaceId}:${sessionId}`;
    const pending = bySession?.get(key);
    if (pending === undefined) {
        const res = fn();
        if (res instanceof Promise) {
            if (bySession === undefined) {
                bySession = new Map();
                sessionStreamQueues.set(ctx.streamOffsets, bySession);
            }
            const tracked = res
                .catch(() => undefined)
                .finally(() => {
                    if (bySession?.get(key) === tracked) {
                        bySession.delete(key);
                    }
                });
            bySession.set(key, tracked);
        }
        return;
    }
    const tracked = pending
        .then(() => fn())
        .catch(() => undefined)
        .finally(() => {
            if (bySession?.get(key) === tracked) {
                bySession.delete(key);
            }
        });
    bySession!.set(key, tracked);
};

const enqueueWorkspaceSessionsTask = (
    ctx: DaemonEventDispatchContext,
    workspaceId: number,
    fn: (sessions: Awaited<ReturnType<ApplicationPort["listSessions"]>>) => void,
): void => {
    let byWs = workspaceTaskQueues.get(ctx.streamOffsets);
    if (byWs === undefined) {
        byWs = new Map();
        workspaceTaskQueues.set(ctx.streamOffsets, byWs);
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
    readonly scheduleOverviewRefresh?: () => void;
}

export const applyWorkspaceRenamed = (
    peers: ReadonlySet<AcpPeer>,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
    workspaceId: number,
    nextName: string,
    scheduleOverviewRefresh?: () => void,
): void => {
    for (const peer of peers) {
        const visited = new Set<BoundSession>();
        for (const session of peer.sessions.values()) {
            if (visited.has(session)) continue;
            visited.add(session);
            if (session.workspaceId !== workspaceId || session.workspaceName === nextName) continue;
            session.workspaceName = nextName;
            notifyPeerSession(peer, session.acpSessionId, {
                sessionUpdate: "session_info_update",
                title: `${nextName}#${session.sessionName}`,
                _meta: {
                    plurnk: {
                        workspaceId,
                        workspaceName: nextName,
                        workspace: {
                            id: workspaceId,
                            name: nextName,
                            projectRoot: session.projectRoot,
                            projectLabel: session.projectLabel,
                        },
                    },
                },
            });
        }
    }
    scheduleOverviewRefresh?.();
};

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
            if (
                entryRec.op === "send" ||
                entryRec.op === "done" ||
                entryRec.op === "fail" ||
                entryRec.op === "work" ||
                entryRec.op === "fork" ||
                typeof entryRec.state === "string"
            ) {
                ctx.scheduleOverviewRefresh?.();
            }
            if (isLogEntryPayload(params)) {
                enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, async () => {
                    const builtUpdates: { readonly sessionId: string; readonly update: SessionUpdate }[] = [];
                    broadcastSessionUpdate(workspaceId, sessionId, (s) => {
                        const updates = s.translator.logEntry(params);
                        if (builtUpdates.length === 0 && updates.length > 0) {
                            builtUpdates.push(...updates);
                        }
                        return updates;
                    });
                    if (
                        (entryRec.origin === "_plurnk" && entryRec.op === "send") ||
                        (entryRec.origin === "model" && (entryRec.op === "done" || entryRec.op === "fail"))
                    ) {
                        const rawInbox = await seam.readInbox({ workspaceId, sessionId });
                        broadcastSessionUpdate(workspaceId, sessionId, (s) => [
                            {
                                sessionId: s.acpSessionId,
                                update: {
                                    sessionUpdate: "session_info_update",
                                    _meta: {
                                        plurnk: {
                                            status: {
                                                inbox: rawInbox.map((msg) => ({
                                                    path: msg.path,
                                                    id: extractMessageId(msg.source ?? msg.path, s.acpSessionId),
                                                    voice: extractVoice(msg.source ?? msg.path),
                                                    loopId: msg.loopId,
                                                    lifecycle: msg.lifecycle,
                                                    ...(s.translator.origin !== undefined &&
                                                    s.translator.origin.length > 0
                                                        ? {
                                                              body: {
                                                                  url: `${s.translator.origin}/acp/${workspaceId}/${sessionId}/entry?target=${encodeURIComponent(msg.path)}`,
                                                                  mimeType: "text/plain",
                                                              },
                                                          }
                                                        : {}),
                                                })),
                                            },
                                        },
                                    },
                                },
                            },
                        ]);
                        if (entryRec.origin === "model" && (entryRec.op === "done" || entryRec.op === "fail")) {
                            const parsedEntryRx = parseJsonOrValue(entryRec.rx);
                            const rxRec = isRecord(parsedEntryRx) ? parsedEntryRx : null;
                            const receiptRec = isRecord(rxRec?.receipt) ? rxRec.receipt : rxRec;
                            const nestedReceiptRec =
                                receiptRec !== null && isRecord(receiptRec.receipt) ? receiptRec.receipt : null;
                            const completion =
                                receiptRec?.completion ??
                                nestedReceiptRec?.completion ??
                                (entryRec.signal === 200 || entryRec.signal === 499 ? entryRec.signal : undefined);
                            const repliedToSources = Array.isArray(entryRec.replied_to_sources)
                                ? entryRec.replied_to_sources.filter((x): x is string => typeof x === "string")
                                : [];
                            const receiptRepliedTo = Array.isArray(receiptRec?.repliedTo)
                                ? receiptRec.repliedTo.filter((x): x is string => typeof x === "string")
                                : Array.isArray(nestedReceiptRec?.repliedTo)
                                  ? nestedReceiptRec.repliedTo.filter((x): x is string => typeof x === "string")
                                  : [];
                            const updateVoices: string[] = [];
                            for (const { update } of builtUpdates) {
                                const p =
                                    isRecord(update._meta) && isRecord(update._meta.plurnk)
                                        ? update._meta.plurnk
                                        : null;
                                if (typeof p?.voice === "string") {
                                    updateVoices.push(p.voice);
                                }
                                if (Array.isArray(p?.voices)) {
                                    for (const v of p.voices) {
                                        if (typeof v === "string") updateVoices.push(v);
                                    }
                                }
                            }
                            const completedVoices = [
                                ...new Set([
                                    ...repliedToSources.map((src) => extractVoice(src)),
                                    ...receiptRepliedTo.map((src) => extractVoice(src)),
                                    ...updateVoices,
                                    typeof entryRec.pathname === "string"
                                        ? extractVoice(entryRec.pathname)
                                        : undefined,
                                ]),
                            ].filter(
                                (v): v is string =>
                                    typeof v === "string" &&
                                    v.length > 0 &&
                                    v !== "operator" &&
                                    v !== "anonymous",
                            );
                            if (completion === 200 || completion === 499) {
                                for (const completedVoice of completedVoices) {
                                    const hasRemainingOpenForVoice = rawInbox.some(
                                        (msg) =>
                                            (msg.lifecycle === "running" ||
                                                msg.lifecycle === "queued" ||
                                                msg.lifecycle === "parked") &&
                                            extractVoice(msg.source ?? msg.path) === completedVoice,
                                    );
                                    if (!hasRemainingOpenForVoice) {
                                        const idleMeta = {
                                            plurnk: {
                                                loopId: entryRec.loop_id,
                                                loopSeq: entryRec.loop_seq,
                                                voice: completedVoice,
                                                status: {
                                                    lifecycle: "idle",
                                                    loopId: entryRec.loop_id,
                                                    loopSeq: entryRec.loop_seq,
                                                },
                                            },
                                        };
                                        const voiceIdleUpdate: SessionUpdate =
                                            completion === 499
                                                ? {
                                                      sessionUpdate: "state_update",
                                                      state: "idle",
                                                      stopReason: "refusal",
                                                      _meta: idleMeta,
                                                  }
                                                : {
                                                      sessionUpdate: "state_update",
                                                      state: "idle",
                                                      stopReason: "end_turn",
                                                      _meta: idleMeta,
                                                  };
                                        for (const peer of peers) {
                                            if (peer.subject !== completedVoice) continue;
                                            const visited = new Set<BoundSession>();
                                            for (const session of peer.sessions.values()) {
                                                if (visited.has(session)) continue;
                                                visited.add(session);
                                                if (session.workspaceId !== workspaceId || session.sessionId !== sessionId) {
                                                    continue;
                                                }
                                                notifyPeerSession(peer, session.acpSessionId, voiceIdleUpdate);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
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
                    const childRow = sessions.find((w) => w.id === sessionId);
                    const enrichedChildMeta = {
                        plurnk: {
                            ...childMeta.plurnk,
                            ...(childRow !== undefined
                                ? {
                                      parentSessionId: childRow.parentSessionId,
                                      kind: childRow.kind,
                                      lifecycle: childRow.lifecycle,
                                  }
                                : {}),
                        },
                    };
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
                                _meta: enrichedChildMeta,
                            });
                            if ((entryRec.op === "send" || entryRec.op === "done" || entryRec.op === "fail") && messageText.length > 0) {
                                const isChildToParent = entryRec.origin === "model";
                                notifyPeerSession(peer, session.acpSessionId, {
                                    sessionUpdate: "session_message",
                                    messageId: `session://${sessionName}#${coord}`,
                                    senderSessionId: isChildToParent ? childSessionId : session.acpSessionId,
                                    recipientSessionId: isChildToParent ? session.acpSessionId : childSessionId,
                                    content: [{ type: "text", text: messageText }],
                                    _meta: enrichedChildMeta,
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
                entryId,
                sessionId,
                ...(target !== null ? { target } : {}),
                ...(channel !== null ? { channel } : {}),
                ...(typeof params.state === "string" ? { state: params.state } : {}),
                ...(typeof params.contentLength === "number" ? { contentLength: params.contentLength } : {}),
                ...(typeof params.mimetype === "string" ? { mimetype: params.mimetype } : {}),
                ...(typeof params.loop_seq === "number" ? { loop_seq: params.loop_seq } : {}),
                ...(typeof params.turn_seq === "number" ? { turn_seq: params.turn_seq } : {}),
                ...(typeof params.sequence === "number" ? { sequence: params.sequence } : {}),
            };
            broadcastSessionUpdate(workspaceId, sessionId, (s) => [
                {
                    sessionId: s.acpSessionId,
                    update: {
                        sessionUpdate: "terminal_update",
                        terminalId: `term:${entryId}`,
                        capabilities: { cancel: {} },
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
                enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, async () => {
                    const readResult = await seam.readEntry({
                        workspaceId,
                        sessionId,
                        target,
                        channel,
                        offset: prevOffset,
                    });
                    const chunk = readResult.entry !== null
                        ? (readResult.entry.channels[channel]?.content ?? "")
                        : "";
                    if (chunk.length > 0) {
                        broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                            s.translator.terminalChunk(entryId, chunk, { sessionId, target, channel }),
                        );
                    }
                });
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
                entryId,
                sessionId,
                ...(target !== null ? { target } : {}),
                ...(typeof params.subscriptionId === "number" ? { subscriptionId: params.subscriptionId } : {}),
                ...(typeof params.scheme === "string" ? { scheme: params.scheme } : {}),
                ...(isRecord(params.result) ? { result: params.result } : {}),
                ...(typeof params.summary === "string" || isRecord(params.summary) ? { summary: params.summary } : {}),
                ...(typeof params.wakeAction === "string" ? { wakeAction: params.wakeAction } : {}),
                ...(typeof params.loop_seq === "number" ? { loop_seq: params.loop_seq } : {}),
                ...(typeof params.turn_seq === "number" ? { turn_seq: params.turn_seq } : {}),
                ...(typeof params.sequence === "number" ? { sequence: params.sequence } : {}),
            };
            enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, () => {
                broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                    s.translator.terminalConcluded(entryId, status, concludedMeta),
                );
            });
            break;
        }
        case "outside/event": {
            if (!isOutsideEvent(params)) break;
            broadcastSessionUpdate(workspaceId, params.sessionId, (s) => s.translator.outside(params));
            break;
        }
        case "loop/packet": {
            if (!isLoopPacket(params)) break;
            const sessionId = params.sessionId;
            enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, async () => {
                const spend = await seam.sessionAccounting({ workspaceId, sessionId });
                broadcastSessionUpdate(workspaceId, sessionId, (s) => s.translator.packet(params, spend));
            });
            ctx.scheduleOverviewRefresh?.();
            break;
        }
        case "loop/terminated": {
            if (!isTerminatedEvent(params)) break;
            const sessionId = params.sessionId;
            gates.cancelSessionGates(workspaceId, sessionId);
            ctx.scheduleOverviewRefresh?.();
            enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, async () => {
                const [spend, rawInbox] = await Promise.all([
                    seam.sessionAccounting({ workspaceId, sessionId }),
                    seam.readInbox({ workspaceId, sessionId }),
                ]);
                broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                    s.translator.terminated(
                        params,
                        spend,
                        rawInbox.map((msg) => ({
                            path: msg.path,
                            id: extractMessageId(msg.source ?? msg.path, s.acpSessionId),
                            voice: extractVoice(msg.source ?? msg.path),
                            loopId: msg.loopId,
                            lifecycle: msg.lifecycle,
                            ...(s.translator.origin !== undefined && s.translator.origin.length > 0
                                ? {
                                      body: {
                                          url: `${s.translator.origin}/acp/${workspaceId}/${sessionId}/entry?target=${encodeURIComponent(msg.path)}`,
                                          mimeType: "text/plain",
                                      },
                                  }
                                : {}),
                        })),
                    ),
                );
            });
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
                            title: sessionName,
                            capabilities: { cancel: {} },
                            state: childState,
                            _meta: {
                                plurnk: {
                                    id: sessionId,
                                    name: sessionName,
                                    ...(sessionRow !== undefined
                                        ? {
                                              parentSessionId: sessionRow.parentSessionId,
                                              kind: sessionRow.kind,
                                              lifecycle: sessionRow.lifecycle,
                                          }
                                        : {}),
                                },
                            },
                        });
                        void Promise.all([
                            seam.sessionAccounting({ workspaceId, sessionId: session.sessionId }),
                            seam.pendingProposals(workspaceId),
                            seam.pendingClientInteractions(workspaceId),
                        ])
                            .then(([spend, proposals, interactions]) => {
                                notifyPeerSession(peer, session.acpSessionId, {
                                    sessionUpdate: "session_info_update",
                                    _meta: {
                                        plurnk: {
                                            status: {
                                                spend,
                                                descendants: buildSessionDescendants(
                                                    sessions,
                                                    proposals,
                                                    interactions,
                                                    session.sessionId,
                                                ),
                                            },
                                        },
                                    },
                                });
                            })
                            .catch(() => undefined);
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
            ctx.scheduleOverviewRefresh?.();
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
                                    _meta: {
                                        plurnk: {
                                            id: proposal.sessionId,
                                            name: childName,
                                            ...(childRow !== undefined
                                                ? {
                                                      parentSessionId: childRow.parentSessionId,
                                                      kind: childRow.kind,
                                                      lifecycle: childRow.lifecycle,
                                                  }
                                                : {}),
                                        },
                                    },
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
            ctx.scheduleOverviewRefresh?.();
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
                                    _meta: {
                                        plurnk: {
                                            id: interaction.sessionId,
                                            name: childName,
                                            ...(childRow !== undefined
                                                ? {
                                                      parentSessionId: childRow.parentSessionId,
                                                      kind: childRow.kind,
                                                      lifecycle: childRow.lifecycle,
                                                  }
                                                : {}),
                                        },
                                    },
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
            const targetSessionId = typeof params.sessionId === "number" ? params.sessionId : null;
            if (targetSessionId !== null) {
                enqueueOrRunSessionEvent(ctx, workspaceId, targetSessionId, () => {
                    broadcastSessionUpdate(workspaceId, targetSessionId, (s) => s.translator.notice(notice));
                });
            } else {
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
            }
            if (notice.source === "engine:lifecycle" && notice.kind === "loop_status") {
                ctx.scheduleOverviewRefresh?.();
            }
            if (
                targetSessionId !== null &&
                ((notice.source === "engine:turn" && notice.kind === "turn_generated") ||
                    (notice.source === "engine:lifecycle" && notice.kind === "loop_status"))
            ) {
                enqueueWorkspaceSessionsTask(ctx, workspaceId, (sessions) => {
                    for (const peer of peers) {
                        const visited = new Set<BoundSession>();
                        for (const session of peer.sessions.values()) {
                            if (visited.has(session)) continue;
                            visited.add(session);
                            if (
                                session.workspaceId !== workspaceId ||
                                !isDescendantSession(sessions, targetSessionId, session.sessionId)
                            ) {
                                continue;
                            }
                            void Promise.all([
                                seam.sessionAccounting({ workspaceId, sessionId: session.sessionId }),
                                seam.pendingProposals(workspaceId),
                                seam.pendingClientInteractions(workspaceId),
                            ])
                                .then(([spend, proposals, interactions]) => {
                                    notifyPeerSession(peer, session.acpSessionId, {
                                        sessionUpdate: "session_info_update",
                                        _meta: {
                                            plurnk: {
                                                status: {
                                                    spend,
                                                    descendants: buildSessionDescendants(
                                                        sessions,
                                                        proposals,
                                                        interactions,
                                                        session.sessionId,
                                                    ),
                                                },
                                            },
                                        },
                                    });
                                })
                                .catch(() => undefined);
                        }
                    }
                });
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
                        sessionUpdate: "session_info_update",
                        _meta: {
                            plurnk: {
                                workspaceId,
                                preparation,
                            },
                        },
                    });
                }
            }
            if (Array.isArray(preparation) && preparation.length === 0) {
                void buildAvailableCommands(seam, workspaceId)
                    .then((availableCommands) => {
                        for (const peer of peers) {
                            const visited = new Set<BoundSession>();
                            for (const session of peer.sessions.values()) {
                                if (visited.has(session)) continue;
                                visited.add(session);
                                if (session.workspaceId !== workspaceId) continue;
                                notifyPeerSession(peer, session.acpSessionId, {
                                    sessionUpdate: "available_commands_update",
                                    availableCommands,
                                });
                            }
                        }
                    })
                    .catch(() => undefined);
            }
            break;
        }
        case "workspace/renamed": {
            if (!isRecord(params) || typeof params.name !== "string" || params.name.length === 0) break;
            applyWorkspaceRenamed(peers, notifyPeerSession, workspaceId, params.name, ctx.scheduleOverviewRefresh);
            break;
        }
        case "workspace/archived":
        case "session/archived":
        case "session/deleted": {
            ctx.scheduleOverviewRefresh?.();
            break;
        }
        case "session/titled": {
            if (isRecord(params) && typeof params.id === "number" && typeof params.title === "string") {
                const nextTitle = params.title;
                broadcastSessionUpdate(workspaceId, params.id, (s) => [
                    {
                        sessionId: s.acpSessionId,
                        update: {
                            sessionUpdate: "session_info_update",
                            title: nextTitle,
                        },
                    },
                ]);
            }
            ctx.scheduleOverviewRefresh?.();
            break;
        }
        default:
            break;
    }
};

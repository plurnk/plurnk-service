// {§acp-event-translation} {§acp-session-owner} {§acp-proposal-resolve} {§acp-topology-scope}
// Translates daemon workspace/session events and runtime stream events into ACP v2 session/update notifications and gate dispatches.

import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    isRecord,
    isSafeInteger,
    type ApplicationLoopPacket,
    type ApplicationRuntimeStreamEvent,
    type ClientInteractionProjection,
    type DaemonNotificationEvent,
    type FunctionalityChangedNotification,
    type LoopGateSettledNotification,
    type ModelRoute,
    type Notice,
    type ProposalProjection,
    type ReasoningEventNotification,
    type SessionPolicyNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { GateTracker } from "./gates.ts";
import {
    attrRecord,
    parseJsonOrValue,
    projectInboxItems,
    txBody,
} from "./log-entry-projection.ts";
import type SessionTranslator from "./SessionTranslator.ts";
import { buildAvailableCommands } from "./session-commands.ts";
import { buildConfigOptions, type SessionPolicyHint } from "./session-options.ts";
import {
    buildSessionDescendants,
    formatSessionId,
    isDescendantSession,
    selectBoundSessionForTarget,
    tryListProviders,
    type AcpPeer,
    type BoundSession,
} from "./sessions.ts";

const isLogEntryPayload = (v: unknown): v is Parameters<SessionTranslator["logEntry"]>[0] => isRecord(v);
const isReasoningEvent = (v: unknown): v is ReasoningEventNotification =>
    isRecord(v) && typeof v.sessionId === "number";
const isLoopPacket = (v: unknown): v is ApplicationLoopPacket =>
    isRecord(v) && typeof v.sessionId === "number";
const isTerminatedEvent = (v: unknown): v is TerminatedNotification =>
    isRecord(v) && typeof v.sessionId === "number" && isRecord(v.result);
const isProposalProjection = (v: unknown): v is ProposalProjection =>
    isRecord(v) && typeof v.sessionId === "number";
const isClientInteractionProjection = (v: unknown): v is ClientInteractionProjection =>
    isRecord(v) && typeof v.sessionId === "number";
const isFunctionalityChanged = (v: unknown): v is FunctionalityChangedNotification =>
    isRecord(v) &&
    typeof v.family === "string" &&
    (v.sessionId === null || v.sessionId === undefined || typeof v.sessionId === "number");
const isSessionPolicy = (v: unknown): v is SessionPolicyNotification =>
    isRecord(v) &&
    typeof v.sessionId === "number" &&
    ("model" in v || "spawnModel" in v || "persona" in v);
const isLoopGateSettled = (v: unknown): v is LoopGateSettledNotification => {
    if (!isRecord(v) || typeof v.sessionId !== "number") return false;
    if (v.kind === "proposal") {
        return typeof v.logEntryId === "number" && typeof v.decision === "string";
    }
    if (v.kind === "interaction") {
        return (
            typeof v.interactionId === "number" &&
            (v.action === "accept" || v.action === "decline" || v.action === "cancel")
        );
    }
    return false;
};
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
    const tracked = prev
        .then(async () => {
            const sessions = await ctx.seam.listSessions(workspaceId);
            fn(sessions);
        })
        .catch(() => undefined)
        .finally(() => {
            if (byWs?.get(workspaceId) === tracked) {
                byWs.delete(workspaceId);
            }
        });
    byWs.set(workspaceId, tracked);
};

export class OptionSyncTracker {
    readonly #configGen = new Map<number, number>();
    readonly #commandsGen = new Map<number, number>();
    readonly #pending = new Map<number, Set<Promise<void>>>();

    configGeneration(workspaceId: number): number {
        return this.#configGen.get(workspaceId) ?? 0;
    }

    commandsGeneration(workspaceId: number): number {
        return this.#commandsGen.get(workspaceId) ?? 0;
    }

    recordConfigUpdate(workspaceId: number, task: Promise<void>): void {
        this.#configGen.set(workspaceId, this.configGeneration(workspaceId) + 1);
        this.#track(workspaceId, task);
    }

    recordCommandsUpdate(workspaceId: number, task: Promise<void>): void {
        this.#commandsGen.set(workspaceId, this.commandsGeneration(workspaceId) + 1);
        this.#track(workspaceId, task);
    }

    async flush(workspaceId: number): Promise<void> {
        while (true) {
            const set = this.#pending.get(workspaceId);
            if (set === undefined || set.size === 0) return;
            await Promise.allSettled([...set]);
        }
    }

    clear(): void {
        this.#configGen.clear();
        this.#commandsGen.clear();
        this.#pending.clear();
    }

    #track(workspaceId: number, task: Promise<void>): void {
        let set = this.#pending.get(workspaceId);
        if (set === undefined) {
            set = new Set();
            this.#pending.set(workspaceId, set);
        }
        const wrapped = task.catch(() => undefined).finally(() => {
            set.delete(wrapped);
            if (set.size === 0 && this.#pending.get(workspaceId) === set) {
                this.#pending.delete(workspaceId);
            }
        });
        set.add(wrapped);
    }
}

interface DaemonEventDispatchContext {
    readonly seam: ApplicationPort;
    readonly peers: ReadonlySet<AcpPeer>;
    readonly gates: GateTracker;
    readonly streamOffsets: Map<string, number>;
    readonly optionSync: OptionSyncTracker;
    readonly notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void;
    readonly broadcastSessionUpdate: (
        workspaceId: number,
        sessionId: number,
        buildUpdates: (session: BoundSession) => readonly { readonly sessionId: string; readonly update: SessionUpdate }[],
    ) => void;
}

export const broadcastWorkspaceCommandsUpdate = async (
    seam: ApplicationPort,
    peers: ReadonlySet<AcpPeer>,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
    workspaceId: number,
    excludePeer?: AcpPeer,
): Promise<void> => {
    const wsPeers = [...peers].filter((p) => {
        if (p === excludePeer || (p.suppressInitialOptionUpdates ?? 0) > 0) return false;
        for (const s of p.sessions.values()) {
            if (s.workspaceId === workspaceId) return true;
        }
        return false;
    });
    if (wsPeers.length === 0) return;
    const needsWithSkills = wsPeers.some((p) => p.supportsSkillCommands === true);
    const needsWithoutSkills = wsPeers.some((p) => p.supportsSkillCommands !== true);
    const [withSkills, withoutSkills] = await Promise.all([
        needsWithSkills ? buildAvailableCommands(seam, workspaceId, { includeSkills: true }) : null,
        needsWithoutSkills ? buildAvailableCommands(seam, workspaceId, { includeSkills: false }) : null,
    ]);
    for (const peer of wsPeers) {
        if (!peers.has(peer)) continue;
        const availableCommands =
            peer.supportsSkillCommands === true ? (withSkills ?? []) : (withoutSkills ?? []);
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
};

export const broadcastConfigOptionsUpdate = async (
    seam: ApplicationPort,
    peers: ReadonlySet<AcpPeer>,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
    workspaceId: number,
    targetSessionId: number | null,
    options?: {
        readonly excludePeer?: AcpPeer;
        readonly policyHint?: SessionPolicyHint;
        readonly prebuilt?: {
            readonly sessionId: number;
            readonly configOptions: SessionConfigOption[];
            readonly modelInfo: { readonly model: ModelRoute | null; readonly spawnModel: ModelRoute | null };
        };
    },
): Promise<void> => {
    const targetPeers = [...peers].filter((p) => {
        if (p === options?.excludePeer || (p.suppressInitialOptionUpdates ?? 0) > 0) return false;
        for (const s of p.sessions.values()) {
            if (s.workspaceId === workspaceId && (targetSessionId === null || s.sessionId === targetSessionId)) {
                return true;
            }
        }
        return false;
    });
    if (targetPeers.length === 0) return;

    const sessionIds = new Set<number>();
    for (const peer of targetPeers) {
        for (const s of peer.sessions.values()) {
            if (s.workspaceId === workspaceId && (targetSessionId === null || s.sessionId === targetSessionId)) {
                sessionIds.add(s.sessionId);
            }
        }
    }
    if (sessionIds.size === 0) return;

    const providerCatalog = tryListProviders(seam);
    const perSession = new Map<
        number,
        {
            readonly configOptions: SessionConfigOption[];
            readonly modelInfo: { readonly model: ModelRoute | null; readonly spawnModel: ModelRoute | null };
        }
    >();

    await Promise.all(
        [...sessionIds].map(async (sid) => {
            if (options?.prebuilt !== undefined && options.prebuilt.sessionId === sid) {
                perSession.set(sid, {
                    configOptions: options.prebuilt.configOptions,
                    modelInfo: options.prebuilt.modelInfo,
                });
                return;
            }
            const hint = targetSessionId === sid ? options?.policyHint : undefined;
            const [configOptions, modelInfo] = await Promise.all([
                buildConfigOptions(seam, workspaceId, sid, hint),
                hint !== undefined
                    ? Promise.resolve({ model: hint.model, spawnModel: hint.spawnModel })
                    : seam.readSessionModel({ workspaceId, sessionId: sid }),
            ]);
            perSession.set(sid, { configOptions, modelInfo });
        }),
    );

    for (const peer of targetPeers) {
        if (!peers.has(peer)) continue;
        const visited = new Set<BoundSession>();
        for (const session of peer.sessions.values()) {
            if (visited.has(session)) continue;
            visited.add(session);
            if (session.workspaceId !== workspaceId) continue;
            if (targetSessionId !== null && session.sessionId !== targetSessionId) continue;
            const computed = perSession.get(session.sessionId);
            if (computed === undefined) continue;
            notifyPeerSession(peer, session.acpSessionId, {
                sessionUpdate: "config_option_update",
                configOptions: computed.configOptions,
                _meta: {
                    plurnk: {
                        workspace: {
                            id: session.workspaceId,
                            name: session.workspaceName,
                            projectRoot: session.projectRoot,
                            projectLabel: session.projectLabel,
                        },
                        status: {
                            model: computed.modelInfo.model,
                            spawnModel: computed.modelInfo.spawnModel,
                        },
                        ...(providerCatalog.aliases !== null ? { providers: providerCatalog.aliases } : {}),
                    },
                },
            });
        }
    }
};

const broadcastWorkspaceNotice = (
    peers: ReadonlySet<AcpPeer>,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
    workspaceId: number,
    notice: Notice,
): void => {
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
};

export const applyWorkspaceRenamed = (
    peers: ReadonlySet<AcpPeer>,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
    workspaceId: number,
    nextName: string,
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
            });
            notifyPeerSession(peer, session.acpSessionId, {
                sessionUpdate: "_plurnk_telemetry",
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
};

export const dispatchDaemonEvent = (
    ctx: DaemonEventDispatchContext,
    workspaceId: number,
    method: DaemonNotificationEvent,
    params: unknown,
): void => {
    const { seam, peers, gates, optionSync, notifyPeerSession, broadcastSessionUpdate } = ctx;
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
                enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, async () => {
                    broadcastSessionUpdate(workspaceId, sessionId, (s) => s.translator.logEntry(params));
                    if (
                        (entryRec.origin === "_plurnk" && entryRec.op === "send") ||
                        (entryRec.origin === "model" && (entryRec.op === "done" || entryRec.op === "fail"))
                    ) {
                        const [rawInbox, rawOpenMessages] = await Promise.all([
                            seam.readInbox({ workspaceId, sessionId }),
                            seam.readOpenMessages({ workspaceId, sessionId }),
                        ]);
                        broadcastSessionUpdate(workspaceId, sessionId, (s) => {
                            const origin = s.translator.origin ?? "";
                            return [
                                {
                                    sessionId: s.acpSessionId,
                                    update: {
                                        sessionUpdate: "_plurnk_telemetry",
                                        _meta: {
                                            plurnk: {
                                                status: {
                                                    inbox: projectInboxItems(
                                                        rawInbox,
                                                        s.acpSessionId,
                                                        origin,
                                                        workspaceId,
                                                        sessionId,
                                                    ),
                                                    openMessages: projectInboxItems(
                                                        rawOpenMessages,
                                                        s.acpSessionId,
                                                        origin,
                                                        workspaceId,
                                                        sessionId,
                                                    ),
                                                },
                                            },
                                        },
                                    },
                                },
                            ];
                        });
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
                ...(typeof params.loopSeq === "number" ? { loopSeq: params.loopSeq } : {}),
                ...(typeof params.turnSeq === "number" ? { turnSeq: params.turnSeq } : {}),
                ...(typeof params.sequence === "number" ? { sequence: params.sequence } : {}),
            };
            const streamOffsetPrefix = `${workspaceId}:${entryId}:`;
            enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, () => {
                for (const key of [...ctx.streamOffsets.keys()]) {
                    if (key.startsWith(streamOffsetPrefix)) {
                        ctx.streamOffsets.delete(key);
                    }
                }
                broadcastSessionUpdate(workspaceId, sessionId, (s) =>
                    s.translator.terminalConcluded(entryId, status, concludedMeta),
                );
            });
            break;
        }
        case "loop/terminated": {
            if (!isTerminatedEvent(params)) break;
            const sessionId = params.sessionId;
            gates.cancelSessionGates(workspaceId, sessionId);
            enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, async () => {
                const [spend, rawInbox, rawOpenMessages] = await Promise.all([
                    seam.sessionAccounting({ workspaceId, sessionId }),
                    seam.readInbox({ workspaceId, sessionId }),
                    seam.readOpenMessages({ workspaceId, sessionId }),
                ]);
                broadcastSessionUpdate(workspaceId, sessionId, (s) => {
                    const origin = s.translator.origin ?? "";
                    return s.translator.terminated(
                        params,
                        spend,
                        projectInboxItems(rawInbox, s.acpSessionId, origin, workspaceId, sessionId),
                        projectInboxItems(rawOpenMessages, s.acpSessionId, origin, workspaceId, sessionId),
                    );
                });
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
                                    sessionUpdate: "_plurnk_telemetry",
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
        case "loop/gate-settled": {
            if (!isLoopGateSettled(params)) break;
            if (params.kind === "proposal") {
                const settledState =
                    params.decision === "accept"
                        ? "resolved"
                        : params.decision === "reject"
                          ? "failed"
                          : "cancelled";
                gates.cancelProposalIfSettled(workspaceId, params.logEntryId, settledState);
            } else {
                gates.settleInteractionIfPending(
                    workspaceId,
                    params.interactionId,
                    params.action,
                    peers,
                    broadcastSessionUpdate,
                );
            }
            break;
        }
        case "functionality/changed": {
            if (!isFunctionalityChanged(params)) break;
            const targetSessionId = typeof params.sessionId === "number" ? params.sessionId : null;
            if (params.family === "skills" || params.family === "mcp" || params.family === "personas") {
                optionSync.recordCommandsUpdate(
                    workspaceId,
                    broadcastWorkspaceCommandsUpdate(seam, peers, notifyPeerSession, workspaceId),
                );
            }
            optionSync.recordConfigUpdate(
                workspaceId,
                broadcastConfigOptionsUpdate(seam, peers, notifyPeerSession, workspaceId, targetSessionId),
            );
            break;
        }
        case "session/policy": {
            if (!isSessionPolicy(params)) break;
            const policyHint: SessionPolicyHint = {
                model: params.model,
                spawnModel: params.spawnModel,
                ...(params.persona === null || typeof params.persona === "string"
                    ? { persona: params.persona }
                    : {}),
            };
            optionSync.recordConfigUpdate(
                workspaceId,
                broadcastConfigOptionsUpdate(seam, peers, notifyPeerSession, workspaceId, params.sessionId, {
                    policyHint,
                }),
            );
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
                broadcastWorkspaceNotice(peers, notifyPeerSession, workspaceId, notice);
            }
            break;
        }
        case "workspace/renamed": {
            if (!isRecord(params) || typeof params.name !== "string" || params.name.length === 0) break;
            applyWorkspaceRenamed(peers, notifyPeerSession, workspaceId, params.name);
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
            break;
        }
        default:
            break;
    }
};

export const dispatchRuntimeStreamEvent = (
    ctx: DaemonEventDispatchContext,
    workspaceId: number,
    method: ApplicationRuntimeStreamEvent,
    params: unknown,
): void => {
    const { seam, peers, streamOffsets, notifyPeerSession, broadcastSessionUpdate } = ctx;
    switch (method) {
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
                ...(typeof params.loopSeq === "number" ? { loopSeq: params.loopSeq } : {}),
                ...(typeof params.turnSeq === "number" ? { turnSeq: params.turnSeq } : {}),
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
                streamOffsets.delete(offsetKey);
                streamOffsets.set(offsetKey, contentLength);
                if (streamOffsets.size > 256) {
                    const oldest = streamOffsets.keys().next().value;
                    if (oldest !== undefined) {
                        streamOffsets.delete(oldest);
                    }
                }
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
        case "loop/packet": {
            if (!isLoopPacket(params)) break;
            const sessionId = params.sessionId;
            enqueueOrRunSessionEvent(ctx, workspaceId, sessionId, async () => {
                const spend = await seam.sessionAccounting({ workspaceId, sessionId });
                broadcastSessionUpdate(workspaceId, sessionId, (s) => s.translator.packet(params, spend));
            });
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
                        sessionUpdate: "_plurnk_telemetry",
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
                void broadcastWorkspaceCommandsUpdate(seam, peers, notifyPeerSession, workspaceId).catch(
                    () => undefined,
                );
            }
            break;
        }
        case "runtime/telemetry": {
            if (!isNoticePayload(params)) break;
            const notice = params.notice;
            const targetSessionId = typeof params.sessionId === "number" ? params.sessionId : null;
            if (targetSessionId !== null) {
                enqueueOrRunSessionEvent(ctx, workspaceId, targetSessionId, async () => {
                    if (
                        notice.source === "engine:lifecycle" &&
                        notice.kind === "loop_status" &&
                        "status" in notice &&
                        notice.status === 202
                    ) {
                        const [rawInbox, rawOpenMessages] = await Promise.all([
                            seam.readInbox({ workspaceId, sessionId: targetSessionId }),
                            seam.readOpenMessages({ workspaceId, sessionId: targetSessionId }),
                        ]);
                        broadcastSessionUpdate(workspaceId, targetSessionId, (s) => {
                            const origin = s.translator.origin ?? "";
                            const inboxItems = projectInboxItems(
                                rawInbox,
                                s.acpSessionId,
                                origin,
                                workspaceId,
                                targetSessionId,
                            );
                            const openMessageItems = projectInboxItems(
                                rawOpenMessages,
                                s.acpSessionId,
                                origin,
                                workspaceId,
                                targetSessionId,
                            );
                            return s.translator.notice(notice).map((item) => {
                                const metaRec = isRecord(item.update._meta) ? item.update._meta : null;
                                const plurnkMeta =
                                    metaRec !== null && isRecord(metaRec.plurnk) ? metaRec.plurnk : null;
                                const statusMeta =
                                    plurnkMeta !== null && isRecord(plurnkMeta.status) ? plurnkMeta.status : null;
                                if (item.update.sessionUpdate !== "_plurnk_telemetry" || metaRec === null || plurnkMeta === null || statusMeta === null) {
                                    return item;
                                }
                                return {
                                    sessionId: item.sessionId,
                                    update: {
                                        ...item.update,
                                        _meta: {
                                            ...metaRec,
                                            plurnk: {
                                                ...plurnkMeta,
                                                status: {
                                                    ...statusMeta,
                                                    inbox: inboxItems,
                                                    openMessages: openMessageItems,
                                                },
                                            },
                                        },
                                    },
                                };
                            });
                        });
                    } else {
                        broadcastSessionUpdate(workspaceId, targetSessionId, (s) => s.translator.notice(notice));
                    }
                });
            } else {
                broadcastWorkspaceNotice(peers, notifyPeerSession, workspaceId, notice);
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
                                        sessionUpdate: "_plurnk_telemetry",
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
    }
};

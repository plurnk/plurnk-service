// {§acp-plurnk-metadata} {§acp-status-descendants}
// ACP v2 projection for `reasoning/event`, `notice/event`, `loop/packet`, and `loop/terminated`.

import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    isRecord,
    type ApplicationLoopPacket,
    type Notice,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import type { PlanTracker, TrackedSessionUpdate } from "./PlanTracker.ts";
import type { StreamCorrelationTracker } from "./StreamTracker.ts";

export const translateReasoningUpdates = (args: {
    readonly acpSessionId: string;
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly sessionName: string;
    readonly origin: string | undefined;
    readonly reasoningMode: "inline" | "link";
    readonly event: ReasoningEventNotification;
    readonly streams: StreamCorrelationTracker;
}): TrackedSessionUpdate[] => {
    const { acpSessionId, workspaceId, sessionId, sessionName, origin, reasoningMode, event, streams } = args;
    if (event.sessionId !== sessionId) return [];
    const turnKey = `${event.sessionId}:${event.turnId}`;
    const messageId = `model-call-${event.modelCallId}/request-${event.requestSequence}/reasoning`;
    const turnCoordinate = `${event.loopSeq}/${event.turnSeq}`;
    const reasoningResourceName = `reasoning://${sessionName}/${turnCoordinate}`;
    const reasoningUrl =
        origin !== undefined
            ? `${origin}/acp/${workspaceId}/${sessionId}/entry?target=${encodeURIComponent(reasoningResourceName)}`
            : undefined;
    if (event.phase === "end") {
        if (reasoningMode === "link" && reasoningUrl !== undefined && streams.hasStreamedReasoning(turnKey)) {
            return [{
                sessionId: acpSessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId,
                    content: {
                        type: "resource_link",
                        name: reasoningResourceName,
                        uri: reasoningUrl,
                        mimeType: "text/plain",
                    },
                    _meta: {
                        plurnk: {
                            sessionId: event.sessionId,
                            sessionName,
                            loopId: event.loopId,
                            loopSeq: event.loopSeq,
                            turnId: event.turnId,
                            turnSeq: event.turnSeq,
                            coordinate: turnCoordinate,
                            body: { url: reasoningUrl, mimeType: "text/plain" },
                        },
                    },
                },
            }];
        }
        return [];
    }
    if (event.phase !== "content" || event.delta.length === 0) return [];
    streams.rememberReasoningTurn(turnKey);
    return [{
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "agent_thought_chunk",
            messageId,
            content: { type: "text", text: event.delta },
            _meta: {
                plurnk: {
                    sessionId: event.sessionId,
                    sessionName,
                    loopId: event.loopId,
                    loopSeq: event.loopSeq,
                    turnId: event.turnId,
                    turnSeq: event.turnSeq,
                    coordinate: turnCoordinate,
                    ...(reasoningUrl !== undefined ? { body: { url: reasoningUrl, mimeType: "text/plain" } } : {}),
                },
            },
        },
    }];
};

export const translateNoticeUpdates = (
    acpSessionId: string,
    notice: Notice,
    streams: StreamCorrelationTracker,
): TrackedSessionUpdate[] => {
    if (notice.source === "engine:emission") {
        return [];
    }
    if (
        (notice.source === "engine:turn" &&
            (notice.kind === "turn_queued" ||
                notice.kind === "turn_awaiting_model" ||
                notice.kind === "turn_generated" ||
                notice.kind === "results_pending")) ||
        (notice.source === "engine:lifecycle" && notice.kind === "loop_status")
    ) {
        return [{
            sessionId: acpSessionId,
            update: {
                sessionUpdate: "_plurnk_telemetry",
                _meta: {
                    plurnk: {
                        notice,
                        ...(notice.kind === "loop_status" && "status" in notice && notice.status === 202
                            ? {
                                  status: {
                                      lifecycle: "parked",
                                      loopId: notice.loopId,
                                      loopSeq: notice.loopSeq,
                                      packetCount: notice.packetCount,
                                      waitUntil:
                                          "waitUntil" in notice && typeof notice.waitUntil === "number"
                                              ? notice.waitUntil
                                              : null,
                                  },
                              }
                            : {}),
                    },
                },
            },
        }];
    }
    if (
        notice.kind === "search_progress" ||
        (notice.source.startsWith("exec:") && "percent" in notice && typeof notice.percent === "number")
    ) {
        return [{
            sessionId: acpSessionId,
            update: {
                sessionUpdate: "_plurnk_telemetry",
                _meta: { plurnk: { notice } },
            },
        }];
    }
    if (notice.source === "engine:configuration") {
        if (!streams.rememberConfigurationNotice(JSON.stringify(notice))) return [];
    }
    if (typeof notice.message !== "string" || notice.message.trim().length === 0) {
        return [];
    }
    const severity = notice.level === "error" ? "error" : notice.level === "warn" ? "warning" : "info";
    return [{
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "notice",
            severity,
            title: `${notice.source}:${notice.kind}`,
            description: notice.message,
            _meta: { plurnk: { notice } },
        },
    }];
};

export const translatePacketUpdates = (args: {
    readonly acpSessionId: string;
    readonly sessionId: number;
    readonly sessionName: string;
    readonly event: ApplicationLoopPacket;
    readonly spend?: unknown;
    readonly plan: PlanTracker;
}): TrackedSessionUpdate[] => {
    const { acpSessionId, sessionId, sessionName, event, spend, plan } = args;
    if (event.sessionId !== sessionId) return [];
    const curationWeight = event.gauge.curationWeight ?? 0;
    const curationBudget = event.gauge.curationBudget ?? 0;
    const contextTokens = event.gauge.contextTokens ?? null;
    const contextCapacity = event.gauge.contextCapacity ?? null;
    const spendRec = isRecord(spend) ? spend : null;
    const costUsd =
        typeof spendRec?.costUsd === "string"
            ? spendRec.costUsd
            : typeof spendRec?.knownCostUsd === "string"
              ? spendRec.knownCostUsd
              : null;
    const cost =
        costUsd !== null && Number.isFinite(Number(costUsd))
            ? { amount: Number(costUsd), currency: "USD" }
            : undefined;
    const updates: TrackedSessionUpdate[] = [];
    const pruned = plan.pruneForLoop(event.loopSeq, {
        sessionId: event.sessionId,
        sessionName,
        loopId: event.loopId,
        loopSeq: event.loopSeq,
    });
    if (pruned !== null) updates.push(pruned);
    updates.push({
        sessionId: acpSessionId,
        update: {
            sessionUpdate: "usage_update",
            used: contextTokens ?? curationWeight,
            size: contextCapacity ?? curationBudget,
            ...(cost !== undefined ? { cost } : {}),
            _meta: {
                plurnk: {
                    budget: {
                        curationWeight,
                        curationBudget,
                        contextTokens,
                        contextCapacity,
                    },
                    status: {
                        loopId: event.loopId,
                        loopSeq: event.loopSeq,
                        packetCount: event.packetCount,
                        ...(spend !== undefined ? { spend } : {}),
                    },
                },
            },
        },
    });
    return updates;
};

export const translateTerminatedUpdates = (args: {
    readonly acpSessionId: string;
    readonly sessionId: number;
    readonly sessionName: string;
    readonly event: TerminatedNotification;
    readonly spend?: unknown;
    readonly inbox?: unknown;
    readonly openMessages?: unknown;
    readonly streams: StreamCorrelationTracker;
    readonly plan: PlanTracker;
}): TrackedSessionUpdate[] => {
    const { acpSessionId, sessionId, sessionName, event, spend, inbox, openMessages, streams, plan } = args;
    if (event.sessionId !== sessionId) return [];
    const usageObj = event.usage;
    const accounting = usageObj?.accounting;
    const costUsd = accounting?.costUsd ?? accounting?.knownCostUsd ?? null;
    const cost = costUsd !== null && costUsd !== undefined
        ? { amount: Number(costUsd), currency: "USD" }
        : undefined;
    const providerUsage = accounting?.usage ?? accounting?.knownUsage ?? null;
    const inputTokens = providerUsage?.inputTokens ?? 0;
    const outputTokens = providerUsage?.outputTokens ?? 0;
    const totalTokens = providerUsage?.totalTokens ?? (inputTokens + outputTokens);
    const reasoningTokens = providerUsage?.outputTokenDetails?.reasoningTokens ?? null;
    const cacheReadTokens = providerUsage?.inputTokenDetails?.cacheReadTokens ?? null;
    const cacheWriteTokens = providerUsage?.inputTokenDetails?.cacheWriteTokens ?? null;
    const usage = {
        totalTokens,
        inputTokens,
        outputTokens,
        ...(reasoningTokens === null ? {} : { thoughtTokens: reasoningTokens }),
        ...(cacheReadTokens === null ? {} : { cachedReadTokens: cacheReadTokens }),
        ...(cacheWriteTokens === null ? {} : { cachedWriteTokens: cacheWriteTokens }),
    };

    const resultRec = event.result;
    const status = resultRec.status;
    const hitMaxTurns = event.hitMaxTurns;
    const turnCount = Array.isArray(event.turnIds) ? event.turnIds.length : undefined;
    const problem = resultRec.problem ?? null;
    const terminalMeta = {
        plurnk: {
            loopId: event.loopId,
            loopSeq: event.loopSeq,
            ...(spend !== undefined || inbox !== undefined || openMessages !== undefined
                ? {
                      status: {
                          ...(spend !== undefined ? { spend } : {}),
                          ...(inbox !== undefined ? { inbox } : {}),
                          ...(openMessages !== undefined ? { openMessages } : {}),
                      },
                  }
                : {}),
            terminal: {
                status,
                ...(turnCount !== undefined ? { turnCount } : {}),
                hitMaxTurns,
                usage: usageObj,
                result: resultRec,
                ...(problem !== null ? { problem } : {}),
            },
        },
    };

    const idleUpdate: SessionUpdate = hitMaxTurns || status === 429
        ? { sessionUpdate: "state_update", state: "idle", stopReason: "max_turn_requests", usage, _meta: terminalMeta }
        : status === 499
            ? { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled", usage, _meta: terminalMeta }
            : status >= 400
                ? { sessionUpdate: "state_update", state: "idle", stopReason: "refusal", usage, _meta: terminalMeta }
                : { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", usage, _meta: terminalMeta };

    const curationWeight = usageObj?.curationWeight ?? null;
    const curationBudget = usageObj?.curationBudget ?? null;
    const contextTokens = usageObj?.contextTokens ?? null;
    const contextCapacity = usageObj?.contextCapacity ?? null;
    const used = contextTokens ?? curationWeight;
    const size = contextCapacity ?? curationBudget;

    const updates: TrackedSessionUpdate[] = [];
    streams.clearReasoningTurns();
    const pruned = plan.pruneForLoop(event.loopSeq, {
        sessionId: event.sessionId,
        sessionName,
        loopId: event.loopId,
        loopSeq: event.loopSeq,
    });
    if (pruned !== null) updates.push(pruned);
    if (used !== null && size !== null && size > 0) {
        updates.push({
            sessionId: acpSessionId,
            update: {
                sessionUpdate: "usage_update",
                used,
                size,
                ...(cost === undefined ? {} : { cost }),
                _meta: {
                    plurnk: {
                        budget: {
                            curationWeight,
                            curationBudget,
                            contextTokens,
                            contextCapacity,
                        },
                    },
                },
            },
        });
    }
    updates.push({
        sessionId: acpSessionId,
        update: { ...idleUpdate },
    });
    return updates;
};

// {§acp-plurnk-metadata} {§acp-history-window} Pure standard ACP v2 projection from daemon events onto ACP v2 SessionUpdate notifications.

import type {
    PlanEntry,
    PlanEntryStatus,
    SessionUpdate,
    ToolCallContent,
    ToolCallStatus,
    ToolKind,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    addressOf,
    isRecord,
    isSafeInteger,
    toolKindOf,
    type ApplicationInboxMessage,
    type ApplicationLoopPacket,
    type LogEntryNotification,
    type LogEntryWire,
    type Notice,
    type OutsideEventNotification,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import { buildDiffChanges, buildUnifiedDiff } from "./diff.ts";
import {
    attrRecord,
    cleanReceipt,
    extractMessageId,
    extractStartLine,
    invocationCoordinate,
    isResponseMessage,
    parseJsonOrValue,
    statusOf,
    txBody,
} from "./log-entry-projection.ts";
import { replaySessionHistory, type ReplayResult } from "./replay.ts";

export interface AcpSessionUpdate {
    readonly sessionId: string;
    readonly update: SessionUpdate;
}

export const terminalIdForEntry = (logEntryId: number): string => `term:${logEntryId}`;

const TASK_ITEM_RE = /^[ \t]*[-*+]\s+\[([ xX~/-])\]\s+(.+)$/gmu;

const parsePlanTaskEntries = (body: string): PlanEntry[] => {
    const entries: PlanEntry[] = [];
    for (const match of body.matchAll(TASK_ITEM_RE)) {
        const marker = match[1] ?? " ";
        const rawText = (match[2] ?? "").trim();
        if (rawText.length === 0) continue;
        const status: PlanEntryStatus =
            marker === "x" || marker === "X"
                ? "completed"
                : marker === "/" || marker === "~"
                  ? "in_progress"
                  : marker === "-"
                    ? "cancelled"
                    : "pending";
        entries.push({
            content: rawText,
            priority: "medium",
            status,
        });
    }
    return entries;
};

export default class SessionTranslator {
    readonly #acpSessionId: string;
    readonly #workspaceId: number;
    readonly #sessionId: number;
    readonly #origin: string | undefined;
    readonly #streamedReasoningTurns = new Set<string>();
    readonly #toolCallIdByEntryId = new Map<number, string>();
    readonly #planIdByCoordinate = new Map<string, string>();
    readonly #planIdByTarget = new Map<string, string>();

    constructor(args: {
        readonly acpSessionId: string;
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly origin?: string;
    }) {
        this.#acpSessionId = args.acpSessionId;
        this.#workspaceId = args.workspaceId;
        this.#sessionId = args.sessionId;
        this.#origin = args.origin;
    }

    get acpSessionId(): string {
        return this.#acpSessionId;
    }

    get workspaceId(): number {
        return this.#workspaceId;
    }

    get sessionId(): number {
        return this.#sessionId;
    }

    get origin(): string | undefined {
        return this.#origin;
    }

    static coordinateOf(row: { readonly loop_seq?: unknown; readonly turn_seq?: unknown; readonly sequence?: unknown }): string {
        if (!isSafeInteger(row.loop_seq) || !isSafeInteger(row.turn_seq) || !isSafeInteger(row.sequence)) {
            throw new TypeError(`Log entry missing logical coordinate: ${JSON.stringify(row)}`);
        }
        return `${row.loop_seq}/${row.turn_seq}/${row.sequence}`;
    }

    static toolKindOf(op: string | null, scheme: string | null): ToolKind {
        return toolKindOf(op, scheme);
    }

    static toolStatusOf(row: { readonly state?: unknown; readonly status_rx?: unknown; readonly attrs?: unknown }): ToolCallStatus {
        if (row.state === "proposed") return "pending";
        const statusRx = statusOf(row);
        if (row.state === "failed" || row.state === "cancelled" || statusRx >= 400) {
            return "failed";
        }
        const attrs = attrRecord(row.attrs);
        if (statusRx < 400 && typeof attrs.stream === "string") {
            return "in_progress";
        }
        return "completed";
    }

    logEntry({ entry }: LogEntryNotification): AcpSessionUpdate[] {
        if (entry.session_id !== this.#sessionId) return [];

        const updates: AcpSessionUpdate[] = [];
        const coordinate = SessionTranslator.coordinateOf(entry);
        const attrs = attrRecord(entry.attrs);
        const parsedTx = parseJsonOrValue(entry.tx);
        const parsedRx = parseJsonOrValue(entry.rx);
        const text = txBody(parsedTx, attrs, parsedRx);
        const { receipt, contentBlocks } = cleanReceipt(entry.rx);
        const rawAddress = addressOf(entry);
        const address =
            rawAddress ??
            (typeof attrs.path === "string"
                ? attrs.path
                : typeof attrs.session === "string" && attrs.session.length > 0
                  ? attrs.session.includes("://")
                      ? attrs.session
                      : `session://${attrs.session}`
                  : typeof attrs.to === "string" && attrs.to.length > 0
                    ? attrs.to
                    : typeof entry.scheme === "string" && typeof entry.hostname === "string" && entry.hostname.length > 0
                      ? `${entry.scheme}://${entry.hostname}`
                      : null);
        const statusRx = statusOf(entry);

        const reasoningTurnKey = `${entry.session_id}:${entry.turn_id}`;
        if (
            entry.op !== null
            && typeof entry.reasoning === "string"
            && entry.reasoning.length > 0
            && !this.#streamedReasoningTurns.has(reasoningTurnKey)
        ) {
            this.#streamedReasoningTurns.add(reasoningTurnKey);
            const thoughtMessageId = entry.reasoning_model_call_id !== null && entry.reasoning_model_call_id !== undefined
                ? `model-call-${entry.reasoning_model_call_id}/request-${entry.reasoning_request_sequence ?? 1}/reasoning`
                : `${coordinate}/reasoning`;
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: thoughtMessageId,
                    content: { type: "text", text: entry.reasoning },
                },
            });
        }

        // 1. Agent response message
        const isResponse = isResponseMessage(entry, parsedRx, attrs, text, this.#acpSessionId);
        const isBodiedWait = entry.origin === "model" && entry.op === "WAIT" && text.trim().length > 0;
        const opMeta = {
            id: entry.id,
            coordinate,
            op: entry.op,
            origin: entry.origin,
            status: statusRx,
            turnId: entry.turn_id,
            turnSeq: entry.turn_seq,
            loopId: entry.loop_id,
            loopSeq: entry.loop_seq,
            sequence: entry.sequence,
            scope: null,
            ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        };
        if (isResponse || isBodiedWait) {
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: coordinate,
                    content: { type: "text", text },
                    _meta: { plurnk: opMeta },
                },
            });
            return updates;
        }

        // 2. Async tool completion
        const completingAnswer = (entry.origin === "_plurnk" || entry.origin === "system")
            && typeof entry.answering === "string"
            && (entry.signal === 200 || entry.signal === 499 || (isRecord(parsedRx) && (parsedRx.completion === 200 || parsedRx.completion === 499)));
        const rawInvocation = typeof entry.invocation === "string"
            ? entry.invocation
            : typeof attrs.invocation === "string"
                ? attrs.invocation
                : completingAnswer
                    ? entry.answering
                    : undefined;
        const targetCallId = invocationCoordinate(rawInvocation);
        if (targetCallId !== null) {
            const dischargeContent: ToolCallContent[] = entry.op === "SEND" && text.length > 0
                ? [{ type: "content", content: { type: "text", text } }]
                : contentBlocks;
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: targetCallId,
                    status: SessionTranslator.toolStatusOf(entry),
                    rawOutput: receipt,
                    ...(dischargeContent.length === 0 ? {} : { content: dischargeContent }),
                },
            });
            return updates;
        }

        // 3. User message
        if (
            (entry.origin === "_plurnk" || entry.origin === "system")
            && entry.op === "SEND"
            && (attrs.kind === "message" || typeof entry.answering === "string")
        ) {
            const messageId = extractMessageId(entry.source, this.#acpSessionId) ?? coordinate;
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "user_message_chunk",
                    messageId,
                    content: { type: "text", text },
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            ...(typeof entry.answering === "string" ? { answering: entry.answering } : {}),
                            ...(typeof entry.source === "string" ? { source: entry.source } : {}),
                        },
                    },
                },
            });
            return updates;
        }

        // 4. Failed tool attempt
        if (entry.origin === "model" && (entry.op === "error" || entry.op === "ERROR")) {
            const attempt = isRecord(attrs.attempt) ? attrs.attempt : null;
            if (attempt !== null && typeof attempt.verb === "string") {
                const verb = attempt.verb;
                updates.push({
                    sessionId: this.#acpSessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: coordinate,
                        name: verb,
                        title: verb,
                        kind: SessionTranslator.toolKindOf(verb, null),
                        status: "failed",
                        rawInput: { text: typeof attempt.text === "string" ? attempt.text : "" },
                        rawOutput: receipt,
                        ...(contentBlocks.length === 0 ? {} : { content: contentBlocks }),
                    },
                });
                return updates;
            }
        }

        // 5. Standard tool call
        if (entry.op !== null && entry.op !== "error" && entry.op !== "ERROR") {
            this.#toolCallIdByEntryId.set(entry.id, coordinate);
            const kind = SessionTranslator.toolKindOf(entry.op, entry.scheme ?? null);
            const status = SessionTranslator.toolStatusOf(entry);
            const rawInput = isRecord(parsedTx)
                ? Object.fromEntries(Object.entries(parsedTx).filter(([k]) => k !== "op" && k !== "position"))
                : parsedTx;
            const content: ToolCallContent[] = [];

            if (typeof attrs.patch === "string" && attrs.patch.length > 0) {
                const path = address ?? entry.pathname ?? "";
                content.push({
                    type: "diff",
                    changes: buildDiffChanges({
                        op: entry.op,
                        path,
                        statusRx,
                        attrs,
                        parsedTx,
                    }),
                    patch: {
                        format: "git_patch",
                        text: attrs.patch,
                    },
                });
            } else if (typeof attrs.original === "string" && typeof attrs.patched === "string") {
                const path = address ?? entry.pathname ?? "";
                content.push({
                    type: "diff",
                    changes: buildDiffChanges({
                        op: entry.op,
                        path,
                        statusRx,
                        attrs,
                        parsedTx,
                    }),
                    patch: {
                        format: "git_patch",
                        text: buildUnifiedDiff(path, attrs.original, attrs.patched),
                    },
                });
            } else if (entry.op === "MOVE" || entry.op === "COPY") {
                const path = address ?? entry.pathname ?? "";
                const changes = buildDiffChanges({
                    op: entry.op,
                    path,
                    statusRx,
                    attrs,
                    parsedTx,
                });
                if (changes.some((c) => c.operation === "move" || c.operation === "copy")) {
                    content.push({
                        type: "diff",
                        changes,
                    });
                }
            }

            if (typeof attrs.stream === "string") {
                const terminalId = terminalIdForEntry(entry.id);
                content.push({
                    type: "terminal",
                    terminalId,
                });
            }

            for (const block of contentBlocks) {
                content.push(block);
            }

            const comment = isRecord(parsedTx) && typeof parsedTx.aside === "string" && parsedTx.aside.length > 0
                ? parsedTx.aside
                : isRecord(parsedTx) && typeof parsedTx.comment === "string" && parsedTx.comment.length > 0
                    ? parsedTx.comment
                    : typeof attrs.aside === "string" && attrs.aside.length > 0
                        ? attrs.aside
                        : typeof attrs.comment === "string" && attrs.comment.length > 0
                            ? attrs.comment
                            : null;
            const baseTitle = address === null ? entry.op : `${entry.op} (${address})`;
            const title = comment === null ? baseTitle : `${baseTitle} — ${comment}`;
            const bodyUrl = this.#origin !== undefined
                ? `${this.#origin}/acp/${this.#workspaceId}/${this.#sessionId}/entry?target=${encodeURIComponent(`log:///${coordinate}/${entry.op}`)}`
                : undefined;

            const startLine = extractStartLine(attrs, parsedTx, parsedRx);

            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: coordinate,
                    name: entry.op,
                    title,
                    kind,
                    status,
                    ...(address === null
                        ? {}
                        : {
                              locations: [
                                  {
                                      path: address,
                                      ...(startLine !== undefined ? { line: startLine } : {}),
                                  },
                              ],
                          }),
                    rawInput,
                    rawOutput: receipt,
                    ...(content.length === 0 ? {} : { content }),
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            ...(bodyUrl !== undefined ? { body: { url: bodyUrl } } : {}),
                        },
                    },
                },
            });

            if (typeof attrs.stream === "string") {
                const terminalId = terminalIdForEntry(entry.id);
                const command = text.length > 0 ? text : undefined;
                const initialOut = isRecord(parsedRx) && typeof parsedRx.stdout === "string"
                    ? parsedRx.stdout + (typeof parsedRx.stderr === "string" ? parsedRx.stderr : "")
                    : isRecord(parsedRx) && typeof parsedRx.content === "string"
                        ? parsedRx.content
                        : undefined;
                updates.push({
                    sessionId: this.#acpSessionId,
                    update: {
                        sessionUpdate: "terminal_update",
                        terminalId,
                        ...(command !== undefined ? { command } : {}),
                        ...(initialOut !== undefined && initialOut.length > 0
                            ? { output: { data: Buffer.from(initialOut, "utf8").toString("base64") } }
                            : {}),
                        ...(status === "completed" || status === "failed"
                            ? { exitStatus: { exitCode: statusRx === 200 ? 0 : statusRx } }
                            : {}),
                    },
                });
            }

            if (entry.op === "NOTE" && status === "completed") {
                const taskEntries = parsePlanTaskEntries(text);
                const isExplicitPlan =
                    (address !== null && /(?:^|\/|:)plan(?:\.md)?$/iu.test(address)) ||
                    (comment !== null && /\bplan\b/iu.test(comment));
                if (taskEntries.length > 0 || (isExplicitPlan && text.trim().length > 0)) {
                    const planId = address !== null && address.length > 0 ? address : "plan";
                    this.#planIdByCoordinate.set(coordinate, planId);
                    if (address !== null && address.length > 0) {
                        this.#planIdByTarget.set(address, planId);
                    }
                    updates.push({
                        sessionId: this.#acpSessionId,
                        update: {
                            sessionUpdate: "plan_update",
                            plan:
                                taskEntries.length > 0
                                    ? { type: "items", planId, entries: taskEntries }
                                    : { type: "markdown", planId, content: text },
                            _meta: { plurnk: opMeta },
                        },
                    });
                }
            } else if (entry.op === "KILL" && status === "completed") {
                const removedPlanIds = new Set<string>();
                if (address !== null) {
                    if (this.#planIdByTarget.has(address)) {
                        const pid = this.#planIdByTarget.get(address)!;
                        removedPlanIds.add(pid);
                        this.#planIdByTarget.delete(address);
                    }
                    const logPrefix = "log:///";
                    const rawCoord = address.startsWith(logPrefix)
                        ? address.slice(logPrefix.length).replace(/\/[A-Za-z_][A-Za-z0-9_]*$/u, "")
                        : null;
                    if (rawCoord !== null) {
                        for (const [noteCoord, pid] of [...this.#planIdByCoordinate.entries()]) {
                            if (noteCoord === rawCoord || noteCoord.startsWith(`${rawCoord}/`)) {
                                removedPlanIds.add(pid);
                                this.#planIdByCoordinate.delete(noteCoord);
                            }
                        }
                    }
                }
                for (const planId of removedPlanIds) {
                    updates.push({
                        sessionId: this.#acpSessionId,
                        update: {
                            sessionUpdate: "plan_removed",
                            planId,
                            _meta: { plurnk: opMeta },
                        },
                    });
                }
            }
            return updates;
        }

        return updates;
    }

    reasoning(event: ReasoningEventNotification): AcpSessionUpdate[] {
        if (event.sessionId !== this.#sessionId) return [];
        if (event.phase !== "content" || event.delta.length === 0) return [];
        const messageId = `model-call-${event.modelCallId}/request-${event.requestSequence}/reasoning`;
        this.#streamedReasoningTurns.add(`${event.sessionId}:${event.turnId}`);
        return [{
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "agent_thought_chunk",
                messageId,
                content: { type: "text", text: event.delta },
            },
        }];
    }

    terminalChunk(entryId: number, text: string, meta?: Record<string, unknown>): AcpSessionUpdate[] {
        if (text.length === 0) return [];
        return [{
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "terminal_output_chunk",
                terminalId: terminalIdForEntry(entryId),
                data: Buffer.from(text, "utf8").toString("base64"),
                ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
            },
        }];
    }

    terminalConcluded(entryId: number, status: number, meta?: Record<string, unknown>): AcpSessionUpdate[] {
        const terminalId = terminalIdForEntry(entryId);
        const updates: AcpSessionUpdate[] = [
            {
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "terminal_update",
                    terminalId,
                    exitStatus: {
                        exitCode: status === 200 ? 0 : status,
                    },
                    ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
                },
            },
        ];
        const toolCallId = this.#toolCallIdByEntryId.get(entryId);
        if (toolCallId !== undefined) {
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: status < 400 ? "completed" : "failed",
                },
            });
        }
        return updates;
    }

    notice(notice: Notice): AcpSessionUpdate[] {
        const severity = notice.level === "error"
            ? "error"
            : notice.level === "warn"
                ? "warning"
                : "info";
        return [{
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "notice",
                severity,
                title: `${notice.source}:${notice.kind}`,
                ...(typeof notice.message === "string" ? { description: notice.message } : {}),
                _meta: {
                    plurnk: {
                        notice,
                    },
                },
            },
        }];
    }

    outside(event: OutsideEventNotification): AcpSessionUpdate[] {
        if (event.sessionId !== this.#sessionId) return [];
        return [{
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "agent_message_chunk",
                messageId: `outside-${event.coordinate}`,
                content: { type: "text", text: event.text },
                _meta: {
                    plurnk: {
                        op: "outside-",
                        outside: {
                            coordinate: event.coordinate,
                            tokens: event.tokens,
                        },
                    },
                },
            },
        }];
    }

    packet(event: ApplicationLoopPacket): AcpSessionUpdate[] {
        if (event.sessionId !== this.#sessionId) return [];
        const curationWeight = event.gauge.curationWeight ?? 0;
        const curationBudget = event.gauge.curationBudget ?? 0;
        const contextTokens = event.gauge.contextTokens ?? null;
        const contextCapacity = event.gauge.contextCapacity ?? null;
        return [{
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "usage_update",
                used: contextTokens ?? curationWeight,
                size: contextCapacity ?? curationBudget,
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
        }];
    }

    terminated(event: TerminatedNotification): AcpSessionUpdate[] {
        if (event.sessionId !== this.#sessionId) return [];
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

        const updates: AcpSessionUpdate[] = [];
        if (used !== null && size !== null && size > 0) {
            updates.push({
                sessionId: this.#acpSessionId,
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
            sessionId: this.#acpSessionId,
            update: {
                ...idleUpdate,
            },
        });
        return updates;
    }

    static replay(
        translator: SessionTranslator,
        rows: readonly LogEntryWire[],
        inbox: readonly ApplicationInboxMessage[] = [],
        options: {
            readonly historyLoops?: number;
            readonly beforeLoopSeq?: number;
            readonly exactLoopSeq?: number;
        } = {},
    ): ReplayResult {
        return replaySessionHistory(translator, rows, inbox, options);
    }
}

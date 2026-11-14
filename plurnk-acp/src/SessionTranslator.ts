// {§acp-plurnk-metadata} {§acp-history-window} Pure standard ACP v2 projection from daemon events onto ACP v2 SessionUpdate notifications.

import type {
    PlanEntry,
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
    extractVoice,
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

export default class SessionTranslator {
    readonly #acpSessionId: string;
    readonly #workspaceId: number;
    readonly #sessionId: number;
    readonly #sessionName: string;
    readonly #origin: string | undefined;
    readonly #streamedReasoningTurns = new Set<string>();
    readonly #toolCallIdByEntryId = new Map<number, string>();
    readonly #toolCallIdByStreamTarget = new Map<string, string>();
    readonly #concludedStreamStatusByEntryId = new Map<number, number>();
    readonly #concludedStreamStatusByTarget = new Map<string, number>();
    readonly #planEntries = new Map<
        string,
        {
            readonly content: string;
            readonly status: "in_progress" | "completed" | "cancelled";
            readonly turnSeq: number;
        }
    >();
    readonly #emittedConfigurationNotices = new Set<string>();
    #planLoopSeq: number | null = null;
    #planTurnSeq: number | null = null;

    constructor(args: {
        readonly acpSessionId: string;
        readonly workspaceId: number;
        readonly sessionId: number;
        readonly sessionName?: string;
        readonly origin?: string;
        readonly historyPageChars?: number;
    }) {
        this.#acpSessionId = args.acpSessionId;
        this.#workspaceId = args.workspaceId;
        this.#sessionId = args.sessionId;
        const hashIdx = args.acpSessionId.indexOf("#");
        this.#sessionName =
            args.sessionName ??
            (hashIdx > 0 && hashIdx < args.acpSessionId.length - 1
                ? args.acpSessionId.slice(hashIdx + 1)
                : args.acpSessionId);
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

    #buildPlanEntries(): PlanEntry[] {
        return [...this.#planEntries.values()].map(({ content, status }) => ({
            content,
            priority: "medium",
            status,
        }));
    }

    #pruneInProgressPlanEntries(beforeTurnSeq?: number, meta?: Record<string, unknown>): AcpSessionUpdate | null {
        let removed = false;
        for (const [coord, item] of [...this.#planEntries.entries()]) {
            if (item.status === "in_progress" && (beforeTurnSeq === undefined || item.turnSeq < beforeTurnSeq)) {
                this.#planEntries.delete(coord);
                removed = true;
            }
        }
        if (!removed) return null;
        if (this.#planEntries.size === 0) {
            return {
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "plan_removed",
                    planId: "plan",
                    ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
                },
            };
        }
        return {
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "plan_update",
                plan: { type: "items", planId: "plan", entries: this.#buildPlanEntries() },
                ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
            },
        };
    }

    logEntry({ entry }: LogEntryNotification): AcpSessionUpdate[] {
        if (entry.session_id !== this.#sessionId) return [];
        const updates: AcpSessionUpdate[] = [];
        let prunedPlanUpdate: AcpSessionUpdate | null = null;
        if (isSafeInteger(entry.loop_seq) && this.#planLoopSeq !== entry.loop_seq) {
            this.#planLoopSeq = entry.loop_seq;
            this.#planTurnSeq = isSafeInteger(entry.turn_seq) ? entry.turn_seq : null;
            this.#planEntries.clear();
        } else if (isSafeInteger(entry.turn_seq)) {
            if (this.#planTurnSeq !== null && entry.turn_seq > this.#planTurnSeq) {
                prunedPlanUpdate = this.#pruneInProgressPlanEntries(entry.turn_seq, {
                    sessionId: entry.session_id,
                    loopId: entry.loop_id,
                    loopSeq: entry.loop_seq,
                    turnId: entry.turn_id,
                    turnSeq: entry.turn_seq,
                });
                if (prunedPlanUpdate !== null) {
                    updates.push(prunedPlanUpdate);
                }
                this.#planTurnSeq = entry.turn_seq;
            } else if (this.#planTurnSeq === null) {
                this.#planTurnSeq = entry.turn_seq;
            }
        }

        const coordinate = SessionTranslator.coordinateOf(entry);
        const attrs = attrRecord(entry.attrs);
        const parsedTx = parseJsonOrValue(entry.tx);
        const parsedRx = parseJsonOrValue(entry.rx);
        const text = txBody(parsedTx, attrs, parsedRx);
        const leaf = entry.op ?? (attrs.kind === "emissionAttempt" ? "attempt" : null);
        const bodyUrl =
            this.#origin !== undefined && leaf !== null
                ? `${this.#origin}/acp/${this.#workspaceId}/${this.#sessionId}/entry?target=${encodeURIComponent(`log:///${coordinate}/${leaf}`)}`
                : undefined;
        const { receipt, contentBlocks } = cleanReceipt(
            entry.rx,
            bodyUrl,
            leaf !== null ? `log:///${coordinate}/${leaf}` : undefined,
        );
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

        const reasoningText = typeof entry.reasoning === "string" && entry.reasoning.length > 0 ? entry.reasoning : null;
        const sessionName =
            typeof entry.session_name === "string" && entry.session_name.length > 0
                ? entry.session_name
                : this.#sessionName;
        const turnCoordinate = `${entry.loop_seq}/${entry.turn_seq}`;
        const reasoningUrl =
            reasoningText !== null && this.#origin !== undefined
                ? `${this.#origin}/acp/${this.#workspaceId}/${this.#sessionId}/entry?target=${encodeURIComponent(`reasoning://${sessionName}/${turnCoordinate}`)}`
                : undefined;
        const reasoningTurnKey = `${entry.session_id}:${entry.turn_id}`;
        if (
            entry.op !== null
            && reasoningText !== null
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
                    content: { type: "text", text: reasoningText },
                    _meta: {
                        plurnk: {
                            sessionId: entry.session_id,
                            sessionName,
                            loopId: entry.loop_id,
                            loopSeq: entry.loop_seq,
                            turnId: entry.turn_id,
                            turnSeq: entry.turn_seq,
                            coordinate: turnCoordinate,
                            ...(reasoningUrl !== undefined
                                ? { body: { url: reasoningUrl, mimeType: "text/plain" } }
                                : {}),
                        },
                    },
                },
            });
        }

        // 1. Agent response message
        const isResponse = isResponseMessage(entry, parsedRx, attrs, text, this.#acpSessionId);
        const isBodiedWait = entry.origin === "model" && entry.op === "wait" && text.trim().length > 0;
        const repliedToSources =
            Array.isArray(entry.replied_to_sources) && entry.replied_to_sources.length > 0
                ? entry.replied_to_sources.filter((s): s is string => typeof s === "string" && s.length > 0)
                : undefined;
        const repliedToMessageIds =
            repliedToSources !== undefined
                ? repliedToSources
                      .map((src) => extractMessageId(src, this.#acpSessionId))
                      .filter((id): id is string => id !== null)
                : undefined;
        const enrichedReceipt = isRecord(receipt)
            ? {
                  ...receipt,
                  ...(repliedToMessageIds !== undefined && repliedToMessageIds.length > 0
                      ? { repliedToMessageIds }
                      : {}),
                  ...(repliedToSources !== undefined && repliedToSources.length > 0
                      ? { repliedToSources }
                      : {}),
              }
            : receipt;
        const replyVoices = [
            ...new Set([
                ...(repliedToSources ?? []).map((src) => extractVoice(src)),
                ...(isRecord(receipt) && Array.isArray(receipt.repliedTo)
                    ? receipt.repliedTo.map((src) => (typeof src === "string" ? extractVoice(src) : undefined))
                    : []),
                extractVoice(address),
            ]),
        ].filter((v): v is string => typeof v === "string" && v.length > 0);
        const replyVoice = replyVoices[0];
        const opMeta = {
            id: entry.id,
            sessionId: entry.session_id,
            sessionName,
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
            ...(typeof entry.state === "string" ? { state: entry.state } : {}),
            ...(typeof entry.source === "string" ? { source: entry.source } : {}),
            ...(typeof entry.signal === "number" ? { signal: entry.signal } : {}),
            ...(address !== null ? { address, target: address } : {}),
            ...(replyVoice !== undefined ? { voice: replyVoice } : {}),
            ...(replyVoices.length > 0 ? { voices: replyVoices } : {}),
            ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
            ...(isRecord(enrichedReceipt) ? { receipt: enrichedReceipt } : {}),
            ...(reasoningUrl !== undefined
                ? { reasoning: { url: reasoningUrl, mimeType: "text/plain" } }
                : {}),
        };
        if (isResponse || isBodiedWait) {
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: coordinate,
                    content: { type: "text", text },
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            ...(bodyUrl !== undefined
                                ? {
                                      body: {
                                          url: bodyUrl,
                                          mimeType:
                                              typeof entry.mimetype_rx === "string"
                                                  ? entry.mimetype_rx
                                                  : "text/markdown",
                                      },
                                  }
                                : {}),
                            ...(repliedToMessageIds !== undefined && repliedToMessageIds.length > 0
                                ? {
                                      inReplyTo: repliedToMessageIds[0],
                                      repliedToMessageIds,
                                  }
                                : {}),
                            ...(isBodiedWait && isRecord(enrichedReceipt) ? { receipt: enrichedReceipt } : {}),
                        },
                    },
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
            const dischargeCompletion = isRecord(parsedRx) ? parsedRx.completion : undefined;
            const dischargeStatus: ToolCallStatus =
                entry.op === "fail" || entry.signal === 499 || dischargeCompletion === 499
                    ? "failed"
                    : SessionTranslator.toolStatusOf(entry);
            const dischargeContent: ToolCallContent[] = (entry.op === "send" || entry.op === "done" || entry.op === "fail") && text.length > 0
                ? [{ type: "content", content: { type: "text", text } }]
                : contentBlocks;
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: targetCallId,
                    status: dischargeStatus,
                    capabilities: { cancel: dischargeStatus === "in_progress" ? {} : null },
                    rawOutput: receipt,
                    ...(dischargeContent.length === 0 ? {} : { content: dischargeContent }),
                    _meta: { plurnk: opMeta },
                },
            });
            const existingPlan = this.#planEntries.get(targetCallId);
            if (existingPlan !== undefined) {
                const nextStatus: "in_progress" | "completed" | "cancelled" =
                    dischargeStatus === "completed"
                        ? "completed"
                        : dischargeStatus === "failed"
                          ? "cancelled"
                          : "in_progress";
                if (existingPlan.status !== nextStatus) {
                    this.#planEntries.set(targetCallId, { ...existingPlan, status: nextStatus });
                    if (prunedPlanUpdate !== null) {
                        const idx = updates.indexOf(prunedPlanUpdate);
                        if (idx !== -1) updates.splice(idx, 1);
                    }
                    updates.push({
                        sessionId: this.#acpSessionId,
                        update: {
                            sessionUpdate: "plan_update",
                            plan: { type: "items", planId: "plan", entries: this.#buildPlanEntries() },
                            _meta: { plurnk: opMeta },
                        },
                    });
                }
            }
            return updates;
        }

        // 3. User message
        if (
            (entry.origin === "_plurnk" || entry.origin === "system")
            && entry.op === "send"
            && (attrs.kind === "message" || typeof entry.answering === "string")
        ) {
            const messageId = extractMessageId(entry.source, this.#acpSessionId) ?? coordinate;
            const userVoice = extractVoice(entry.source) ?? extractVoice(address);
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "user_message_chunk",
                    messageId,
                    content: { type: "text", text },
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            ...(bodyUrl !== undefined
                                ? {
                                      body: {
                                          url: bodyUrl,
                                          mimeType:
                                              typeof entry.mimetype_tx === "string"
                                                  ? entry.mimetype_tx
                                                  : "text/plain",
                                      },
                                  }
                                : {}),
                            ...(typeof entry.answering === "string" ? { answering: entry.answering } : {}),
                            ...(typeof entry.source === "string" ? { source: entry.source } : {}),
                            ...(userVoice !== undefined ? { voice: userVoice } : {}),
                        },
                    },
                },
            });
            return updates;
        }

        // 4. Failed tool attempt or error row
        if (entry.op === "error") {
            const attempt = isRecord(attrs.attempt) ? attrs.attempt : null;
            if (entry.origin === "model" && attempt !== null && typeof attempt.verb === "string") {
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
                        _meta: { plurnk: opMeta },
                    },
                });
                return updates;
            }
            const problemRec = isRecord(parsedRx) && isRecord(parsedRx.problem) ? parsedRx.problem : null;
            const detail =
                typeof problemRec?.detail === "string"
                    ? problemRec.detail
                    : typeof problemRec?.title === "string"
                      ? problemRec.title
                      : undefined;
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: entry.origin === "model" ? "warning" : "error",
                    title:
                        typeof entry.source === "string" && entry.source.length > 0
                            ? `${entry.source}:error`
                            : "error",
                    ...(detail !== undefined ? { description: detail } : {}),
                    _meta: {
                        plurnk: {
                            ...opMeta,
                            ...(bodyUrl !== undefined ? { body: { url: bodyUrl } } : {}),
                        },
                    },
                },
            });
            return updates;
        }

        // 5. Standard tool call (omitting internal daemon bookkeeping)
        if (
            entry.origin === "_plurnk" &&
            entry.op === "read" &&
            (attrs.kind === "emission" || (address !== null && address.startsWith("ops://")))
        ) {
            return updates;
        }
        if (
            entry.origin === "_plurnk" &&
            entry.op === "edit" &&
            attrs.kind === "entry_materialized"
        ) {
            return updates;
        }
        if (
            entry.op === "note" &&
            typeof attrs.distilled === "string" &&
            attrs.distilled.trim().length > 0
        ) {
            return updates;
        }
        if (entry.op !== null && entry.op !== "error") {
            this.#toolCallIdByEntryId.set(entry.id, coordinate);
            if (typeof attrs.stream === "string" && attrs.stream.length > 0) {
                this.#toolCallIdByStreamTarget.set(attrs.stream, coordinate);
            }
            const kind = SessionTranslator.toolKindOf(entry.op, entry.scheme ?? null);
            const concludedStreamStatus =
                (typeof attrs.stream === "string" && attrs.stream.length > 0
                    ? this.#concludedStreamStatusByTarget.get(attrs.stream)
                    : undefined) ??
                this.#concludedStreamStatusByEntryId.get(entry.id);
            const rawStatus = SessionTranslator.toolStatusOf(entry);
            const status: ToolCallStatus =
                rawStatus === "in_progress" && concludedStreamStatus !== undefined
                    ? concludedStreamStatus < 400
                        ? "completed"
                        : "failed"
                    : rawStatus;
            const effectiveStatusRx =
                rawStatus === "in_progress" && concludedStreamStatus !== undefined
                    ? concludedStreamStatus
                    : statusRx;
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
            } else if (entry.op === "move" || entry.op === "copy") {
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

            const startLine = extractStartLine(attrs, parsedTx, parsedRx);
            const cancellable =
                status === "in_progress" ||
                status === "pending" ||
                ((entry.op === "work" || entry.op === "fork") &&
                    status === "completed" &&
                    typeof attrs.session === "string" &&
                    attrs.session.length > 0);
            const settledStream = typeof attrs.stream === "string" && status !== "in_progress";

            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: coordinate,
                    name: entry.op,
                    title,
                    kind,
                    status,
                    ...(cancellable
                        ? { capabilities: { cancel: {} } }
                        : settledStream
                          ? { capabilities: { cancel: null } }
                          : {}),
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
                            status: effectiveStatusRx,
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
                        capabilities: { cancel: status === "in_progress" ? {} : null },
                        ...(command !== undefined ? { command } : {}),
                        ...(initialOut !== undefined && initialOut.length > 0
                            ? { output: { data: Buffer.from(initialOut, "utf8").toString("base64") } }
                            : {}),
                        ...(status === "completed" || status === "failed"
                            ? { exitStatus: { exitCode: effectiveStatusRx === 200 ? 0 : effectiveStatusRx } }
                            : {}),
                    },
                });
            }

            const trimmedAside = comment === null ? "" : comment.trim();
            if (
                entry.origin === "model" &&
                trimmedAside.length > 0 &&
                !/^(?:fact|idea|plan)$/iu.test(trimmedAside)
            ) {
                const planMeta = {
                    sessionId: entry.session_id,
                    sessionName,
                    coordinate,
                    origin: entry.origin,
                    turnId: entry.turn_id,
                    turnSeq: entry.turn_seq,
                    loopId: entry.loop_id,
                    loopSeq: entry.loop_seq,
                    sequence: entry.sequence,
                };
                const planStatus: "in_progress" | "completed" | "cancelled" =
                    status === "completed"
                        ? "completed"
                        : status === "failed"
                          ? "cancelled"
                          : "in_progress";
                this.#planEntries.set(coordinate, {
                    content: trimmedAside,
                    status: planStatus,
                    turnSeq: isSafeInteger(entry.turn_seq) ? entry.turn_seq : 0,
                });
                if (prunedPlanUpdate !== null) {
                    const idx = updates.indexOf(prunedPlanUpdate);
                    if (idx !== -1) updates.splice(idx, 1);
                }
                updates.push({
                    sessionId: this.#acpSessionId,
                    update: {
                        sessionUpdate: "plan_update",
                        plan: { type: "items", planId: "plan", entries: this.#buildPlanEntries() },
                        _meta: { plurnk: planMeta },
                    },
                });
            }
            return updates;
        }

        // 6. Actionless / ambient row (e.g. rejected emissionAttempt with op === null)
        updates.push({
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "notice",
                severity: statusRx >= 400 ? "warning" : "info",
                title: typeof attrs.kind === "string" && attrs.kind.length > 0 ? attrs.kind : "log:entry",
                ...(text.length > 0 ? { description: text } : {}),
                _meta: {
                    plurnk: {
                        ...opMeta,
                        ...(bodyUrl !== undefined ? { body: { url: bodyUrl } } : {}),
                    },
                },
            },
        });
        return updates;
    }

    reasoning(event: ReasoningEventNotification): AcpSessionUpdate[] {
        if (event.sessionId !== this.#sessionId) return [];
        if (event.phase !== "content" || event.delta.length === 0) return [];
        const messageId = `model-call-${event.modelCallId}/request-${event.requestSequence}/reasoning`;
        this.#streamedReasoningTurns.add(`${event.sessionId}:${event.turnId}`);
        const turnCoordinate = `${event.loopSeq}/${event.turnSeq}`;
        const reasoningUrl =
            this.#origin !== undefined
                ? `${this.#origin}/acp/${this.#workspaceId}/${this.#sessionId}/entry?target=${encodeURIComponent(`reasoning://${this.#sessionName}/${turnCoordinate}`)}`
                : undefined;
        return [{
            sessionId: this.#acpSessionId,
            update: {
                sessionUpdate: "agent_thought_chunk",
                messageId,
                content: { type: "text", text: event.delta },
                _meta: {
                    plurnk: {
                        sessionId: event.sessionId,
                        sessionName: this.#sessionName,
                        loopId: event.loopId,
                        loopSeq: event.loopSeq,
                        turnId: event.turnId,
                        turnSeq: event.turnSeq,
                        coordinate: turnCoordinate,
                        ...(reasoningUrl !== undefined
                            ? { body: { url: reasoningUrl, mimeType: "text/plain" } }
                            : {}),
                    },
                },
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
        const target = typeof meta?.target === "string" && meta.target.length > 0 ? meta.target : null;
        const resultRec = isRecord(meta?.result) ? meta.result : null;
        const exitCode = typeof resultRec?.exitCode === "number" ? resultRec.exitCode : status === 200 ? 0 : status;
        const signal = typeof resultRec?.signal === "string" ? resultRec.signal : undefined;
        this.#concludedStreamStatusByEntryId.set(entryId, status);
        if (target !== null) {
            this.#concludedStreamStatusByTarget.set(target, status);
        }
        const updates: AcpSessionUpdate[] = [
            {
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "terminal_update",
                    terminalId,
                    capabilities: { cancel: null },
                    exitStatus: {
                        exitCode,
                        ...(signal !== undefined ? { signal } : {}),
                    },
                    ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
                },
            },
        ];
        const toolCallId =
            this.#toolCallIdByEntryId.get(entryId) ??
            (target !== null ? this.#toolCallIdByStreamTarget.get(target) : undefined);
        if (toolCallId !== undefined) {
            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: status < 400 ? "completed" : "failed",
                    capabilities: { cancel: null },
                    _meta: {
                        plurnk: {
                            status,
                            ...(target !== null ? { attrs: { stream: target } } : {}),
                        },
                    },
                },
            });
            const existingPlan = this.#planEntries.get(toolCallId);
            if (existingPlan !== undefined) {
                const nextStatus: "completed" | "cancelled" = status < 400 ? "completed" : "cancelled";
                if (existingPlan.status !== nextStatus) {
                    this.#planEntries.set(toolCallId, { ...existingPlan, status: nextStatus });
                    updates.push({
                        sessionId: this.#acpSessionId,
                        update: {
                            sessionUpdate: "plan_update",
                            plan: { type: "items", planId: "plan", entries: this.#buildPlanEntries() },
                            ...(meta !== undefined ? { _meta: { plurnk: meta } } : {}),
                        },
                    });
                }
            }
        }
        return updates;
    }

    notice(notice: Notice): AcpSessionUpdate[] {
        if (notice.source === "engine:emission") {
            return [];
        }
        if (
            (notice.source === "engine:turn" &&
                (notice.kind === "turn_awaiting_model" ||
                    notice.kind === "turn_generated" ||
                    notice.kind === "results_pending")) ||
            (notice.source === "engine:lifecycle" && notice.kind === "loop_status")
        ) {
            return [{
                sessionId: this.#acpSessionId,
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
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "_plurnk_telemetry",
                    _meta: {
                        plurnk: {
                            notice,
                        },
                    },
                },
            }];
        }
        if (notice.source === "engine:configuration") {
            const key = JSON.stringify(notice);
            if (this.#emittedConfigurationNotices.has(key)) return [];
            this.#emittedConfigurationNotices.add(key);
        }
        if (typeof notice.message !== "string" || notice.message.trim().length === 0) {
            return [];
        }
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
                description: notice.message,
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
                sessionUpdate: "agent_thought_chunk",
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

    packet(event: ApplicationLoopPacket, spend?: unknown): AcpSessionUpdate[] {
        if (event.sessionId !== this.#sessionId) return [];
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
        const updates: AcpSessionUpdate[] = [];
        if (this.#planLoopSeq === null || this.#planLoopSeq === event.loopSeq) {
            const pruned = this.#pruneInProgressPlanEntries(undefined, {
                sessionId: event.sessionId,
                sessionName: this.#sessionName,
                loopId: event.loopId,
                loopSeq: event.loopSeq,
            });
            if (pruned !== null) updates.push(pruned);
        }
        updates.push({
            sessionId: this.#acpSessionId,
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
    }

    terminated(event: TerminatedNotification, spend?: unknown, inbox?: unknown): AcpSessionUpdate[] {
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
                loopId: event.loopId,
                loopSeq: event.loopSeq,
                ...(spend !== undefined || inbox !== undefined
                    ? {
                          status: {
                              ...(spend !== undefined ? { spend } : {}),
                              ...(inbox !== undefined ? { inbox } : {}),
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

        const updates: AcpSessionUpdate[] = [];
        if (this.#planLoopSeq === null || this.#planLoopSeq === event.loopSeq) {
            const pruned = this.#pruneInProgressPlanEntries(undefined, {
                sessionId: event.sessionId,
                sessionName: this.#sessionName,
                loopId: event.loopId,
                loopSeq: event.loopSeq,
            });
            if (pruned !== null) updates.push(pruned);
        }
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
            readonly historyPageChars?: number;
            readonly beforeLoopSeq?: number;
            readonly afterLoopSeq?: number;
            readonly exactLoopSeq?: number;
            readonly openStreamTargets?: ReadonlySet<string>;
            readonly subject?: string | null;
        } = {},
    ): ReplayResult {
        translator.#streamedReasoningTurns.clear();
        translator.#planLoopSeq = null;
        translator.#planTurnSeq = null;
        translator.#planEntries.clear();
        return replaySessionHistory(translator, rows, inbox, options);
    }
}

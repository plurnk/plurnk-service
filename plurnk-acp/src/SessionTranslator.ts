// {§acp-plurnk-metadata} {§acp-history-window} Pure standard ACP v2 projection from daemon events onto ACP v2 SessionUpdate notifications.

import type {
    SessionUpdate,
    ToolCallContent,
    ToolCallStatus,
    ToolKind,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    addressOf,
    isRecord,
    isSafeInteger,
    type ApplicationInboxMessage,
    type ApplicationLoopPacket,
    type LogEntryNotification,
    type LogEntryWire,
    type Notice,
    type OutsideEventNotification,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
import { buildUnifiedDiff } from "./diff.ts";

export interface AcpSessionUpdate {
    readonly sessionId: string;
    readonly update: SessionUpdate;
}

interface ReplayHistoryLinks {
    readonly older?: string;
    readonly newer?: string;
}

type ReplayResult = AcpSessionUpdate[] & {
    readonly updates: AcpSessionUpdate[];
    readonly history: ReplayHistoryLinks;
};

const MODEL_FACTS: ReadonlySet<string> = new Set(["lineAnchors", "lineAnchorIdentity", "lineNumberWidth"]);

export const terminalIdForEntry = (logEntryId: number): string => `term:${logEntryId}`;

const extractMessageId = (source: string | null, sessionId: string): string | null => {
    if (typeof source !== "string" || source.length === 0) return null;
    try {
        const url = new URL(source);
        if (url.protocol !== "acp:") return null;
        const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (segments.length === 4 && segments[0] === "sessions" && segments[2] === "messages") {
            return segments[1] === sessionId ? segments[3] ?? null : null;
        }
        return null;
    } catch {
        return null;
    }
};

export default class SessionTranslator {
    readonly #acpSessionId: string;
    readonly #workspaceId: number;
    readonly #sessionId: number;
    readonly #origin: string | undefined;
    readonly #streamedReasoningTurns = new Set<string>();
    readonly #toolCallIdByEntryId = new Map<number, string>();

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

    static #invocationCoordinate(ref: string | undefined): string | null {
        if (typeof ref !== "string" || ref.length === 0) return null;
        const match = /^log:\/\/\/(\d+\/\d+\/\d+)(?:\/|$)/u.exec(ref);
        return match?.[1] ?? ref;
    }

    static toolKindOf(op: string | null, scheme: string | null): ToolKind {
        switch (op) {
            case "READ":
                return scheme === "http" || scheme === "https" ? "fetch" : "read";
            case "EDIT":
            case "COPY":
                return "edit";
            case "MOVE":
                return "move";
            case "KILL":
                return "delete";
            case "FIND":
                return "search";
            case "NOTE":
            case "WAIT":
                return "think";
            case "SEND":
                return "other";
            case "WORK":
            case "FORK":
            case "EXEC":
                return "execute";
            default:
                return op === null ? "other" : "execute";
        }
    }

    static #statusOf(row: { readonly status_rx?: unknown }): number {
        return typeof row.status_rx === "number" ? row.status_rx : 200;
    }

    static toolStatusOf(row: { readonly state?: unknown; readonly status_rx?: unknown; readonly attrs?: unknown }): ToolCallStatus {
        if (row.state === "proposed") return "pending";
        const statusRx = SessionTranslator.#statusOf(row);
        if (row.state === "failed" || row.state === "cancelled" || statusRx >= 400) {
            return "failed";
        }
        const attrs = SessionTranslator.#attrRecord(row.attrs);
        if (statusRx < 400 && (typeof attrs.stream === "string" || typeof attrs.message === "string" || statusRx === 202)) {
            return "in_progress";
        }
        return "completed";
    }

    static #parsed(value: unknown): unknown {
        if (value === undefined || value === "") return null;
        if (typeof value !== "string") return value;
        try {
            return JSON.parse(value) as unknown;
        } catch {
            return value;
        }
    }

    static #txBody(tx: unknown, attrs?: Readonly<Record<string, unknown>>, parsedRx?: unknown): string {
        const parsed = SessionTranslator.#parsed(tx);
        if (typeof parsed === "string") return parsed;
        if (isRecord(parsed)) {
            if (typeof parsed.body === "string") return parsed.body;
            if (isRecord(parsed.body)) {
                if (typeof parsed.body.raw === "string") return parsed.body.raw;
                if (parsed.body.json !== undefined) return JSON.stringify(parsed.body.json);
            }
        }
        if (attrs !== undefined) {
            if (typeof attrs.body === "string") return attrs.body;
            if (typeof attrs.content === "string") return attrs.content;
        }
        if (isRecord(parsedRx) && typeof parsedRx.content === "string") {
            return parsedRx.content;
        }
        return "";
    }

    static #attrRecord(attrs: unknown): Readonly<Record<string, unknown>> {
        const parsed = SessionTranslator.#parsed(attrs);
        return isRecord(parsed) ? parsed : {};
    }

    static #cleanReceipt(rx: unknown): {
        readonly receipt: unknown;
        readonly contentBlocks: ToolCallContent[];
    } {
        const parsed = SessionTranslator.#parsed(rx);
        if (!isRecord(parsed)) {
            const text = typeof rx === "string" ? rx : rx == null ? "" : JSON.stringify(rx);
            return {
                receipt: parsed,
                contentBlocks: text.length > 0 ? [{ type: "content", content: { type: "text", text } }] : [],
            };
        }
        const rawContent = typeof parsed.content === "string" && parsed.content.length > 0 ? parsed.content : null;
        const kept = Object.entries(parsed).filter(([key]) => !MODEL_FACTS.has(key));
        const receipt = Object.fromEntries(kept);
        const contentBlocks: ToolCallContent[] = [];
        if (rawContent !== null) {
            contentBlocks.push({
                type: "content",
                content: { type: "text", text: rawContent },
            });
        } else if (isRecord(parsed.problem) && typeof parsed.problem.detail === "string") {
            contentBlocks.push({
                type: "content",
                content: { type: "text", text: parsed.problem.detail },
            });
        }
        return { receipt, contentBlocks };
    }

    static #isResponseMessage(
        entry: LogEntryWire,
        parsedRx: unknown,
        attrs: Readonly<Record<string, unknown>>,
        text: string,
        sessionId: string,
    ): boolean {
        if ("inherited_history" in entry && entry.inherited_history === 1) return false;
        if (entry.op !== "SEND" && entry.op !== "KILL") return false;
        const statusRx = SessionTranslator.#statusOf(entry);
        if (statusRx < 200 || statusRx >= 300) return false;
        if (text.trim().length === 0) return false;
        const deliveredReply = attrs.kind === "reply";
        if (entry.origin !== "model" && !deliveredReply) return false;
        if (deliveredReply) {
            return isRecord(parsedRx)
                && Array.isArray(parsedRx.answers)
                && parsedRx.answers.some((addr) => extractMessageId(typeof addr === "string" ? addr : null, sessionId) !== null);
        }
        if (entry.scheme === "session" || entry.scheme === "workspace") return false;
        if (typeof attrs.to === "string" && (attrs.to.startsWith("session://") || attrs.to.startsWith("workspace://"))) return false;
        if (isRecord(parsedRx) && Array.isArray(parsedRx.answers)) return true;
        if (attrs.kind === "response" || attrs.kind === "message") return true;
        if (entry.op === "SEND" && (entry.scheme === null || entry.scheme === undefined || entry.scheme === "acp") && !entry.pathname) return true;
        return false;
    }

    logEntry({ entry }: LogEntryNotification): AcpSessionUpdate[] {
        if (entry.session_id !== this.#sessionId) return [];

        const updates: AcpSessionUpdate[] = [];
        const coordinate = SessionTranslator.coordinateOf(entry);
        const attrs = SessionTranslator.#attrRecord(entry.attrs);
        const parsedTx = SessionTranslator.#parsed(entry.tx);
        const parsedRx = SessionTranslator.#parsed(entry.rx);
        const text = SessionTranslator.#txBody(parsedTx, attrs, parsedRx);
        const { receipt, contentBlocks } = SessionTranslator.#cleanReceipt(entry.rx);
        const rawAddress = addressOf(entry);
        const address = rawAddress ?? (typeof attrs.path === "string" ? attrs.path : null);
        const statusRx = SessionTranslator.#statusOf(entry);

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
        const isResponse = SessionTranslator.#isResponseMessage(entry, parsedRx, attrs, text, this.#acpSessionId);
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
        const targetCallId = SessionTranslator.#invocationCoordinate(rawInvocation);
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
                    changes: [{ operation: "modify", path }],
                    patch: {
                        format: "git_patch",
                        text: attrs.patch,
                    },
                });
            } else if (typeof attrs.original === "string" && typeof attrs.patched === "string") {
                const path = address ?? entry.pathname ?? "";
                content.push({
                    type: "diff",
                    changes: [{ operation: "modify", path }],
                    patch: {
                        format: "git_patch",
                        text: buildUnifiedDiff(path, attrs.original, attrs.patched),
                    },
                });
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

            updates.push({
                sessionId: this.#acpSessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: coordinate,
                    name: entry.op,
                    title,
                    kind,
                    status,
                    ...(address === null ? {} : { locations: [{ path: address }] }),
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
        const activeRows = rows
            .filter((row) => !("inherited_history" in row && row.inherited_history === 1))
            .toSorted(
                (a, b) =>
                    (a.loop_seq - b.loop_seq) ||
                    (a.turn_seq - b.turn_seq) ||
                    (a.sequence - b.sequence) ||
                    (a.id - b.id),
            );
        const allLoopSeqs = [...new Set(activeRows.map((r) => r.loop_seq).filter(isSafeInteger))].toSorted((a, b) => a - b);

        let candidateSeqs = allLoopSeqs;
        if (typeof options.exactLoopSeq === "number") {
            candidateSeqs = allLoopSeqs.filter((seq) => seq === options.exactLoopSeq);
        } else if (typeof options.beforeLoopSeq === "number") {
            candidateSeqs = allLoopSeqs.filter((seq) => seq < options.beforeLoopSeq!);
        }

        const selectedLoops =
            typeof options.exactLoopSeq !== "number" &&
            typeof options.historyLoops === "number" &&
            options.historyLoops > 0 &&
            candidateSeqs.length > options.historyLoops
                ? new Set(candidateSeqs.slice(-options.historyLoops))
                : new Set(candidateSeqs);

        const updates: AcpSessionUpdate[] = [];
        for (let i = 0; i < activeRows.length; i += 1) {
            const row = activeRows[i];
            if (!selectedLoops.has(row.loop_seq)) continue;
            updates.push(...translator.logEntry({ entry: row }));
            const attrs = SessionTranslator.#attrRecord(row.attrs);
            if (typeof attrs.stream === "string") {
                const streamEnded = activeRows
                    .slice(i + 1)
                    .some(
                        (later) =>
                            addressOf(later) === attrs.stream ||
                            later.loop_seq > row.loop_seq ||
                            (later.loop_seq === row.loop_seq && later.turn_seq > row.turn_seq),
                    );
                if (streamEnded) {
                    updates.push(
                        ...translator.terminalConcluded(row.id, SessionTranslator.#statusOf(row)),
                    );
                }
            }
        }

        if (options.beforeLoopSeq === undefined && options.exactLoopSeq === undefined) {
            for (const msg of inbox) {
                const messageId = extractMessageId(msg.source ?? msg.path, translator.#acpSessionId) ?? msg.path;
                updates.push({
                    sessionId: translator.#acpSessionId,
                    update: {
                        sessionUpdate: "user_message_chunk",
                        messageId,
                        content: { type: "text", text: msg.body },
                    },
                });
            }
        }

        const selectedSorted = [...selectedLoops].toSorted((a, b) => a - b);
        const oldestSelected = selectedSorted[0];
        const newestSelected = selectedSorted.at(-1);
        const hasOlder = oldestSelected !== undefined && allLoopSeqs.some((seq) => seq < oldestSelected);
        const hasNewer = newestSelected !== undefined && allLoopSeqs.some((seq) => seq > newestSelected);

        const baseOrigin = translator.#origin ?? "http://127.0.0.1";
        const messagesBase = `${baseOrigin}/acp/${translator.#workspaceId}/${translator.#sessionId}/messages?session=${encodeURIComponent(translator.#acpSessionId)}`;
        const history: ReplayHistoryLinks = {
            ...(hasOlder && oldestSelected !== undefined ? { older: `${messagesBase}&before=${oldestSelected}` } : {}),
            ...(hasNewer && newestSelected !== undefined ? { newer: `${messagesBase}&after=${newestSelected}` } : {}),
        };

        return Object.assign(updates, { updates, history });
    }
}

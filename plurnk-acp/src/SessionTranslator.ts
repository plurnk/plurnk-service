// Pure standard ACP v2 projection from daemon events onto ACP v2 SessionUpdate notifications,
// RequestPermissionRequest, and CreateElicitationRequest.

import type {
    CreateElicitationRequest,
    ElicitationSchema,
    RequestPermissionRequest,
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
    type ClientInteractionProjection,
    type ClientInteractionResolution,
    type LogEntryNotification,
    type LogEntryWire,
    type Notice,
    type OutsideEventNotification,
    type ProposalProjection,
    type ProposalResolution,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";

export interface AcpSessionUpdate {
    readonly sessionId: string;
    readonly update: SessionUpdate;
}

export interface ReplayHistoryLinks {
    readonly older?: string;
    readonly newer?: string;
}

export type ReplayResult = AcpSessionUpdate[] & {
    readonly updates: AcpSessionUpdate[];
    readonly history: ReplayHistoryLinks;
};

export interface Resolution extends ProposalResolution {
    readonly logEntryId: number;
}

export interface InteractionResolution {
    readonly interactionId: number;
    readonly resolution: ClientInteractionResolution;
}

const MODEL_FACTS: ReadonlySet<string> = new Set(["lineAnchors", "lineAnchorIdentity", "lineNumberWidth"]);

export const proposalKey = (logEntryId: number): string => `proposal:${logEntryId}`;
export const logEntryIdFromKey = (key: string): number | null => {
    const m = /^proposal:(\d+)$/u.exec(key);
    return m === null ? null : Number(m[1]);
};

export const interactionToolCallId = (interactionId: number): string => `int:${interactionId}`;
export const interactionIdFromToolCallId = (toolCallId: string): number | null => {
    const m = /^int:(\d+)$/u.exec(toolCallId);
    return m === null ? null : Number(m[1]);
};

export const terminalIdForEntry = (logEntryId: number): string => `term:${logEntryId}`;

const buildUnifiedDiff = (filePath: string, oldText: string, newText: string): string => {
    const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
    const newLines = newText.length === 0 ? [] : newText.split("\n");
    const header = [
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ];
    const removed = oldLines.map((line) => `-${line}`);
    const added = newLines.map((line) => `+${line}`);
    return [...header, ...removed, ...added].join("\n");
};

export const proposalToolCall = (
    proposal: ProposalProjection,
): Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }> => {
    const attrs = isRecord(proposal.attrs) ? proposal.attrs : {};
    const target =
        proposal.target?.pathname ??
        proposal.target?.scheme ??
        (typeof attrs.path === "string" ? attrs.path : null);
    const title = target === null ? proposal.op : `${proposal.op} (${target})`;
    const content: ToolCallContent[] = [];
    if (typeof attrs.original === "string" && typeof attrs.patched === "string") {
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
        kind: SessionTranslator.toolKindOf(proposal.op, proposal.target?.scheme ?? null),
        status: "pending",
        ...(target !== null ? { locations: [{ path: target }] } : {}),
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

export const proposalPermissionRequest = (
    sessionId: string,
    proposal: ProposalProjection,
): RequestPermissionRequest => {
    const attrs = isRecord(proposal.attrs) ? proposal.attrs : {};
    const target =
        proposal.target?.pathname ??
        proposal.target?.scheme ??
        (typeof attrs.path === "string" ? attrs.path : null);
    const title = target === null ? proposal.op : `${proposal.op} (${target})`;
    const isCommand =
        proposal.op === "EXEC" ||
        proposal.target?.scheme === "sh" ||
        attrs.tag === "sh" ||
        typeof attrs.command === "string";

    const commandText =
        typeof attrs.command === "string"
            ? attrs.command
            : typeof proposal.body === "string"
                ? proposal.body
                : typeof attrs.body === "string"
                    ? attrs.body
                    : proposal.op;
    const cwd = typeof attrs.cwd === "string" ? attrs.cwd : "/";

    if (isCommand) {
        return {
            sessionId,
            title,
            description: "Review the requested command.",
            subject: {
                type: "command",
                command: commandText,
                cwd,
            },
            options: [
                { optionId: "approve", name: "Accept", kind: "allow_once" },
                { optionId: "accept", name: "Allow always", kind: "allow_always" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
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
        title,
        description: "Review the requested action.",
        subject: {
            type: "tool_call",
            toolCall: toolCallFields,
        },
        options: [
            { optionId: "approve", name: "Accept", kind: "allow_once" },
            { optionId: "accept", name: "Allow always", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        _meta: {
            plurnk: {
                proposal,
            },
        },
    };
};

export const resolutionFromPermissionResponse = (
    keyOrLogEntryId: string | number,
    response: unknown,
): Resolution | null => {
    const logEntryId = typeof keyOrLogEntryId === "number"
        ? keyOrLogEntryId
        : logEntryIdFromKey(keyOrLogEntryId);
    if (logEntryId === null || !Number.isSafeInteger(logEntryId) || logEntryId <= 0) return null;
    if (!isRecord(response)) return null;

    if (isRecord(response.outcome)) {
        const kind = response.outcome.outcome;
        if (kind === "cancelled") {
            return { logEntryId, decision: "cancel" };
        }
        if (kind === "selected") {
            const optionId = response.outcome.optionId;
            if (optionId === "approve" || optionId === "accept") {
                return { logEntryId, decision: "accept" };
            }
            if (optionId === "deny" || optionId === "reject") {
                return { logEntryId, decision: "reject" };
            }
            if (optionId === "cancel") {
                return { logEntryId, decision: "cancel" };
            }
            return null;
        }
    }
    return null;
};

export const interactionToolCall = (interaction: ClientInteractionProjection): SessionUpdate => {
    const reqRecord: Record<string, unknown> = isRecord(interaction.request)
        ? interaction.request
        : {};
    const interRec: Record<string, unknown> = isRecord(interaction) ? interaction : {};
    const toolName =
        typeof reqRecord.toolName === "string"
            ? reqRecord.toolName
            : typeof interRec.kind === "string"
                ? interRec.kind
                : "elicitation";
    const title = typeof reqRecord.title === "string" ? reqRecord.title : toolName;
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: interactionToolCallId(interaction.interactionId),
        name: toolName,
        title,
        kind: "other",
        status: "in_progress",
        rawInput: reqRecord.arguments ?? reqRecord,
        _meta: {
            plurnk: {
                interaction,
            },
        },
    };
};

export const interactionToolCallResult = (
    interactionId: number,
    resolution: ClientInteractionResolution,
): SessionUpdate => ({
    sessionUpdate: "tool_call_update",
    toolCallId: interactionToolCallId(interactionId),
    status: resolution.status === "cancelled" ? "failed" : "completed",
    rawOutput: resolution,
    content: [{ type: "content", content: { type: "text", text: JSON.stringify(resolution) } }],
});

export const interactionElicitationRequest = (
    sessionId: string,
    interaction: ClientInteractionProjection,
): CreateElicitationRequest => {
    const reqRecord: Record<string, unknown> = isRecord(interaction.request)
        ? interaction.request
        : {};
    const rawSchema = isRecord(reqRecord.responseSchema)
        ? reqRecord.responseSchema
        : isRecord(reqRecord.schema)
            ? reqRecord.schema
            : null;
    const schema = rawSchema !== null && rawSchema.type === "object"
        ? { properties: {}, ...rawSchema }
        : {
            type: "object",
            properties: {
                value: rawSchema ?? { type: "string" },
            },
        };
    return {
        scope: "session",
        sessionId,
        toolCallId: interactionToolCallId(interaction.interactionId),
        mode: "form",
        message: typeof reqRecord.message === "string" ? reqRecord.message : "Provide the requested input.",
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        requestedSchema: schema as unknown as ElicitationSchema,
        _meta: {
            plurnk: {
                interaction,
            },
        },
    };
};

export const interactionResolutionFromResponse = (
    keyOrInteractionId: string | number,
    response: unknown,
): InteractionResolution | null => {
    const interactionId = typeof keyOrInteractionId === "number"
        ? keyOrInteractionId
        : interactionIdFromToolCallId(keyOrInteractionId);
    if (interactionId === null || !Number.isSafeInteger(interactionId) || interactionId <= 0) return null;
    if (!isRecord(response)) return null;

    if (response.action === "cancel" || response.action === "decline") {
        return { interactionId, resolution: { status: "cancelled" } };
    }
    if (response.action === "accept") {
        const metaPayload = isRecord(response._meta) && isRecord(response._meta.plurnk)
            ? response._meta.plurnk.payload
            : undefined;
        const payload = metaPayload !== undefined ? metaPayload : response.content;
        return {
            interactionId,
            resolution: {
                status: "resolved",
                ...(payload !== undefined ? { payload } : {}),
            },
        };
    }
    return null;
};

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
    readonly #sessionId: string;
    readonly #workspaceId: number;
    readonly #workerId: number;
    readonly #origin: string | undefined;
    readonly #streamedReasoningTurns = new Set<string>();
    readonly #toolCallIdByEntryId = new Map<number, string>();

    constructor(args: {
        readonly sessionId: string;
        readonly workspaceId: number;
        readonly workerId: number;
        readonly origin?: string;
    }) {
        this.#sessionId = args.sessionId;
        this.#workspaceId = args.workspaceId;
        this.#workerId = args.workerId;
        this.#origin = args.origin;
    }

    get sessionId(): string {
        return this.#sessionId;
    }

    get workspaceId(): number {
        return this.#workspaceId;
    }

    get workerId(): number {
        return this.#workerId;
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

    static #statusOf(row: { readonly status_rx?: unknown; readonly status?: unknown }): number {
        if (typeof row.status_rx === "number") return row.status_rx;
        if (typeof row.status === "number") return row.status;
        return 200;
    }

    static toolStatusOf(row: { readonly state?: unknown; readonly status_rx?: unknown; readonly status?: unknown; readonly attrs?: unknown }): ToolCallStatus {
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
        if (entry.scheme === "worker") return false;
        if (typeof attrs.to === "string" && attrs.to.startsWith("worker://")) return false;
        if (isRecord(parsedRx) && Array.isArray(parsedRx.answers)) return true;
        if (attrs.kind === "response" || attrs.kind === "message") return true;
        if (entry.op === "SEND" && (entry.scheme === null || entry.scheme === undefined || entry.scheme === "acp") && !entry.pathname) return true;
        return false;
    }

    logEntry({ entry }: LogEntryNotification): AcpSessionUpdate[] {
        if (entry.worker_id !== this.#workerId) return [];

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

        const reasoningTurnKey = `${entry.worker_id}:${entry.turn_id}`;
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
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: thoughtMessageId,
                    content: { type: "text", text: entry.reasoning },
                },
            });
        }

        // 1. Agent response message
        const isResponse = SessionTranslator.#isResponseMessage(entry, parsedRx, attrs, text, this.#sessionId);
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
        };
        if (isResponse || isBodiedWait) {
            updates.push({
                sessionId: this.#sessionId,
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
                sessionId: this.#sessionId,
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
            const messageId = extractMessageId(entry.source, this.#sessionId) ?? coordinate;
            updates.push({
                sessionId: this.#sessionId,
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
                    sessionId: this.#sessionId,
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

            if (typeof attrs.original === "string" && typeof attrs.patched === "string") {
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

            const comment = isRecord(parsedTx) && typeof parsedTx.comment === "string" && parsedTx.comment.length > 0
                ? parsedTx.comment
                : typeof attrs.comment === "string" && attrs.comment.length > 0
                    ? attrs.comment
                    : null;
            const baseTitle = address === null ? entry.op : `${entry.op} (${address})`;
            const title = comment === null ? baseTitle : `${baseTitle} — ${comment}`;
            const bodyUrl = this.#origin !== undefined
                ? `${this.#origin}/acp/${this.#workspaceId}/${this.#workerId}/entry?target=${encodeURIComponent(`log:///${coordinate}/${entry.op}`)}`
                : undefined;

            updates.push({
                sessionId: this.#sessionId,
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
                    sessionId: this.#sessionId,
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

    reasoning(event: ReasoningEventNotification | Record<string, unknown>): AcpSessionUpdate[] {
        const rec = event as Record<string, unknown>;
        if (rec.workerId !== this.#workerId) return [];
        const phase = typeof rec.phase === "string" ? rec.phase : "content";
        const delta = typeof rec.delta === "string" ? rec.delta : "";
        if (phase !== "content" || delta.length === 0) return [];
        const callId = typeof rec.modelCallId === "number" || typeof rec.modelCallId === "string"
            ? rec.modelCallId
            : typeof rec.callId === "number" || typeof rec.callId === "string"
                ? rec.callId
                : 1;
        const reqSeq = typeof rec.requestSequence === "number" || typeof rec.requestSequence === "string"
            ? rec.requestSequence
            : typeof rec.requestSeq === "number" || typeof rec.requestSeq === "string"
                ? rec.requestSeq
                : 1;
        const messageId = `model-call-${callId}/request-${reqSeq}/reasoning`;
        if (typeof rec.turnId === "number" || typeof rec.turnId === "string") {
            const wId = typeof rec.workerId === "number" || typeof rec.workerId === "string" ? rec.workerId : this.#workerId;
            this.#streamedReasoningTurns.add(`${wId}:${rec.turnId}`);
        }
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "agent_thought_chunk",
                messageId,
                content: { type: "text", text: delta },
            },
        }];
    }

    terminalChunk(entryId: number, text: string, meta?: Record<string, unknown>): AcpSessionUpdate[] {
        if (text.length === 0) return [];
        return [{
            sessionId: this.#sessionId,
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
                sessionId: this.#sessionId,
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
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: status < 400 ? "completed" : "failed",
                },
            });
        }
        return updates;
    }

    notice(notice: Notice | Record<string, unknown>): AcpSessionUpdate[] {
        const rec = notice as Record<string, unknown>;
        const severity = rec.level === "error"
            ? "error"
            : rec.level === "warn"
                ? "warning"
                : "info";
        const source = typeof rec.source === "string" ? rec.source : "daemon";
        const kind = typeof rec.kind === "string"
            ? rec.kind
            : typeof rec.code === "string"
                ? rec.code
                : "notice";
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "notice",
                severity,
                title: `${source}:${kind}`,
                description: typeof rec.message === "string" ? rec.message : undefined,
                _meta: {
                    plurnk: {
                        notice: rec,
                    },
                },
            },
        }];
    }

    outside(event: OutsideEventNotification): AcpSessionUpdate[] {
        if (event.workerId !== this.#workerId) return [];
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "agent_message_chunk",
                messageId: `outside-${event.coordinate}`,
                content: { type: "text", text: event.text },
            },
        }];
    }

    packet(event: ApplicationLoopPacket): AcpSessionUpdate[] {
        if (event.workerId !== this.#workerId) return [];
        return [{
            sessionId: this.#sessionId,
            update: {
                sessionUpdate: "usage_update",
                used: event.gauge.contextTokens ?? event.gauge.curationWeight ?? 0,
                size: event.gauge.contextCapacity ?? event.gauge.curationBudget ?? 0,
            },
        }];
    }

    terminated(event: TerminatedNotification | Record<string, unknown>): AcpSessionUpdate[] {
        const rec: Record<string, unknown> = isRecord(event) ? event : {};
        if (rec.workerId !== this.#workerId) return [];
        const usageObj = isRecord(rec.usage) ? rec.usage : {};
        const accounting = isRecord(usageObj.accounting) ? usageObj.accounting : {};
        const costUsd = accounting.costUsd ?? (typeof accounting.knownCostUsd === "string" || typeof accounting.knownCostUsd === "number" ? accounting.knownCostUsd : null);
        const cost = costUsd !== null && costUsd !== undefined && costUsd !== false
            ? { amount: Number(costUsd), currency: "USD" }
            : undefined;
        const providerUsage = isRecord(accounting.usage)
            ? accounting.usage
            : isRecord(accounting.knownUsage)
                ? accounting.knownUsage
                : null;
        const inputTokens = typeof providerUsage?.inputTokens === "number" ? providerUsage.inputTokens : 0;
        const outputTokens = typeof providerUsage?.outputTokens === "number" ? providerUsage.outputTokens : 0;
        const totalTokens = typeof providerUsage?.totalTokens === "number"
            ? providerUsage.totalTokens
            : (inputTokens + outputTokens);
        const outputDetails = isRecord(providerUsage?.outputTokenDetails) ? providerUsage.outputTokenDetails : null;
        const inputDetails = isRecord(providerUsage?.inputTokenDetails) ? providerUsage.inputTokenDetails : null;
        const reasoningTokens = typeof outputDetails?.reasoningTokens === "number" ? outputDetails.reasoningTokens : null;
        const cacheReadTokens = typeof inputDetails?.cacheReadTokens === "number" ? inputDetails.cacheReadTokens : null;
        const cacheWriteTokens = typeof inputDetails?.cacheWriteTokens === "number" ? inputDetails.cacheWriteTokens : null;
        const usage = {
            totalTokens,
            inputTokens,
            outputTokens,
            ...(reasoningTokens === null ? {} : { thoughtTokens: reasoningTokens }),
            ...(cacheReadTokens === null ? {} : { cachedReadTokens: cacheReadTokens }),
            ...(cacheWriteTokens === null ? {} : { cachedWriteTokens: cacheWriteTokens }),
        };

        const resultRec = isRecord(rec.result) ? rec.result : {};
        const status = typeof resultRec.status === "number"
            ? resultRec.status
            : typeof rec.status === "number"
                ? rec.status
                : 200;
        const hitMaxTurns = rec.hitMaxTurns === true;

        const turnIds = Array.isArray(rec.turnIds) ? rec.turnIds : null;
        const turnCount = typeof rec.turnCount === "number"
            ? rec.turnCount
            : typeof rec.turns === "number"
                ? rec.turns
                : turnIds !== null
                    ? turnIds.length
                    : undefined;
        const problem = isRecord(rec.problem)
            ? rec.problem
            : isRecord(resultRec.problem)
                ? resultRec.problem
                : null;
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

        const used = typeof usageObj.contextTokens === "number"
            ? usageObj.contextTokens
            : typeof usageObj.curationWeight === "number"
                ? usageObj.curationWeight
                : totalTokens;
        const size = typeof usageObj.contextCapacity === "number"
            ? usageObj.contextCapacity
            : typeof usageObj.curationBudget === "number"
                ? usageObj.curationBudget
                : 128000;

        const updates: AcpSessionUpdate[] = [];
        if (problem !== null) {
            updates.push({
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "error",
                    title: typeof problem.title === "string" ? problem.title : "Loop Error",
                    description: typeof problem.detail === "string" ? problem.detail : undefined,
                },
            });
        }
        updates.push(
            {
                sessionId: this.#sessionId,
                update: {
                    sessionUpdate: "usage_update",
                    used,
                    size,
                    ...(cost === undefined ? {} : { cost }),
                },
            },
            {
                sessionId: this.#sessionId,
                update: idleUpdate,
            },
        );
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
        const activeRows = rows.filter((row) => !("inherited_history" in row && row.inherited_history === 1));
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
        for (const row of activeRows) {
            if (!selectedLoops.has(row.loop_seq)) continue;
            updates.push(...translator.logEntry({ entry: row }));
        }

        if (options.beforeLoopSeq === undefined && options.exactLoopSeq === undefined) {
            for (const msg of inbox) {
                const messageId = extractMessageId(msg.source ?? msg.path, translator.#sessionId) ?? msg.path;
                updates.push({
                    sessionId: translator.#sessionId,
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
        const messagesBase = `${baseOrigin}/acp/${translator.#workspaceId}/${translator.#workerId}/messages?session=${encodeURIComponent(translator.#sessionId)}`;
        const history: ReplayHistoryLinks = {
            ...(hasOlder && oldestSelected !== undefined ? { older: `${messagesBase}&before=${oldestSelected}` } : {}),
            ...(hasNewer && newestSelected !== undefined ? { newer: `${messagesBase}&after=${newestSelected}` } : {}),
        };

        return Object.assign(updates, { updates, history });
    }
}

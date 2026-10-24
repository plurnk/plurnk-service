import {
    isLogEntryNotification,
    isRecord,
    type LogEntryNotification,
    type OutsideEventNotification,
    type ProposalNotification,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";

export {
    isLogEntryNotification,
    type LogEntryNotification,
    type OutsideEventNotification,
    type ProposalNotification,
    type ReasoningEventNotification,
    type TerminatedNotification,
};

export const EventType = {
    TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
    TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
    TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
    TEXT_MESSAGE_CHUNK: "TEXT_MESSAGE_CHUNK",
    TOOL_CALL_START: "TOOL_CALL_START",
    TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
    TOOL_CALL_END: "TOOL_CALL_END",
    TOOL_CALL_CHUNK: "TOOL_CALL_CHUNK",
    TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
    STATE_SNAPSHOT: "STATE_SNAPSHOT",
    STATE_DELTA: "STATE_DELTA",
    MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
    ACTIVITY_SNAPSHOT: "ACTIVITY_SNAPSHOT",
    ACTIVITY_DELTA: "ACTIVITY_DELTA",
    RAW: "RAW",
    CUSTOM: "CUSTOM",
    RUN_STARTED: "RUN_STARTED",
    RUN_FINISHED: "RUN_FINISHED",
    RUN_ERROR: "RUN_ERROR",
    STEP_STARTED: "STEP_STARTED",
    STEP_FINISHED: "STEP_FINISHED",
    REASONING_START: "REASONING_START",
    REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
    REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
    REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
    REASONING_MESSAGE_CHUNK: "REASONING_MESSAGE_CHUNK",
    REASONING_END: "REASONING_END",
    REASONING_ENCRYPTED_VALUE: "REASONING_ENCRYPTED_VALUE",
    SUBAGENT_STARTED: "SUBAGENT_STARTED",
    SUBAGENT_FINISHED: "SUBAGENT_FINISHED",
    SUBAGENT_ERROR: "SUBAGENT_ERROR",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export declare namespace EventType {
    export type TEXT_MESSAGE_START = typeof EventType.TEXT_MESSAGE_START;
    export type TEXT_MESSAGE_CONTENT = typeof EventType.TEXT_MESSAGE_CONTENT;
    export type TEXT_MESSAGE_END = typeof EventType.TEXT_MESSAGE_END;
    export type TEXT_MESSAGE_CHUNK = typeof EventType.TEXT_MESSAGE_CHUNK;
    export type TOOL_CALL_START = typeof EventType.TOOL_CALL_START;
    export type TOOL_CALL_ARGS = typeof EventType.TOOL_CALL_ARGS;
    export type TOOL_CALL_END = typeof EventType.TOOL_CALL_END;
    export type TOOL_CALL_CHUNK = typeof EventType.TOOL_CALL_CHUNK;
    export type TOOL_CALL_RESULT = typeof EventType.TOOL_CALL_RESULT;
    export type STATE_SNAPSHOT = typeof EventType.STATE_SNAPSHOT;
    export type STATE_DELTA = typeof EventType.STATE_DELTA;
    export type MESSAGES_SNAPSHOT = typeof EventType.MESSAGES_SNAPSHOT;
    export type ACTIVITY_SNAPSHOT = typeof EventType.ACTIVITY_SNAPSHOT;
    export type ACTIVITY_DELTA = typeof EventType.ACTIVITY_DELTA;
    export type RAW = typeof EventType.RAW;
    export type CUSTOM = typeof EventType.CUSTOM;
    export type RUN_STARTED = typeof EventType.RUN_STARTED;
    export type RUN_FINISHED = typeof EventType.RUN_FINISHED;
    export type RUN_ERROR = typeof EventType.RUN_ERROR;
    export type STEP_STARTED = typeof EventType.STEP_STARTED;
    export type STEP_FINISHED = typeof EventType.STEP_FINISHED;
    export type REASONING_START = typeof EventType.REASONING_START;
    export type REASONING_MESSAGE_START = typeof EventType.REASONING_MESSAGE_START;
    export type REASONING_MESSAGE_CONTENT = typeof EventType.REASONING_MESSAGE_CONTENT;
    export type REASONING_MESSAGE_END = typeof EventType.REASONING_MESSAGE_END;
    export type REASONING_MESSAGE_CHUNK = typeof EventType.REASONING_MESSAGE_CHUNK;
    export type REASONING_END = typeof EventType.REASONING_END;
    export type REASONING_ENCRYPTED_VALUE = typeof EventType.REASONING_ENCRYPTED_VALUE;
    export type SUBAGENT_STARTED = typeof EventType.SUBAGENT_STARTED;
    export type SUBAGENT_FINISHED = typeof EventType.SUBAGENT_FINISHED;
    export type SUBAGENT_ERROR = typeof EventType.SUBAGENT_ERROR;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Metadata = Record<string, any>;
export type SubagentRunId = string;
export type TextMessageRole = "developer" | "system" | "assistant" | "user";
export type Role = "developer" | "system" | "assistant" | "user" | "tool" | "activity" | "reasoning";

export interface DataSource {
    type: "data";
    value: string;
    mimeType: string;
}

export interface UrlSource {
    type: "url";
    value: string;
    mimeType?: string;
}

export interface FileSource {
    type: "file";
    value: string;
    provider?: string;
    mimeType?: string;
}

export type PartSource = DataSource | UrlSource | FileSource;

export interface TextPart {
    type: "text";
    id?: string;
    text: string;
    metadata?: unknown;
}

export interface ImagePart {
    type: "image";
    id?: string;
    source: PartSource;
    metadata?: unknown;
}

export interface AudioPart {
    type: "audio";
    id?: string;
    source: PartSource;
    metadata?: unknown;
}

export interface VideoPart {
    type: "video";
    id?: string;
    source: PartSource;
    metadata?: unknown;
}

export interface DocumentPart {
    type: "document";
    id?: string;
    source: PartSource;
    metadata?: unknown;
}

export type ContentPart = TextPart | ImagePart | AudioPart | VideoPart | DocumentPart;

export interface FunctionCall {
    name: string;
    arguments: string;
}

export interface ToolCall {
    id: string;
    type: "function";
    function: FunctionCall;
    encryptedValue?: string;
    metadata?: Metadata;
}

export interface DeveloperMessage {
    subagentRunId?: SubagentRunId;
    id: string;
    role: "developer";
    name?: string;
    encryptedValue?: string;
    metadata?: Metadata;
    content: string;
}

export interface SystemMessage {
    subagentRunId?: SubagentRunId;
    id: string;
    role: "system";
    name?: string;
    encryptedValue?: string;
    metadata?: Metadata;
    content: string;
}

export interface AssistantMessage {
    subagentRunId?: SubagentRunId;
    id: string;
    role: "assistant";
    name?: string;
    encryptedValue?: string;
    metadata?: Metadata;
    content?: string;
    toolCalls?: ToolCall[];
}

export interface UserMessage {
    subagentRunId?: SubagentRunId;
    id: string;
    role: "user";
    name?: string;
    encryptedValue?: string;
    metadata?: Metadata;
    content: string | ContentPart[];
}

export interface ToolMessage {
    subagentRunId?: SubagentRunId;
    id: string;
    role: "tool";
    content: string | ContentPart[];
    toolCallId: string;
    error?: string;
    encryptedValue?: string;
    metadata?: Metadata;
}

export interface ActivityMessage {
    subagentRunId?: SubagentRunId;
    id: string;
    role: "activity";
    activityType: string;
    content: Record<string, unknown>;
    metadata?: Metadata;
}

export interface ReasoningMessage {
    subagentRunId?: SubagentRunId;
    id: string;
    role: "reasoning";
    content: string;
    encryptedValue?: string;
    metadata?: Metadata;
}

export type Message =
    | DeveloperMessage
    | SystemMessage
    | AssistantMessage
    | UserMessage
    | ToolMessage
    | ActivityMessage
    | ReasoningMessage;

export type JsonPointer = string;

export interface AddOperation {
    op: "add";
    path: JsonPointer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
}

export interface RemoveOperation {
    op: "remove";
    path: JsonPointer;
}

export interface ReplaceOperation {
    op: "replace";
    path: JsonPointer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
}

export interface MoveOperation {
    op: "move";
    from: JsonPointer;
    path: JsonPointer;
}

export interface CopyOperation {
    op: "copy";
    from: JsonPointer;
    path: JsonPointer;
}

export interface TestOperation {
    op: "test";
    path: JsonPointer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any;
}

export type JsonPatchOperation =
    | AddOperation
    | RemoveOperation
    | ReplaceOperation
    | MoveOperation
    | CopyOperation
    | TestOperation;

export type JsonPatch = JsonPatchOperation[];

export interface Tool {
    name: string;
    description: string;
    parameters?: unknown;
    metadata?: Metadata;
}

export interface Context {
    description: string;
    value: string;
}

export interface Interrupt {
    subagentRunId?: SubagentRunId;
    id: string;
    reason: string;
    message?: string;
    toolCallId?: string;
    responseSchema?: Record<string, unknown>;
    expiresAt?: string;
    metadata?: Metadata;
}

export interface ResumeEntry {
    interruptId: string;
    status: "resolved" | "cancelled";
    payload?: unknown;
    metadata?: Metadata;
}

export interface RunAgentInput {
    threadId: string;
    runId: string;
    protocolVersion?: string;
    parentRunId?: string;
    state?: unknown;
    messages: Message[];
    tools: Tool[];
    context: Context[];
    forwardedProps?: unknown;
    resume?: ResumeEntry[];
}

export interface TokenUsage {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
}

export interface TextMessageStartEvent {
    type: typeof EventType.TEXT_MESSAGE_START;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
    role?: TextMessageRole;
    name?: string;
}

export interface TextMessageContentEvent {
    type: typeof EventType.TEXT_MESSAGE_CONTENT;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
    delta: string;
}

export interface TextMessageEndEvent {
    type: typeof EventType.TEXT_MESSAGE_END;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
}

export interface TextMessageChunkEvent {
    type: typeof EventType.TEXT_MESSAGE_CHUNK;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId?: string;
    role?: TextMessageRole;
    delta?: string;
    name?: string;
}

export interface ToolCallStartEvent {
    type: typeof EventType.TOOL_CALL_START;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    toolCallId: string;
    toolCallName: string;
    parentMessageId?: string;
}

export interface ToolCallArgsEvent {
    type: typeof EventType.TOOL_CALL_ARGS;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    toolCallId: string;
    delta: string;
}

export interface ToolCallEndEvent {
    type: typeof EventType.TOOL_CALL_END;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    toolCallId: string;
}

export interface ToolCallChunkEvent {
    type: typeof EventType.TOOL_CALL_CHUNK;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    toolCallId?: string;
    toolCallName?: string;
    parentMessageId?: string;
    delta?: string;
}

export interface ToolCallResultEvent {
    type: typeof EventType.TOOL_CALL_RESULT;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
    toolCallId: string;
    content: string | ContentPart[];
    role?: "tool";
}

export interface StateSnapshotEvent {
    type: typeof EventType.STATE_SNAPSHOT;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: any;
}

export interface StateDeltaEvent {
    type: typeof EventType.STATE_DELTA;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    delta: JsonPatch;
}

export interface MessagesSnapshotEvent {
    type: typeof EventType.MESSAGES_SNAPSHOT;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    messages: Message[];
}

export interface ActivitySnapshotEvent {
    type: typeof EventType.ACTIVITY_SNAPSHOT;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
    activityType: string;
    content: Record<string, unknown>;
    replace?: boolean;
}

export interface ActivityDeltaEvent {
    type: typeof EventType.ACTIVITY_DELTA;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
    activityType: string;
    patch: JsonPatch;
}

export interface RawEvent {
    type: typeof EventType.RAW;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    event: unknown;
    source?: string;
}

export interface CustomEvent {
    type: typeof EventType.CUSTOM;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    name: string;
    value: unknown;
}

export interface RunStartedEvent {
    type: typeof EventType.RUN_STARTED;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    threadId: string;
    runId: string;
    protocolVersion?: string;
    parentRunId?: string;
    input?: RunAgentInput;
}

export interface RunFinishedSuccessOutcome {
    type: "success";
    pendingToolCallIds?: string[];
}

export interface RunFinishedInterruptOutcome {
    type: "interrupt";
    interrupts: Interrupt[];
}

export interface RunFinishedCancelledOutcome {
    type: "cancelled";
}

export type RunFinishedOutcome =
    | RunFinishedSuccessOutcome
    | RunFinishedInterruptOutcome
    | RunFinishedCancelledOutcome;

export interface RunFinishedEvent {
    type: typeof EventType.RUN_FINISHED;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    threadId: string;
    runId: string;
    result?: unknown;
    outcome?: RunFinishedOutcome;
    usage?: TokenUsage[];
}

export interface RunErrorEvent {
    type: typeof EventType.RUN_ERROR;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    message: string;
    code?: string;
    usage?: TokenUsage[];
}

export interface StepStartedEvent {
    type: typeof EventType.STEP_STARTED;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    stepName: string;
}

export interface StepFinishedEvent {
    type: typeof EventType.STEP_FINISHED;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    stepName: string;
}

export interface ReasoningStartEvent {
    type: typeof EventType.REASONING_START;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
}

export interface ReasoningMessageStartEvent {
    type: typeof EventType.REASONING_MESSAGE_START;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
    role: "reasoning";
}

export interface ReasoningMessageContentEvent {
    type: typeof EventType.REASONING_MESSAGE_CONTENT;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
    delta: string;
}

export interface ReasoningMessageEndEvent {
    type: typeof EventType.REASONING_MESSAGE_END;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
}

export interface ReasoningMessageChunkEvent {
    type: typeof EventType.REASONING_MESSAGE_CHUNK;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId?: string;
    delta?: string;
}

export interface ReasoningEndEvent {
    type: typeof EventType.REASONING_END;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    messageId: string;
}

export type ReasoningEncryptedValueSubtype = "tool-call" | "message";

export interface ReasoningEncryptedValueEvent {
    type: typeof EventType.REASONING_ENCRYPTED_VALUE;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId?: SubagentRunId;
    subtype: ReasoningEncryptedValueSubtype;
    entityId: string;
    encryptedValue: string;
}

export interface SubagentStartedEvent {
    type: typeof EventType.SUBAGENT_STARTED;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId: SubagentRunId;
    name: string;
    description?: string;
    parentSubagentRunId?: SubagentRunId;
    parentToolCallId?: string;
    parentMessageId?: string;
}

export interface SubagentFinishedSuccessOutcome {
    type: "success";
}

export interface SubagentFinishedSuspendedOutcome {
    type: "suspended";
    interruptIds?: string[];
}

export type SubagentFinishedOutcome =
    | SubagentFinishedSuccessOutcome
    | SubagentFinishedSuspendedOutcome;

export interface SubagentFinishedEvent {
    type: typeof EventType.SUBAGENT_FINISHED;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId: SubagentRunId;
    result?: unknown;
    outcome?: SubagentFinishedOutcome;
}

export interface SubagentErrorEvent {
    type: typeof EventType.SUBAGENT_ERROR;
    timestamp?: number;
    rawEvent?: unknown;
    metadata?: Metadata;
    subagentRunId: SubagentRunId;
    message: string;
    code?: string;
}

export type AcpEvent =
    | TextMessageStartEvent
    | TextMessageContentEvent
    | TextMessageEndEvent
    | TextMessageChunkEvent
    | ToolCallStartEvent
    | ToolCallArgsEvent
    | ToolCallEndEvent
    | ToolCallChunkEvent
    | ToolCallResultEvent
    | StateSnapshotEvent
    | StateDeltaEvent
    | MessagesSnapshotEvent
    | ActivitySnapshotEvent
    | ActivityDeltaEvent
    | RawEvent
    | CustomEvent
    | RunStartedEvent
    | RunFinishedEvent
    | RunErrorEvent
    | StepStartedEvent
    | StepFinishedEvent
    | ReasoningStartEvent
    | ReasoningMessageStartEvent
    | ReasoningMessageContentEvent
    | ReasoningMessageEndEvent
    | ReasoningMessageChunkEvent
    | ReasoningEndEvent
    | ReasoningEncryptedValueEvent
    | SubagentStartedEvent
    | SubagentFinishedEvent
    | SubagentErrorEvent;

export type BaseEvent = AcpEvent;

const COUNT_KEYS = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
] as const;

const prop = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;

const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

export const tokenUsageFromAiSdkUsage = (
    usage: unknown,
    { provider, model }: { provider?: string; model?: string },
): TokenUsage | undefined => {
    if (!usage) return undefined;
    const inputDetails = prop(usage, "inputTokenDetails");
    const outputDetails = prop(usage, "outputTokenDetails");
    const counts: Record<string, number | undefined> = {
        inputTokens: num(prop(usage, "inputTokens")),
        outputTokens: num(prop(usage, "outputTokens")),
        totalTokens: num(prop(usage, "totalTokens")),
        reasoningTokens: num(prop(usage, "reasoningTokens")) ?? num(prop(outputDetails, "reasoningTokens")),
        cachedInputTokens: num(prop(usage, "cachedInputTokens")) ?? num(prop(inputDetails, "cacheReadTokens")),
        cacheWriteInputTokens: num(prop(inputDetails, "cacheWriteTokens")),
    };
    if (!COUNT_KEYS.some((key) => counts[key] !== undefined)) return undefined;
    const entry: TokenUsage = {};
    if (provider !== undefined) entry.provider = provider;
    if (model !== undefined) entry.model = model;
    for (const key of COUNT_KEYS) {
        const value = counts[key];
        if (value !== undefined) entry[key] = value;
    }
    return entry;
};

export const aggregateTokenUsage = (entries: readonly TokenUsage[]): TokenUsage[] => {
    const grouped = new Map<string, TokenUsage>();
    for (const entry of entries) {
        const key = `${entry.provider ?? ""} ${entry.model ?? ""}`;
        let target = grouped.get(key);
        if (!target) {
            target = {
                ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
                ...(entry.model !== undefined ? { model: entry.model } : {}),
            };
            grouped.set(key, target);
        }
        for (const field of COUNT_KEYS) {
            const value = entry[field];
            if (value === undefined) continue;
            target[field] = (target[field] ?? 0) + value;
        }
    }
    return [...grouped.values()];
};

const isContentPart = (value: unknown): value is ContentPart => {
    if (!isRecord(value) || typeof value.type !== "string") return false;
    if (value.type === "text") return typeof value.text === "string";
    if (value.type === "image" || value.type === "audio" || value.type === "video" || value.type === "document") {
        if (!isRecord(value.source) || typeof value.source.type !== "string") return false;
        if (value.source.type === "data") return typeof value.source.value === "string" && typeof value.source.mimeType === "string";
        if (value.source.type === "url" || value.source.type === "file") return typeof value.source.value === "string";
    }
    return false;
};

const isMessage = (value: unknown): value is Message => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.role !== "string") return false;
    if (value.subagentRunId !== undefined && typeof value.subagentRunId !== "string") return false;
    switch (value.role) {
        case "developer":
        case "system":
        case "reasoning":
            return typeof value.content === "string";
        case "assistant":
            return (value.content === undefined || typeof value.content === "string")
                && (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every((tc) =>
                    isRecord(tc) && typeof tc.id === "string" && tc.type === "function" && isRecord(tc.function)
                    && typeof tc.function.name === "string" && typeof tc.function.arguments === "string")));
        case "user":
            return typeof value.content === "string"
                || (Array.isArray(value.content) && value.content.every(isContentPart));
        case "tool":
            return typeof value.toolCallId === "string"
                && (typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(isContentPart)));
        case "activity":
            return typeof value.activityType === "string" && isRecord(value.content);
        default:
            return false;
    }
};

const isTool = (tool: unknown): tool is Tool =>
    isRecord(tool) && typeof tool.name === "string" && typeof tool.description === "string" && tool.parameters !== null;

const isContext = (ctx: unknown): ctx is Context =>
    isRecord(ctx) && typeof ctx.description === "string" && typeof ctx.value === "string";

const isResumeEntry = (entry: unknown): entry is ResumeEntry =>
    isRecord(entry) && typeof entry.interruptId === "string" && (entry.status === "resolved" || entry.status === "cancelled") && entry.payload !== null;

export const parseRunAgentInput = (
    decoded: unknown,
): { success: true; data: RunAgentInput } | { success: false; issues: Array<{ path: Array<string | number>; message: string }> } => {
    const issues: Array<{ path: Array<string | number>; message: string }> = [];
    if (!isRecord(decoded)) {
        return { success: false, issues: [{ path: [], message: "Expected object" }] };
    }
    const threadId = typeof decoded.threadId === "string" ? decoded.threadId : null;
    if (threadId === null) {
        issues.push({ path: ["threadId"], message: "Expected string" });
    }
    const runId = typeof decoded.runId === "string" ? decoded.runId : null;
    if (runId === null) {
        issues.push({ path: ["runId"], message: "Expected string" });
    }
    const messages: Message[] = [];
    if (!Array.isArray(decoded.messages)) {
        issues.push({ path: ["messages"], message: "Expected array" });
    } else {
        decoded.messages.forEach((msg, index) => {
            if (!isMessage(msg)) {
                issues.push({ path: ["messages", index], message: "Invalid message" });
            } else {
                messages.push(msg);
            }
        });
    }
    const tools: Tool[] = [];
    if (decoded.tools !== undefined) {
        if (!Array.isArray(decoded.tools)) {
            issues.push({ path: ["tools"], message: "Expected array" });
        } else {
            decoded.tools.forEach((tool, index) => {
                if (!isTool(tool)) {
                    issues.push({ path: ["tools", index], message: "Invalid tool" });
                } else {
                    tools.push(tool);
                }
            });
        }
    }
    const context: Context[] = [];
    if (decoded.context !== undefined) {
        if (!Array.isArray(decoded.context)) {
            issues.push({ path: ["context"], message: "Expected array" });
        } else {
            decoded.context.forEach((ctx, index) => {
                if (!isContext(ctx)) {
                    issues.push({ path: ["context", index], message: "Invalid context" });
                } else {
                    context.push(ctx);
                }
            });
        }
    }
    if (decoded.forwardedProps === null) {
        issues.push({ path: ["forwardedProps"], message: "Expected non-null value" });
    }
    let resume: ResumeEntry[] | undefined;
    if (decoded.resume !== undefined) {
        if (!Array.isArray(decoded.resume)) {
            issues.push({ path: ["resume"], message: "Expected array" });
        } else {
            resume = [];
            decoded.resume.forEach((entry, index) => {
                if (!isResumeEntry(entry)) {
                    issues.push({ path: ["resume", index], message: "Invalid resume entry" });
                } else {
                    resume?.push(entry);
                }
            });
        }
    }
    if (issues.length > 0 || threadId === null || runId === null) {
        return { success: false, issues };
    }
    return {
        success: true,
        data: {
            ...decoded,
            threadId,
            runId,
            messages,
            tools,
            context,
            ...(decoded.state === null || decoded.state === undefined ? {} : { state: decoded.state }),
            ...(decoded.forwardedProps === undefined ? {} : { forwardedProps: decoded.forwardedProps }),
            ...(resume === undefined ? {} : { resume }),
        },
    };
};

export interface SchemaValidator<T> {
    readonly parse: (value: unknown) => T;
    readonly safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } };
}

const makeValidator = <T>(name: string, check: (value: unknown) => value is T): SchemaValidator<T> => ({
    safeParse(value: unknown) {
        if (check(value)) return { success: true, data: value };
        return { success: false, error: { issues: [{ path: [], message: `Invalid ${name}` }] } };
    },
    parse(value: unknown): T {
        if (check(value)) return value;
        throw new TypeError(`Invalid ${name}: ${JSON.stringify(value)}`);
    },
});

export const RunAgentInputSchema: SchemaValidator<RunAgentInput> = {
    safeParse(value: unknown) {
        const res = parseRunAgentInput(value);
        return res.success ? res : { success: false, error: { issues: res.issues } };
    },
    parse(value: unknown): RunAgentInput {
        const res = parseRunAgentInput(value);
        if (!res.success) throw new TypeError(`Invalid RunAgentInput: ${JSON.stringify(res.issues)}`);
        return res.data;
    },
};

export const MessageSchema: SchemaValidator<Message> = makeValidator<Message>("Message", isMessage);

const hasEventBase = (value: unknown, type: EventType): value is Record<string, unknown> =>
    isRecord(value)
    && value.type === type
    && (value.timestamp === undefined || (typeof value.timestamp === "number" && Number.isSafeInteger(value.timestamp)))
    && value.rawEvent !== null
    && (value.metadata === undefined || isRecord(value.metadata))
    && (value.subagentRunId === undefined || typeof value.subagentRunId === "string");

export const MessagesSnapshotEventSchema: SchemaValidator<MessagesSnapshotEvent> = makeValidator<MessagesSnapshotEvent>(
    "MessagesSnapshotEvent",
    (value): value is MessagesSnapshotEvent =>
        hasEventBase(value, EventType.MESSAGES_SNAPSHOT)
        && Array.isArray(value.messages)
        && value.messages.every(isMessage),
);

const isTokenUsage = (value: unknown): value is TokenUsage =>
    Array.isArray(value) && value.every((entry) =>
        isRecord(entry)
        && typeof entry.provider === "string" && entry.provider.length > 0
        && typeof entry.model === "string" && entry.model.length > 0);

export const RunErrorEventSchema: SchemaValidator<RunErrorEvent> = makeValidator<RunErrorEvent>(
    "RunErrorEvent",
    (value): value is RunErrorEvent =>
        hasEventBase(value, EventType.RUN_ERROR)
        && typeof value.message === "string"
        && (value.code === undefined || typeof value.code === "string")
        && (value.usage === undefined || isTokenUsage(value.usage)),
);

export const RunFinishedEventSchema: SchemaValidator<RunFinishedEvent> = makeValidator<RunFinishedEvent>(
    "RunFinishedEvent",
    (value): value is RunFinishedEvent =>
        hasEventBase(value, EventType.RUN_FINISHED)
        && typeof value.threadId === "string"
        && typeof value.runId === "string"
        && value.result !== null
        && (value.usage === undefined || isTokenUsage(value.usage))
        && (value.outcome === undefined || (isRecord(value.outcome) && (
            value.outcome.type === "success"
            || value.outcome.type === "cancelled"
            || (value.outcome.type === "interrupt" && Array.isArray(value.outcome.interrupts) && value.outcome.interrupts.length > 0)
        ))),
);

export const ReasoningStartEventSchema: SchemaValidator<ReasoningStartEvent> = makeValidator<ReasoningStartEvent>(
    "ReasoningStartEvent",
    (value): value is ReasoningStartEvent =>
        hasEventBase(value, EventType.REASONING_START) && typeof value.messageId === "string",
);

export const ReasoningMessageStartEventSchema: SchemaValidator<ReasoningMessageStartEvent> = makeValidator<ReasoningMessageStartEvent>(
    "ReasoningMessageStartEvent",
    (value): value is ReasoningMessageStartEvent =>
        hasEventBase(value, EventType.REASONING_MESSAGE_START)
        && typeof value.messageId === "string"
        && value.role === "reasoning",
);

export const ReasoningMessageContentEventSchema: SchemaValidator<ReasoningMessageContentEvent> = makeValidator<ReasoningMessageContentEvent>(
    "ReasoningMessageContentEvent",
    (value): value is ReasoningMessageContentEvent =>
        hasEventBase(value, EventType.REASONING_MESSAGE_CONTENT)
        && typeof value.messageId === "string"
        && typeof value.delta === "string"
        && value.delta.length > 0,
);

export const ReasoningMessageEndEventSchema: SchemaValidator<ReasoningMessageEndEvent> = makeValidator<ReasoningMessageEndEvent>(
    "ReasoningMessageEndEvent",
    (value): value is ReasoningMessageEndEvent =>
        hasEventBase(value, EventType.REASONING_MESSAGE_END) && typeof value.messageId === "string",
);

export const ReasoningEndEventSchema: SchemaValidator<ReasoningEndEvent> = makeValidator<ReasoningEndEvent>(
    "ReasoningEndEvent",
    (value): value is ReasoningEndEvent =>
        hasEventBase(value, EventType.REASONING_END) && typeof value.messageId === "string",
);


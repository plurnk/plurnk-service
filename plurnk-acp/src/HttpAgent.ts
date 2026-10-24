import {
    EventType,
    type AcpEvent,
    type ActivityDeltaEvent,
    type ActivityMessage,
    type ActivitySnapshotEvent,
    type AssistantMessage,
    type BaseEvent,
    type CustomEvent,
    type Interrupt,
    type JsonPatchOperation,
    type Message,
    type MessagesSnapshotEvent,
    type Metadata,
    type RawEvent,
    type ReasoningEncryptedValueEvent,
    type ReasoningEndEvent,
    type ReasoningMessageContentEvent,
    type ReasoningMessageEndEvent,
    type ReasoningMessageStartEvent,
    type ReasoningStartEvent,
    type ResumeEntry,
    type RunAgentInput,
    type RunErrorEvent,
    type RunFinishedEvent,
    type RunStartedEvent,
    type StateDeltaEvent,
    type StateSnapshotEvent,
    type StepFinishedEvent,
    type StepStartedEvent,
    type SubagentErrorEvent,
    type SubagentFinishedEvent,
    type SubagentStartedEvent,
    type TextMessageContentEvent,
    type TextMessageEndEvent,
    type TextMessageStartEvent,
    type ToolCall,
    type ToolCallArgsEvent,
    type ToolCallEndEvent,
    type ToolCallResultEvent,
    type ToolCallStartEvent,
    type ToolMessage,
} from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);

const isObj = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isAcpEvent = (value: Record<string, unknown>): value is AcpEvent & Record<string, unknown> =>
    typeof value.type === "string" && value.type.length > 0;

const stripNullSubagentRunId = <T extends object>(item: T): T => {
    if (!("subagentRunId" in item) || item.subagentRunId !== null) return item;
    const copy = { ...item };
    delete copy.subagentRunId;
    return copy;
};

export const randomUUID = (): string => {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export type ResumeResponse =
    | {
        readonly status: "resolved";
        readonly payload?: unknown;
        readonly metadata?: Metadata;
    }
    | {
        readonly status: "cancelled";
        readonly metadata?: Metadata;
    };

export const buildResumeArray = (
    interrupts: readonly Interrupt[],
    responses: Readonly<Record<string, ResumeResponse>>,
): ResumeEntry[] => {
    const openIds = new Set(interrupts.map((entry) => entry.id));
    const responseIds = new Set(Object.keys(responses));
    const missing = [...openIds].filter((id) => !responseIds.has(id));
    if (missing.length > 0) {
        throw new Error(`buildResumeArray: missing responses for open interrupts: ${missing.join(", ")}`);
    }
    const unknown = [...responseIds].filter((id) => !openIds.has(id));
    if (unknown.length > 0) {
        throw new Error(`buildResumeArray: responses reference unknown interrupt ids: ${unknown.join(", ")}`);
    }
    return interrupts.map((entry) => {
        const resp = responses[entry.id];
        return {
            interruptId: entry.id,
            status: resp.status,
            ...(resp.status === "resolved" && resp.payload !== undefined ? { payload: resp.payload } : {}),
            ...(resp.metadata !== undefined ? { metadata: resp.metadata } : {}),
        };
    });
};

const decodePointerToken = (token: string): string => token.replace(/~1/gu, "/").replace(/~0/gu, "~");

const applySinglePatch = (root: unknown, patch: JsonPatchOperation): unknown => {
    if (patch.path === "") {
        if (patch.op === "replace" || patch.op === "add") return clone(patch.value);
        throw new Error(`Unsupported root patch op: ${patch.op}`);
    }
    if (!patch.path.startsWith("/")) {
        throw new Error(`Invalid JSON Pointer "${patch.path}"`);
    }
    const tokens = patch.path.slice(1).split("/").map(decodePointerToken);
    const result = clone(root);
    let current: unknown = result;
    for (let i = 0; i < tokens.length - 1; i += 1) {
        const token = tokens[i];
        if (Array.isArray(current)) {
            const idx = Number(token);
            if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
                throw new Error(`Invalid array index "${token}" in "${patch.path}"`);
            }
            current = current[idx];
        } else if (isObj(current) && token in current) {
            current = current[token];
        } else {
            throw new Error(`Path "${patch.path}" does not exist at "${token}"`);
        }
    }
    const last = tokens[tokens.length - 1];
    if (Array.isArray(current)) {
        if (patch.op === "add") {
            if (last === "-") {
                current.push(clone(patch.value));
            } else {
                const idx = Number(last);
                if (!Number.isInteger(idx) || idx < 0 || idx > current.length) {
                    throw new Error(`Invalid array index "${last}" in "${patch.path}"`);
                }
                current.splice(idx, 0, clone(patch.value));
            }
        } else if (patch.op === "replace") {
            const idx = Number(last);
            if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
                throw new Error(`Invalid array index "${last}" in "${patch.path}"`);
            }
            current[idx] = clone(patch.value);
        } else if (patch.op === "remove") {
            const idx = Number(last);
            if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
                throw new Error(`Invalid array index "${last}" in "${patch.path}"`);
            }
            current.splice(idx, 1);
        }
        return result;
    }
    if (!isObj(current)) {
        throw new Error(`Cannot apply patch "${patch.op}" to non-container at "${patch.path}"`);
    }
    if (patch.op === "add") {
        current[last] = clone(patch.value);
    } else if (patch.op === "replace") {
        current[last] = clone(patch.value);
    } else if (patch.op === "remove") {
        if (!(last in current)) {
            throw new Error(`Cannot remove missing key "${last}" at "${patch.path}"`);
        }
        delete current[last];
    }
    return result;
};

export const applyJsonPatch = (doc: unknown, delta: readonly JsonPatchOperation[]): unknown => {
    let current = clone(doc);
    for (const patch of delta) {
        current = applySinglePatch(current, patch);
    }
    return current;
};

export interface AgentStateMutation {
    messages?: Message[];
    state?: unknown;
    stopPropagation?: boolean;
}

export interface AgentSubscriberParams {
    messages: ReadonlyArray<Readonly<Message>>;
    state: unknown;
    agent: HttpAgent;
    input: RunAgentInput;
}

type MaybePromise<T> = T | Promise<T>;

export interface AgentSubscriber {
    onRunInitialized?(params: AgentSubscriberParams): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
    onRunFailed?(params: { error: Error } & AgentSubscriberParams): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
    onRunFinalized?(params: AgentSubscriberParams): MaybePromise<Omit<AgentStateMutation, "stopPropagation"> | void>;
    onEvent?(params: { event: BaseEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onRunStartedEvent?(params: { event: RunStartedEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onRunFinishedEvent?(
        params: (
            | {
                event: RunFinishedEvent;
                outcome: "success";
                result?: unknown;
                pendingToolCallIds: string[];
            }
            | {
                event: RunFinishedEvent;
                outcome: "interrupt";
                interrupts: Interrupt[];
            }
            | {
                event: RunFinishedEvent;
                outcome: "cancelled";
            }
        ) & AgentSubscriberParams,
    ): MaybePromise<AgentStateMutation | void>;
    onRunErrorEvent?(params: { event: RunErrorEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onStepStartedEvent?(params: { event: StepStartedEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onStepFinishedEvent?(params: { event: StepFinishedEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onSubagentStartedEvent?(params: { event: SubagentStartedEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onSubagentFinishedEvent?(params: { event: SubagentFinishedEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onSubagentErrorEvent?(params: { event: SubagentErrorEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onTextMessageStartEvent?(params: { event: TextMessageStartEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onTextMessageContentEvent?(params: { event: TextMessageContentEvent; textMessageBuffer: string } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onTextMessageEndEvent?(params: { event: TextMessageEndEvent; textMessageBuffer: string } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onToolCallStartEvent?(params: { event: ToolCallStartEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onToolCallArgsEvent?(params: { event: ToolCallArgsEvent; toolCallBuffer: string; toolCallName: string; partialToolCallArgs: Record<string, unknown> } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onToolCallEndEvent?(params: { event: ToolCallEndEvent; toolCallName: string; toolCallArgs: Record<string, unknown> } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onToolCallResultEvent?(params: { event: ToolCallResultEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onStateSnapshotEvent?(params: { event: StateSnapshotEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onStateDeltaEvent?(params: { event: StateDeltaEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onMessagesSnapshotEvent?(params: { event: MessagesSnapshotEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onActivitySnapshotEvent?(params: { event: ActivitySnapshotEvent; activityMessage?: ActivityMessage; existingMessage?: Message } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onActivityDeltaEvent?(params: { event: ActivityDeltaEvent; activityMessage?: ActivityMessage } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onRawEvent?(params: { event: RawEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onCustomEvent?(params: { event: CustomEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onReasoningStartEvent?(params: { event: ReasoningStartEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onReasoningMessageStartEvent?(params: { event: ReasoningMessageStartEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onReasoningMessageContentEvent?(params: { event: ReasoningMessageContentEvent; reasoningMessageBuffer: string } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onReasoningMessageEndEvent?(params: { event: ReasoningMessageEndEvent; reasoningMessageBuffer: string } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onReasoningEndEvent?(params: { event: ReasoningEndEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onReasoningEncryptedValueEvent?(params: { event: ReasoningEncryptedValueEvent } & AgentSubscriberParams): MaybePromise<AgentStateMutation | void>;
    onMessagesChanged?(params: Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput }): MaybePromise<void>;
    onStateChanged?(params: Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput }): MaybePromise<void>;
    onNewMessage?(params: { message: Message } & Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput }): MaybePromise<void>;
    onNewToolCall?(params: { toolCall: ToolCall } & Omit<AgentSubscriberParams, "input"> & { input?: RunAgentInput }): MaybePromise<void>;
}

export type HttpAgentFetchFn = (url: string, requestInit: RequestInit) => Promise<Response>;

export interface AgentConfig {
    agentId?: string;
    description?: string;
    threadId?: string;
    initialMessages?: Message[];
    initialState?: unknown;
    debug?: boolean | { events?: boolean; lifecycle?: boolean; verbose?: boolean };
}

export interface HttpAgentConfig extends AgentConfig {
    url: string;
    headers?: Record<string, string>;
    fetch?: HttpAgentFetchFn;
}

export interface RunAgentParameters extends Partial<Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">> {
    resume?: ResumeEntry[];
}

export interface RunHttpAgentConfig extends RunAgentParameters {
    abortController?: AbortController;
}

export interface RunAgentResult {
    result: unknown;
    newMessages: Message[];
}

export interface RunEventObserver {
    next?: (event: AcpEvent) => void;
    error?: (error: unknown) => void;
    complete?: () => void;
}

export class RunEventStream implements AsyncIterable<AcpEvent> {
    readonly #factory: (onCancel: (cb: () => void) => void) => AsyncGenerator<AcpEvent>;

    constructor(factory: (onCancel: (cb: () => void) => void) => AsyncGenerator<AcpEvent>) {
        this.#factory = factory;
    }

    [Symbol.asyncIterator](): AsyncIterator<AcpEvent> {
        const cancelCallbacks: Array<() => void> = [];
        let cancelled = false;
        let wakeCancel: (() => void) | undefined;
        const cancelPromise = new Promise<IteratorResult<AcpEvent>>((resolve) => {
            wakeCancel = () => resolve({ value: undefined, done: true });
        });
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            wakeCancel?.();
            for (const cb of cancelCallbacks.splice(0)) {
                try {
                    cb();
                } catch {
                    // Ignore cleanup errors
                }
            }
        };
        const iterator = this.#factory((cb) => {
            if (cancelled) {
                try {
                    cb();
                } catch {
                    // Ignore cleanup errors
                }
            } else {
                cancelCallbacks.push(cb);
            }
        });
        return {
            next: () => {
                if (cancelled) return Promise.resolve({ value: undefined, done: true });
                return Promise.race([iterator.next(), cancelPromise]);
            },
            return: (value?: unknown) => {
                cancel();
                void iterator.return(value).catch(() => {});
                return Promise.resolve({ value: undefined, done: true });
            },
            throw: (error?: unknown) => {
                cancel();
                return iterator.throw(error);
            },
        };
    }

    pipe(...operators: ReadonlyArray<(source: RunEventStream) => RunEventStream>): RunEventStream {
        return operators.reduce((acc, op) => op(acc), this as RunEventStream);
    }

    subscribe(observer: RunEventObserver): { unsubscribe: () => void } {
        let cancelled = false;
        const iterator = this[Symbol.asyncIterator]();
        void (async () => {
            try {
                for (;;) {
                    const { value, done } = await iterator.next();
                    if (cancelled) return;
                    if (done) {
                        observer.complete?.();
                        return;
                    }
                    observer.next?.(value);
                }
            } catch (error) {
                if (!cancelled) {
                    observer.error?.(error);
                }
            }
        })();
        return {
            unsubscribe: () => {
                cancelled = true;
                void iterator.return?.(undefined).catch(() => {});
            },
        };
    }
}

export const enforceEvents = () => (source: RunEventStream): RunEventStream => source;

const mergeMetadata = (target: { metadata?: Metadata }, event: { metadata?: Metadata }): boolean => {
    if (event.metadata === undefined) return false;
    target.metadata = target.metadata === undefined
        ? clone(event.metadata)
        : { ...target.metadata, ...clone(event.metadata) };
    return true;
};

const ensureAssistantMessageForToolCall = (
    messages: Message[],
    parentMessageId: string | undefined,
    toolCallId: string,
): AssistantMessage => {
    if (parentMessageId !== undefined) {
        const existing = messages.find((m) => m.id === parentMessageId);
        if (existing?.role === "assistant") return existing;
        const created: AssistantMessage = { id: existing ? toolCallId : parentMessageId, role: "assistant", toolCalls: [] };
        messages.push(created);
        return created;
    }
    const created: AssistantMessage = { id: toolCallId, role: "assistant", toolCalls: [] };
    messages.push(created);
    return created;
};

const createEventVerifier = () => {
    const activeMessages = new Set<string>();
    const activeToolCalls = new Set<string>();
    const activeReasoningSpans = new Set<string>();
    const activeReasoningMessages = new Set<string>();
    const activeSteps = new Map<string | undefined, Set<string>>();
    const activeSubagents = new Set<string>();
    const finishedSubagents = new Set<string>();
    let started = false;
    let finished = false;
    let errored = false;

    return (rawEvent: AcpEvent): AcpEvent => {
        const event = stripNullSubagentRunId(rawEvent);
        const t = event.type;
        if (errored && t !== EventType.RUN_STARTED) {
            throw new Error(`Cannot send event type '${t}': The run has already errored with 'RUN_ERROR'. No further events can be sent.`);
        }
        if (finished && t !== EventType.RUN_ERROR && t !== EventType.RUN_STARTED) {
            throw new Error(`Cannot send event type '${t}': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.`);
        }
        if (!started) {
            started = true;
            if (t !== EventType.RUN_STARTED && t !== EventType.RUN_ERROR) {
                throw new Error("First event must be 'RUN_STARTED'");
            }
        } else if (t === EventType.RUN_STARTED) {
            if (!finished && !errored) {
                throw new Error("Cannot send 'RUN_STARTED' while a run is still active. The previous run must be finished with 'RUN_FINISHED' before starting a new run.");
            }
            activeMessages.clear();
            activeToolCalls.clear();
            activeReasoningSpans.clear();
            activeReasoningMessages.clear();
            activeSteps.clear();
            activeSubagents.clear();
            finishedSubagents.clear();
            finished = false;
            errored = false;
        }
        switch (t) {
            case EventType.TEXT_MESSAGE_START:
                if (activeMessages.has(event.messageId)) {
                    throw new Error(`Cannot send 'TEXT_MESSAGE_START' event: A text message with ID '${event.messageId}' is already in progress. Complete it with 'TEXT_MESSAGE_END' first.`);
                }
                activeMessages.add(event.messageId);
                break;
            case EventType.TEXT_MESSAGE_CONTENT:
                if (!activeMessages.has(event.messageId)) {
                    throw new Error(`Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID '${event.messageId}'. Start a text message with 'TEXT_MESSAGE_START' first.`);
                }
                break;
            case EventType.TEXT_MESSAGE_END:
                if (!activeMessages.has(event.messageId)) {
                    throw new Error(`Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID '${event.messageId}'. A 'TEXT_MESSAGE_START' event must be sent first.`);
                }
                activeMessages.delete(event.messageId);
                break;
            case EventType.TOOL_CALL_START:
                if (activeToolCalls.has(event.toolCallId)) {
                    throw new Error(`Cannot send 'TOOL_CALL_START' event: A tool call with ID '${event.toolCallId}' is already in progress. Complete it with 'TOOL_CALL_END' first.`);
                }
                activeToolCalls.add(event.toolCallId);
                break;
            case EventType.TOOL_CALL_ARGS:
                if (!activeToolCalls.has(event.toolCallId)) {
                    throw new Error(`Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID '${event.toolCallId}'. Start a tool call with 'TOOL_CALL_START' first.`);
                }
                break;
            case EventType.TOOL_CALL_END:
                if (!activeToolCalls.has(event.toolCallId)) {
                    throw new Error(`Cannot send 'TOOL_CALL_END' event: No active tool call found with ID '${event.toolCallId}'. A 'TOOL_CALL_START' event must be sent first.`);
                }
                activeToolCalls.delete(event.toolCallId);
                break;
            case EventType.STEP_STARTED: {
                let steps = activeSteps.get(event.subagentRunId);
                if (!steps) {
                    steps = new Set();
                    activeSteps.set(event.subagentRunId, steps);
                }
                if (steps.has(event.stepName)) {
                    throw new Error(`Step "${event.stepName}" is already active for 'STEP_STARTED'`);
                }
                steps.add(event.stepName);
                break;
            }
            case EventType.STEP_FINISHED: {
                const steps = activeSteps.get(event.subagentRunId);
                if (!steps?.has(event.stepName)) {
                    throw new Error(`Cannot send 'STEP_FINISHED' for step "${event.stepName}" that was not started`);
                }
                steps.delete(event.stepName);
                break;
            }
            case EventType.REASONING_START:
                if (activeReasoningSpans.has(event.messageId)) {
                    throw new Error(`Cannot send 'REASONING_START' event: A reasoning span with ID '${event.messageId}' is already in progress. Complete it with 'REASONING_END' first.`);
                }
                activeReasoningSpans.add(event.messageId);
                break;
            case EventType.REASONING_MESSAGE_START:
                if (activeReasoningMessages.has(event.messageId)) {
                    throw new Error(`Cannot send 'REASONING_MESSAGE_START' event: A reasoning message with ID '${event.messageId}' is already in progress. Complete it with 'REASONING_MESSAGE_END' first.`);
                }
                activeReasoningMessages.add(event.messageId);
                break;
            case EventType.REASONING_MESSAGE_CONTENT:
            case EventType.REASONING_MESSAGE_END:
                if (!activeReasoningMessages.has(event.messageId)) {
                    throw new Error(`Cannot send '${t}' event: No active reasoning message found with ID '${event.messageId}'. Start a reasoning message with 'REASONING_MESSAGE_START' first.`);
                }
                if (t === EventType.REASONING_MESSAGE_END) activeReasoningMessages.delete(event.messageId);
                break;
            case EventType.REASONING_END:
                if (!activeReasoningSpans.has(event.messageId)) {
                    throw new Error(`Cannot send 'REASONING_END' event: No active reasoning span found with ID '${event.messageId}'. A 'REASONING_START' event must be sent first.`);
                }
                activeReasoningSpans.delete(event.messageId);
                break;
            case EventType.SUBAGENT_STARTED:
                if (activeSubagents.has(event.subagentRunId)) {
                    throw new Error(`Cannot send 'SUBAGENT_STARTED': subagent '${event.subagentRunId}' is already active.`);
                }
                if (finishedSubagents.has(event.subagentRunId)) {
                    throw new Error(`Cannot send 'SUBAGENT_STARTED': subagent '${event.subagentRunId}' has already finished in this run.`);
                }
                activeSubagents.add(event.subagentRunId);
                break;
            case EventType.SUBAGENT_FINISHED:
            case EventType.SUBAGENT_ERROR:
                if (!activeSubagents.has(event.subagentRunId)) {
                    throw new Error(`Cannot send '${t}': no active subagent found with ID '${event.subagentRunId}'. A 'SUBAGENT_STARTED' event must be sent first.`);
                }
                activeSubagents.delete(event.subagentRunId);
                finishedSubagents.add(event.subagentRunId);
                break;
            case EventType.RUN_FINISHED: {
                for (const [, steps] of activeSteps) {
                    if (steps.size > 0) throw new Error(`Cannot send 'RUN_FINISHED' while steps are still active: ${[...steps].join(", ")}`);
                }
                if (activeMessages.size > 0) throw new Error(`Cannot send 'RUN_FINISHED' while text messages are still active: ${[...activeMessages].join(", ")}`);
                if (activeReasoningMessages.size > 0) throw new Error(`Cannot send 'RUN_FINISHED' while reasoning messages are still active: ${[...activeReasoningMessages].join(", ")}`);
                if (activeReasoningSpans.size > 0) throw new Error(`Cannot send 'RUN_FINISHED' while reasoning spans are still active: ${[...activeReasoningSpans].join(", ")}`);
                if (activeToolCalls.size > 0) throw new Error(`Cannot send 'RUN_FINISHED' while tool calls are still active: ${[...activeToolCalls].join(", ")}`);
                if (activeSubagents.size > 0) throw new Error(`Cannot send 'RUN_FINISHED' while subagents are still active: ${[...activeSubagents].join(", ")}`);
                finished = true;
                break;
            }
            case EventType.RUN_ERROR:
                errored = true;
                break;
            default:
                break;
        }
        return event;
    };
};

export class HttpAgent {
    url: string;
    headers: Record<string, string>;
    fetch: HttpAgentFetchFn;
    abortController: AbortController;
    agentId?: string;
    description: string;
    threadId: string;
    messages: Message[];
    state: unknown;
    subscribers: AgentSubscriber[];
    isRunning: boolean;
    pendingInterrupts: Interrupt[];
    #detachCancel: (() => void) | null = null;
    #activeCompletion: Promise<void> | null = null;

    constructor(config: HttpAgentConfig) {
        this.url = config.url;
        this.headers = clone(config.headers ?? {});
        this.fetch = config.fetch ?? ((url, init) => fetch(url, init));
        this.abortController = new AbortController();
        this.agentId = config.agentId;
        this.description = config.description ?? "";
        this.threadId = config.threadId ?? randomUUID();
        this.messages = clone(config.initialMessages ?? []);
        this.state = clone(config.initialState ?? {});
        this.subscribers = [];
        this.isRunning = false;
        this.pendingInterrupts = [];
    }

    subscribe(subscriber: AgentSubscriber): { unsubscribe: () => void } {
        this.subscribers.push(subscriber);
        return {
            unsubscribe: () => {
                this.subscribers = this.subscribers.filter((s) => s !== subscriber);
            },
        };
    }

    use(..._middlewares: unknown[]): this {
        return this;
    }

    addMessage(message: Message): void {
        this.messages.push(message);
    }

    addMessages(messages: Message[]): void {
        this.messages.push(...messages);
    }

    setMessages(messages: Message[]): void {
        this.messages = clone(messages);
    }

    setState(state: unknown): void {
        this.state = clone(state);
    }

    abortRun(): void {
        this.abortController.abort();
    }

    async detachActiveRun(): Promise<void> {
        if (!this.#detachCancel) return;
        const completion = this.#activeCompletion ?? Promise.resolve();
        this.#detachCancel();
        await completion;
    }

    clone(): HttpAgent {
        const cloned = new HttpAgent({
            url: this.url,
            headers: clone(this.headers),
            fetch: this.fetch,
            agentId: this.agentId,
            description: this.description,
            threadId: this.threadId,
            initialMessages: clone(this.messages),
            initialState: clone(this.state),
        });
        cloned.subscribers = [...this.subscribers];
        cloned.isRunning = false;
        cloned.pendingInterrupts = clone(this.pendingInterrupts);
        const controller = new AbortController();
        if (this.abortController.signal.aborted) {
            controller.abort(this.abortController.signal.reason);
        }
        cloned.abortController = controller;
        return cloned;
    }

    protected requestInit(input: RunAgentInput): RequestInit {
        const cleanedMessages = (input.messages ?? []).map((msg) => stripNullSubagentRunId(msg));
        const bodyInput: RunAgentInput = {
            ...input,
            messages: cleanedMessages,
        };
        return {
            method: "POST",
            headers: {
                ...this.headers,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
            },
            body: JSON.stringify(bodyInput),
            signal: this.abortController.signal,
        };
    }

    protected prepareRunAgentInput(parameters?: RunAgentParameters): RunAgentInput {
        const clonedMessages = clone(this.messages);
        for (const msg of clonedMessages) {
            if ((msg as { subagentRunId?: unknown }).subagentRunId === null) {
                delete (msg as { subagentRunId?: unknown }).subagentRunId;
            }
        }
        const messages = clonedMessages.filter((msg) => msg.role !== "activity");
        return {
            threadId: this.threadId,
            runId: parameters?.runId || randomUUID(),
            tools: clone(parameters?.tools ?? []),
            context: clone(parameters?.context ?? []),
            forwardedProps: clone(parameters?.forwardedProps ?? {}),
            state: clone(this.state),
            messages,
            ...(parameters?.resume === undefined ? {} : { resume: clone(parameters.resume) }),
        };
    }

    run(input: RunAgentInput): RunEventStream {
        return new RunEventStream(async function* (this: HttpAgent, onCancel: (cb: () => void) => void): AsyncGenerator<AcpEvent> {
            const response = await this.fetch(this.url, this.requestInit(input));
            if (!response.ok) {
                const contentType = response.headers.get("content-type") ?? "";
                const text = await response.text();
                let payload: unknown = text;
                if (contentType.includes("application/json")) {
                    try {
                        payload = JSON.parse(text);
                    } catch {
                        // Keep raw text
                    }
                }
                const err = Object.assign(
                    new Error(`HTTP ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`),
                    { status: response.status, payload },
                );
                throw err;
            }
            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("Failed to getReader() from response");
            }
            const decoder = new TextDecoder("utf-8", { fatal: false });
            let buffer = "";
            let pendingCr = false;
            let finishedReading = false;
            onCancel(() => {
                if (!finishedReading) {
                    finishedReading = true;
                    void reader.cancel().catch(() => {});
                }
            });
            const normalizeChunk = (raw: string): string => {
                let s = raw;
                if (pendingCr) {
                    pendingCr = false;
                    if (s.startsWith("\n")) s = s.slice(1);
                    s = `\n${s}`;
                }
                if (s.endsWith("\r")) {
                    pendingCr = true;
                    s = s.slice(0, -1);
                }
                return s.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
            };
            const parseFrame = (frame: string): AcpEvent | null => {
                const lines = frame.split("\n");
                const dataLines: string[] = [];
                for (const line of lines) {
                    if (line.startsWith("data:")) {
                        dataLines.push(line.slice(5).replace(/^ /u, ""));
                    }
                }
                if (dataLines.length === 0) return null;
                const parsed: unknown = JSON.parse(dataLines.join("\n"));
                if (!isObj(parsed)) {
                    throw new Error("Invalid event: the frame is not a JSON object.");
                }
                if (!isAcpEvent(parsed)) {
                    throw new Error("Invalid event: the frame carries no event type.");
                }
                if ((parsed.type === EventType.RUN_STARTED || parsed.type === EventType.RUN_FINISHED)
                    && (typeof parsed.threadId !== "string" || typeof parsed.runId !== "string")) {
                    throw new Error("Invalid event: RUN_STARTED and RUN_FINISHED require threadId and runId.");
                }
                return parsed;
            };
            try {
                for (;;) {
                    let readResult: ReadableStreamReadResult<Uint8Array>;
                    try {
                        readResult = await reader.read();
                    } catch (error) {
                        finishedReading = true;
                        if (isObj(error) && error.name === "AbortError") {
                            yield {
                                type: EventType.RUN_ERROR,
                                message: (typeof error.message === "string" && error.message.length > 0) ? error.message : "Request aborted",
                                code: "abort",
                                rawEvent: error,
                            };
                            return;
                        }
                        throw error;
                    }
                    const { done, value } = readResult;
                    if (done) {
                        finishedReading = true;
                        buffer += normalizeChunk(decoder.decode());
                        if (pendingCr) {
                            buffer += "\n";
                            pendingCr = false;
                        }
                        if (buffer.length > 0) {
                            const trailing = parseFrame(buffer);
                            if (trailing !== null) yield trailing;
                        }
                        return;
                    }
                    if (value) {
                        buffer += normalizeChunk(decoder.decode(value, { stream: true }));
                        const parts = buffer.split("\n\n");
                        buffer = parts.pop() ?? "";
                        for (const part of parts) {
                            const ev = parseFrame(part);
                            if (ev !== null) yield ev;
                        }
                    }
                }
            } finally {
                if (!finishedReading) {
                    void reader.cancel().catch(() => {});
                }
            }
        }.bind(this));
    }

    connect(_input: RunAgentInput): RunEventStream {
        throw new Error("connect is not implemented on base HttpAgent");
    }

    async runAgent(parameters?: RunHttpAgentConfig, subscriber?: AgentSubscriber): Promise<RunAgentResult> {
        this.abortController = parameters?.abortController ?? new AbortController();
        return this.#executeAgent(parameters, subscriber, false);
    }

    async connectAgent(parameters?: RunAgentParameters, subscriber?: AgentSubscriber): Promise<RunAgentResult> {
        return this.#executeAgent(parameters, subscriber, true);
    }

    async #executeAgent(
        parameters: RunAgentParameters | undefined,
        subscriber: AgentSubscriber | undefined,
        isConnect: boolean,
    ): Promise<RunAgentResult> {
        try {
            this.isRunning = true;
            this.agentId = this.agentId ?? randomUUID();
            const input = this.prepareRunAgentInput(parameters);
            const initialMessageIds = new Set(this.messages.map((m) => m.id));
            let runResult: unknown;
            const subscribers: AgentSubscriber[] = [
                {
                    onRunFinishedEvent: (params) => {
                        if (params.outcome === "success") {
                            runResult = params.result;
                        }
                    },
                },
                ...this.subscribers,
                ...(subscriber ? [subscriber] : []),
            ];

            if (!isConnect && this.pendingInterrupts.length > 0) {
                const resumedIds = new Set((input.resume ?? []).map((r) => r.interruptId));
                const missing = this.pendingInterrupts.map((i) => i.id).filter((id) => !resumedIds.has(id));
                if (missing.length > 0) {
                    throw new Error(`Thread has ${missing.length} pending interrupt(s) not addressed by resume: ${missing.join(", ")}`);
                }
                for (const intr of this.pendingInterrupts) {
                    if (intr.expiresAt !== undefined && new Date(intr.expiresAt) <= new Date()) {
                        const entry = (input.resume ?? []).find((r) => r.interruptId === intr.id);
                        if (entry?.status !== "cancelled") {
                            throw new Error(`Interrupt ${intr.id} expired at ${intr.expiresAt} and can no longer be answered. Cancel it to continue the thread.`);
                        }
                    }
                }
            }

            await this.#notifySubscribers(subscribers, this.messages, this.state, (sub, msgs, st) =>
                sub.onRunInitialized?.({ messages: msgs, state: st, agent: this, input }),
                input,
            );

            let detached = false;
            let activeIterator: AsyncIterator<AcpEvent> | undefined;
            this.#detachCancel = () => {
                detached = true;
                void activeIterator?.return?.(undefined);
            };
            let resolveCompletion: (() => void) | undefined;
            this.#activeCompletion = new Promise<void>((resolve) => {
                resolveCompletion = resolve;
            });

            const verify = createEventVerifier();
            const startedToolCalls: string[] = [];
            const resolvedToolCalls = new Set<string>();

            try {
                const stream = isConnect ? this.connect(input) : this.run(input);
                activeIterator = stream[Symbol.asyncIterator]();
                try {
                    for (;;) {
                        const { value: rawEvent, done } = await activeIterator.next();
                        if (done || detached) break;
                        const event = verify(rawEvent);
                        await this.#applyEvent(event, input, subscribers, startedToolCalls, resolvedToolCalls);
                    }
                } finally {
                    void activeIterator.return?.(undefined);
                }
            } catch (err) {
                this.isRunning = false;
                const error = err instanceof Error ? err : new Error(String(err));
                const mutation = await this.#notifySubscribers(subscribers, this.messages, this.state, (sub, msgs, st) =>
                    sub.onRunFailed?.({ error, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mutation.stopPropagation !== true) {
                    const msg = String(error);
                    if (
                        error.name !== "AbortError"
                        && error.message !== "Fetch is aborted"
                        && error.message !== "signal is aborted without reason"
                        && error.message !== "component unmounted"
                        && msg !== "component unmounted"
                    ) {
                        throw error;
                    }
                }
            } finally {
                this.isRunning = false;
                await this.#notifySubscribers(subscribers, this.messages, this.state, (sub, msgs, st) =>
                    sub.onRunFinalized?.({ messages: msgs, state: st, agent: this, input }),
                    input,
                );
                resolveCompletion?.();
                this.#activeCompletion = null;
                this.#detachCancel = null;
            }

            const newMessages = clone(this.messages).filter((m) => !initialMessageIds.has(m.id));
            return { result: runResult, newMessages };
        } finally {
            this.isRunning = false;
        }
    }

    async #notifySubscribers(
        subscribers: readonly AgentSubscriber[],
        messages: Message[],
        state: unknown,
        invoke: (sub: AgentSubscriber, msgs: Message[], st: unknown) => MaybePromise<AgentStateMutation | void>,
        input: RunAgentInput,
    ): Promise<AgentStateMutation> {
        let currentMessages = messages;
        let currentState = state;
        let messagesMutated = false;
        let stateMutated = false;
        let stopPropagation: boolean | undefined;

        for (const sub of subscribers) {
            const res = await invoke(sub, currentMessages, currentState);
            if (!res) continue;
            if (res.messages !== undefined && res.messages !== currentMessages) {
                currentMessages = clone(res.messages);
                messagesMutated = true;
            }
            if (res.state !== undefined && res.state !== currentState) {
                currentState = clone(res.state);
                stateMutated = true;
            }
            stopPropagation = res.stopPropagation;
            if (stopPropagation === true) break;
        }

        if (messagesMutated) {
            this.messages = currentMessages;
            for (const sub of subscribers) {
                void sub.onMessagesChanged?.({ messages: this.messages, state: this.state, agent: this, input });
            }
        }
        if (stateMutated) {
            this.state = currentState;
            for (const sub of subscribers) {
                void sub.onStateChanged?.({ messages: this.messages, state: this.state, agent: this, input });
            }
        }
        return {
            ...(messagesMutated ? { messages: currentMessages } : {}),
            ...(stateMutated ? { state: currentState } : {}),
            ...(stopPropagation === undefined ? {} : { stopPropagation }),
        };
    }

    #commitMessages(messages: Message[], subscribers: readonly AgentSubscriber[], input: RunAgentInput): void {
        this.messages = messages;
        for (const sub of subscribers) {
            void sub.onMessagesChanged?.({ messages: this.messages, state: this.state, agent: this, input });
        }
    }

    #commitState(state: unknown, subscribers: readonly AgentSubscriber[], input: RunAgentInput): void {
        this.state = state;
        for (const sub of subscribers) {
            void sub.onStateChanged?.({ messages: this.messages, state: this.state, agent: this, input });
        }
    }

    async #applyEvent(
        event: AcpEvent,
        input: RunAgentInput,
        subscribers: readonly AgentSubscriber[],
        startedToolCalls: string[],
        resolvedToolCalls: Set<string>,
    ): Promise<void> {
        const generic = await this.#notifySubscribers(subscribers, this.messages, this.state, (sub, msgs, st) =>
            sub.onEvent?.({ event, agent: this, input, messages: msgs, state: st }),
            input,
        );
        if (generic.stopPropagation === true) return;

        const messages = clone(this.messages);
        let state = clone(this.state);

        switch (event.type) {
            case EventType.TEXT_MESSAGE_START: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onTextMessageStartEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                const { messageId, role = "assistant", name, subagentRunId } = event;
                const existing = messages.find((m) => m.id === messageId);
                if (existing?.role === "activity") return;
                let target: Message | undefined = existing;
                if (!target) {
                    target = {
                        id: messageId,
                        role,
                        content: "",
                        ...(name !== undefined ? { name } : {}),
                        ...(subagentRunId != null ? { subagentRunId } : {}),
                    } as Message;
                    messages.push(target);
                }
                const metaChanged = mergeMetadata(target, event);
                if (!existing || metaChanged) {
                    this.#commitMessages(messages, subscribers, input);
                }
                return;
            }
            case EventType.TEXT_MESSAGE_CONTENT: {
                const { messageId, delta } = event;
                const target = messages.find((m) => m.id === messageId);
                if (!target || target.role === "activity") return;
                const buffer = typeof target.content === "string" ? target.content : "";
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onTextMessageContentEvent?.({ event, messages: msgs, state: st, agent: this, input, textMessageBuffer: buffer }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                target.content = `${buffer}${delta}`;
                mergeMetadata(target, event);
                this.#commitMessages(messages, subscribers, input);
                return;
            }
            case EventType.TEXT_MESSAGE_END: {
                const { messageId } = event;
                const target = messages.find((m) => m.id === messageId);
                if (!target || target.role === "activity") return;
                const buffer = typeof target.content === "string" ? target.content : "";
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onTextMessageEndEvent?.({ event, messages: msgs, state: st, agent: this, input, textMessageBuffer: buffer }),
                    input,
                );
                if (mut.stopPropagation !== true && mergeMetadata(target, event)) {
                    this.#commitMessages(messages, subscribers, input);
                }
                await Promise.all(subscribers.map(async (sub) =>
                    sub.onNewMessage?.({ message: target, messages: this.messages, state: this.state, agent: this, input }),
                ));
                return;
            }
            case EventType.TOOL_CALL_START: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onToolCallStartEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                const { toolCallId, toolCallName, parentMessageId, subagentRunId } = event;
                if (!startedToolCalls.includes(toolCallId)) startedToolCalls.push(toolCallId);
                const existingCall = messages
                    .find((m): m is AssistantMessage => m.role === "assistant" && Boolean(m.toolCalls?.some((tc) => tc.id === toolCallId)))
                    ?.toolCalls?.find((tc) => tc.id === toolCallId);
                if (existingCall) {
                    const nameChanged = existingCall.function.name !== toolCallName;
                    if (nameChanged) existingCall.function.name = toolCallName;
                    if (mergeMetadata(existingCall, event) || nameChanged) {
                        this.#commitMessages(messages, subscribers, input);
                    }
                    return;
                }
                const existingIds = new Set(messages.map((m) => m.id));
                const parent = ensureAssistantMessageForToolCall(messages, parentMessageId, toolCallId);
                if (!existingIds.has(parent.id) && subagentRunId != null && parent.subagentRunId === undefined) {
                    parent.subagentRunId = subagentRunId;
                }
                parent.toolCalls ??= [];
                const call: ToolCall = {
                    id: toolCallId,
                    type: "function",
                    function: { name: toolCallName, arguments: "" },
                };
                parent.toolCalls.push(call);
                mergeMetadata(call, event);
                this.#commitMessages(messages, subscribers, input);
                return;
            }
            case EventType.TOOL_CALL_ARGS: {
                const { toolCallId, delta } = event;
                const parent = messages.find((m): m is AssistantMessage => m.role === "assistant" && Boolean(m.toolCalls?.some((tc) => tc.id === toolCallId)));
                const call = parent?.toolCalls?.find((tc) => tc.id === toolCallId);
                if (!call) return;
                let partialArgs: Record<string, unknown> = {};
                try {
                    const parsed = JSON.parse(call.function.arguments);
                    if (isObj(parsed)) partialArgs = parsed;
                } catch {
                    // Partial JSON
                }
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onToolCallArgsEvent?.({
                        event,
                        messages: msgs,
                        state: st,
                        agent: this,
                        input,
                        toolCallBuffer: call.function.arguments,
                        toolCallName: call.function.name,
                        partialToolCallArgs: partialArgs,
                    }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                call.function.arguments += delta;
                mergeMetadata(call, event);
                this.#commitMessages(messages, subscribers, input);
                return;
            }
            case EventType.TOOL_CALL_END: {
                const { toolCallId } = event;
                const parent = messages.find((m): m is AssistantMessage => m.role === "assistant" && Boolean(m.toolCalls?.some((tc) => tc.id === toolCallId)));
                const call = parent?.toolCalls?.find((tc) => tc.id === toolCallId);
                if (!call) return;
                let parsedArgs: Record<string, unknown> = {};
                try {
                    const parsed = JSON.parse(call.function.arguments);
                    if (isObj(parsed)) parsedArgs = parsed;
                } catch {
                    // Leave empty
                }
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onToolCallEndEvent?.({
                        event,
                        messages: msgs,
                        state: st,
                        agent: this,
                        input,
                        toolCallName: call.function.name,
                        toolCallArgs: parsedArgs,
                    }),
                    input,
                );
                if (mut.stopPropagation !== true && mergeMetadata(call, event)) {
                    this.#commitMessages(messages, subscribers, input);
                }
                await Promise.all(subscribers.map(async (sub) =>
                    sub.onNewToolCall?.({ toolCall: call, messages: this.messages, state: this.state, agent: this, input }),
                ));
                return;
            }
            case EventType.TOOL_CALL_RESULT: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onToolCallResultEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                const { messageId, toolCallId, content, role, subagentRunId } = event;
                resolvedToolCalls.add(toolCallId);
                const existingIndex = messages.findIndex((m) => m.id === messageId && m.role === "tool" && m.toolCallId === toolCallId);
                const existingMsg = existingIndex >= 0 ? messages[existingIndex] : undefined;
                const existingTool = existingMsg?.role === "tool" ? existingMsg : undefined;
                const toolMsg: ToolMessage = {
                    ...existingTool,
                    id: messageId,
                    toolCallId,
                    role: role ?? "tool",
                    content,
                    ...(subagentRunId != null ? { subagentRunId } : {}),
                };
                if (subagentRunId == null) delete toolMsg.subagentRunId;
                mergeMetadata(toolMsg, event);
                if (existingIndex !== -1) {
                    messages[existingIndex] = toolMsg;
                } else {
                    const parentIdx = messages.findIndex((m) => m.role === "assistant" && m.toolCalls?.some((tc) => tc.id === toolCallId));
                    if (parentIdx === -1) {
                        messages.push(toolMsg);
                    } else {
                        let insertAt = parentIdx + 1;
                        while (insertAt < messages.length && messages[insertAt]?.role === "tool") {
                            insertAt += 1;
                        }
                        messages.splice(insertAt, 0, toolMsg);
                    }
                    await Promise.all(subscribers.map(async (sub) =>
                        sub.onNewMessage?.({ message: toolMsg, messages, state, agent: this, input }),
                    ));
                }
                this.#commitMessages(messages, subscribers, input);
                return;
            }
            case EventType.STATE_SNAPSHOT: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onStateSnapshotEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                state = clone(event.snapshot);
                this.#commitState(state, subscribers, input);
                return;
            }
            case EventType.STATE_DELTA: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onStateDeltaEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                try {
                    state = applyJsonPatch(state, event.delta);
                    this.#commitState(state, subscribers, input);
                } catch (err) {
                    console.warn("Failed to apply state patch:", err);
                }
                return;
            }
            case EventType.MESSAGES_SNAPSHOT: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onMessagesSnapshotEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                const incoming = event.messages.map((m) => stripNullSubagentRunId(clone(m)));
                const byId = new Map(incoming.map((m) => [m.id, m]));
                const hasActivity = incoming.some((m) => m.role === "activity");
                const hasReasoning = incoming.some((m) => m.role === "reasoning");
                const nextMessages = messages
                    .filter((m) => byId.has(m.id) || (m.role === "activity" && !hasActivity) || (m.role === "reasoning" && !hasReasoning))
                    .map((m) => byId.get(m.id) ?? m);
                const presentIds = new Set(nextMessages.map((m) => m.id));
                for (const m of incoming) {
                    if (!presentIds.has(m.id)) nextMessages.push(m);
                }
                this.#commitMessages(nextMessages, subscribers, input);
                return;
            }
            case EventType.ACTIVITY_SNAPSHOT: {
                const idx = messages.findIndex((m) => m.id === event.messageId);
                const existing = idx >= 0 ? messages[idx] : undefined;
                const activityMsg = existing?.role === "activity" ? existing : undefined;
                const replace = event.replace ?? true;
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onActivitySnapshotEvent?.({ event, messages: msgs, state: st, agent: this, input, activityMessage: activityMsg, existingMessage: existing }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                const fresh: ActivityMessage = {
                    id: event.messageId,
                    role: "activity",
                    activityType: event.activityType,
                    content: clone(event.content),
                    ...(event.subagentRunId != null ? { subagentRunId: event.subagentRunId } : {}),
                };
                let added: ActivityMessage | undefined;
                let target: Message | undefined;
                if (idx === -1) {
                    messages.push(fresh);
                    added = fresh;
                    target = fresh;
                } else if (activityMsg) {
                    if (replace) {
                        messages[idx] = {
                            ...activityMsg,
                            activityType: event.activityType,
                            content: clone(event.content),
                            ...(event.subagentRunId != null ? { subagentRunId: event.subagentRunId } : {}),
                        };
                        if (event.subagentRunId == null) delete messages[idx].subagentRunId;
                    }
                    target = messages[idx];
                } else if (replace) {
                    messages[idx] = fresh;
                    added = fresh;
                    target = fresh;
                }
                if (target) mergeMetadata(target, event);
                this.#commitMessages(messages, subscribers, input);
                if (added) {
                    await Promise.all(subscribers.map(async (sub) =>
                        sub.onNewMessage?.({ message: added, messages: this.messages, state: this.state, agent: this, input }),
                    ));
                }
                return;
            }
            case EventType.ACTIVITY_DELTA: {
                const idx = messages.findIndex((m) => m.id === event.messageId);
                if (idx === -1) return;
                const existing = messages[idx];
                if (existing?.role !== "activity") return;
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onActivityDeltaEvent?.({ event, messages: msgs, state: st, agent: this, input, activityMessage: existing }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                try {
                    mergeMetadata(existing, event);
                    const patched = applyJsonPatch(existing.content ?? {}, event.patch ?? []);
                    if (isObj(patched)) {
                        messages[idx] = { ...existing, content: patched, activityType: event.activityType };
                        this.#commitMessages(messages, subscribers, input);
                    }
                } catch (err) {
                    console.warn(`Failed to apply activity patch for '${event.messageId}':`, err);
                }
                return;
            }
            case EventType.RAW: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onRawEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.CUSTOM: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onCustomEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.RUN_STARTED: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onRunStartedEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                startedToolCalls.length = 0;
                resolvedToolCalls.clear();
                if (mut.stopPropagation === true) return;
                if (event.input?.messages) {
                    let changed = false;
                    for (const msg of event.input.messages) {
                        const cleaned = stripNullSubagentRunId(msg);
                        if (!messages.some((m) => m.id === msg.id)) {
                            messages.push(cleaned);
                            changed = true;
                        }
                    }
                    if (changed) this.#commitMessages(messages, subscribers, input);
                }
                return;
            }
            case EventType.RUN_FINISHED: {
                const pendingToolCallIds = event.outcome?.type === "success" && event.outcome.pendingToolCallIds && event.outcome.pendingToolCallIds.length > 0
                    ? [...event.outcome.pendingToolCallIds]
                    : startedToolCalls.filter((id) => !resolvedToolCalls.has(id));
                const finishParams = event.outcome?.type === "interrupt"
                    ? { event, outcome: "interrupt" as const, interrupts: event.outcome.interrupts }
                    : event.outcome?.type === "cancelled"
                        ? { event, outcome: "cancelled" as const }
                        : { event, outcome: "success" as const, result: event.result, pendingToolCallIds };
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onRunFinishedEvent?.({ ...finishParams, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation !== true) {
                    this.pendingInterrupts = finishParams.outcome === "interrupt"
                        ? finishParams.interrupts.map((intr) => stripNullSubagentRunId(intr))
                        : [];
                }
                return;
            }
            case EventType.RUN_ERROR: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onRunErrorEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.STEP_STARTED: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onStepStartedEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.STEP_FINISHED: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onStepFinishedEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.REASONING_START: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onReasoningStartEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.REASONING_MESSAGE_START: {
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onReasoningMessageStartEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                const { messageId, subagentRunId } = event;
                const existing = messages.find((m) => m.id === messageId);
                if (existing?.role === "activity") return;
                let target = existing;
                if (!target) {
                    target = {
                        id: messageId,
                        role: "reasoning",
                        content: "",
                        ...(subagentRunId != null ? { subagentRunId } : {}),
                    };
                    messages.push(target);
                }
                const metaChanged = mergeMetadata(target, event);
                if (!existing || metaChanged) {
                    this.#commitMessages(messages, subscribers, input);
                }
                return;
            }
            case EventType.REASONING_MESSAGE_CONTENT: {
                const { messageId, delta } = event;
                const target = messages.find((m) => m.id === messageId);
                if (!target || target.role === "activity") return;
                const buffer = typeof target.content === "string" ? target.content : "";
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onReasoningMessageContentEvent?.({ event, messages: msgs, state: st, agent: this, input, reasoningMessageBuffer: buffer }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                target.content = `${buffer}${delta}`;
                mergeMetadata(target, event);
                this.#commitMessages(messages, subscribers, input);
                return;
            }
            case EventType.REASONING_MESSAGE_END: {
                const { messageId } = event;
                const target = messages.find((m) => m.id === messageId);
                if (!target || target.role === "activity") return;
                const buffer = typeof target.content === "string" ? target.content : "";
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onReasoningMessageEndEvent?.({ event, messages: msgs, state: st, agent: this, input, reasoningMessageBuffer: buffer }),
                    input,
                );
                if (mut.stopPropagation !== true && mergeMetadata(target, event)) {
                    this.#commitMessages(messages, subscribers, input);
                }
                await Promise.all(subscribers.map(async (sub) =>
                    sub.onNewMessage?.({ message: target, messages: this.messages, state: this.state, agent: this, input }),
                ));
                return;
            }
            case EventType.REASONING_END: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onReasoningEndEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.REASONING_ENCRYPTED_VALUE: {
                const { subtype, entityId, encryptedValue } = event;
                const mut = await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onReasoningEncryptedValueEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                if (mut.stopPropagation === true) return;
                let changed = false;
                if (subtype === "tool-call") {
                    for (const msg of messages) {
                        if (msg.role === "assistant" && msg.toolCalls) {
                            const call = msg.toolCalls.find((tc) => tc.id === entityId);
                            if (call) {
                                call.encryptedValue = encryptedValue;
                                changed = true;
                                break;
                            }
                        }
                    }
                } else {
                    const target = messages.find((m) => m.id === entityId);
                    if (target && target.role !== "activity") {
                        target.encryptedValue = encryptedValue;
                        changed = true;
                    }
                }
                if (changed) this.#commitMessages(messages, subscribers, input);
                return;
            }
            case EventType.SUBAGENT_STARTED: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onSubagentStartedEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.SUBAGENT_FINISHED: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onSubagentFinishedEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            case EventType.SUBAGENT_ERROR: {
                await this.#notifySubscribers(subscribers, messages, state, (sub, msgs, st) =>
                    sub.onSubagentErrorEvent?.({ event, messages: msgs, state: st, agent: this, input }),
                    input,
                );
                return;
            }
            default:
                return;
        }
    }
}

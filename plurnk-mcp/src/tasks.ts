import {
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    fromJsonSchema,
    specTypeSchemas,
    type CallToolRequest,
    type CallToolResult,
    type InputRequiredResult,
    type JsonSchemaType,
    type Progress,
    type Tool,
} from "@modelcontextprotocol/client";
import { setTimeout as delay } from "node:timers/promises";
import ExtensionChannel from "./extensionChannel.ts";
import {
    resolveInputRequests,
    runInputRequiredRequest,
    type ClientInteractionHandler,
} from "./inputRequired.ts";
import { mcpParamHeaders } from "./protocolHeaders.ts";
import { MCP_TASKS_EXTENSION_ID } from "./protocol.ts";
import Subscriptions from "./subscriptions.ts";

const DEFAULT_POLL_INTERVAL_MS = 250;
const MINIMUM_POLL_INTERVAL_MS = 10;

type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

interface Task {
    readonly taskId: string;
    readonly status: TaskStatus;
    readonly statusMessage?: string;
    readonly createdAt: string;
    readonly lastUpdatedAt: string;
    readonly ttlMs: number | null;
    readonly pollIntervalMs?: number;
}

interface InputRequiredTask extends Task {
    readonly status: "input_required";
    readonly inputRequests: Readonly<Record<string, unknown>>;
}

interface CompletedTask extends Task {
    readonly status: "completed";
    readonly result: unknown;
}

interface FailedTask extends Task {
    readonly status: "failed";
    readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
    };
}

type DetailedTask = Task | InputRequiredTask | CompletedTask | FailedTask;

interface CreateTaskResult extends Task {
    readonly resultType: "task";
}

export interface TaskCallOptions {
    readonly server: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly tool: Tool;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: Progress) => void;
    readonly interact?: ClientInteractionHandler;
    readonly timeout: number;
    readonly channel: ExtensionChannel;
    readonly subscriptions: Subscriptions;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;

const issueText = (issues: readonly { message: string; path?: readonly unknown[] }[]): string =>
    issues.map((issue) => issue.path?.length
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message).join(", ");

const protocolShapeError = (surface: string, detail: string): ProtocolError =>
    new ProtocolError(ProtocolErrorCode.InvalidRequest, `Invalid MCP Tasks ${surface}: ${detail}`);

const requireString = (
    record: Readonly<Record<string, unknown>>,
    field: string,
    surface: string,
): string => {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
        throw protocolShapeError(surface, `'${field}' must be a non-empty string.`);
    }
    return value;
};

const parseTask = (
    value: unknown,
    surface: "creation result" | "tasks/get result" | "notification",
    expectedTaskId?: string,
): Task => {
    const record = asRecord(value);
    if (record === undefined) throw protocolShapeError(surface, "expected an object.");
    if (surface === "creation result" && record.resultType !== "task") {
        throw protocolShapeError(surface, "expected resultType 'task'.");
    }
    if (surface === "tasks/get result" && record.resultType !== "complete") {
        throw protocolShapeError(surface, "expected resultType 'complete'.");
    }
    if (surface === "notification" && record.resultType !== undefined) {
        throw protocolShapeError(surface, "notifications do not carry resultType.");
    }
    const taskId = requireString(record, "taskId", surface);
    if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
        throw protocolShapeError(surface, `taskId '${taskId}' does not match '${expectedTaskId}'.`);
    }
    const status = record.status;
    if (![
        "working",
        "input_required",
        "completed",
        "failed",
        "cancelled",
    ].includes(String(status))) {
        throw protocolShapeError(surface, `'status' is not a current Tasks status.`);
    }
    const statusMessage = record.statusMessage;
    if (statusMessage !== undefined && typeof statusMessage !== "string") {
        throw protocolShapeError(surface, "'statusMessage' must be a string.");
    }
    const createdAt = requireString(record, "createdAt", surface);
    const lastUpdatedAt = requireString(record, "lastUpdatedAt", surface);
    const ttlMs = record.ttlMs;
    if (ttlMs !== null && (!Number.isSafeInteger(ttlMs) || (ttlMs as number) < 0)) {
        throw protocolShapeError(surface, "'ttlMs' must be a non-negative integer or null.");
    }
    const pollIntervalMs = record.pollIntervalMs;
    if (
        pollIntervalMs !== undefined
        && (!Number.isSafeInteger(pollIntervalMs) || (pollIntervalMs as number) < 0)
    ) {
        throw protocolShapeError(surface, "'pollIntervalMs' must be a non-negative integer.");
    }
    return {
        taskId,
        status: status as TaskStatus,
        createdAt,
        lastUpdatedAt,
        ttlMs: ttlMs as number | null,
        ...(statusMessage === undefined ? {} : { statusMessage }),
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs: pollIntervalMs as number }),
    };
};

const parseDetailedTask = (
    value: unknown,
    surface: "tasks/get result" | "notification",
    expectedTaskId: string,
): DetailedTask => {
    const task = parseTask(value, surface, expectedTaskId);
    const record = asRecord(value)!;
    if (task.status === "input_required") {
        const inputRequests = asRecord(record.inputRequests);
        if (inputRequests === undefined) {
            throw protocolShapeError(surface, "input_required status omitted 'inputRequests'.");
        }
        return { ...task, status: "input_required", inputRequests };
    }
    if (task.status === "completed") {
        if (!("result" in record)) {
            throw protocolShapeError(surface, "completed status omitted 'result'.");
        }
        return { ...task, status: "completed", result: record.result };
    }
    if (task.status === "failed") {
        const error = asRecord(record.error);
        if (
            error === undefined
            || !Number.isSafeInteger(error.code)
            || typeof error.message !== "string"
        ) {
            throw protocolShapeError(surface, "failed status omitted its JSON-RPC error.");
        }
        return {
            ...task,
            status: "failed",
            error: {
                code: error.code as number,
                message: error.message,
                ...(error.data === undefined ? {} : { data: error.data }),
            },
        };
    }
    return task;
};

const parseInputRequiredResult = (value: unknown): InputRequiredResult => {
    const record = asRecord(value);
    if (record?.resultType !== "input_required") {
        throw protocolShapeError("tools/call result", "expected resultType 'input_required'.");
    }
    const inputRequests = record.inputRequests;
    const requestState = record.requestState;
    if (inputRequests !== undefined && asRecord(inputRequests) === undefined) {
        throw protocolShapeError("tools/call result", "'inputRequests' must be an object.");
    }
    if (requestState !== undefined && typeof requestState !== "string") {
        throw protocolShapeError("tools/call result", "'requestState' must be a string.");
    }
    if (inputRequests === undefined && requestState === undefined) {
        throw protocolShapeError(
            "tools/call result",
            "input_required requires inputRequests or requestState.",
        );
    }
    return {
        resultType: "input_required",
        ...(inputRequests === undefined
            ? {}
            : { inputRequests: inputRequests as InputRequiredResult["inputRequests"] }),
        ...(requestState === undefined ? {} : { requestState }),
    };
};

const parseCallToolResult = async (value: unknown): Promise<CallToolResult> => {
    const record = asRecord(value);
    if (record?.resultType !== "complete") {
        throw protocolShapeError("tools/call result", "expected resultType 'complete'.");
    }
    const parsed = specTypeSchemas.CallToolResult["~standard"].validate(value);
    if (parsed.issues !== undefined) {
        throw protocolShapeError("tools/call result", issueText(parsed.issues));
    }
    return parsed.value;
};

const validateToolInput = async (
    tool: Tool,
    args: Record<string, unknown>,
): Promise<void> => {
    const validator = fromJsonSchema(tool.inputSchema as JsonSchemaType);
    const parsed = await validator["~standard"].validate(args);
    if (parsed.issues !== undefined) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Invalid arguments for MCP tool '${tool.name}': ${issueText(parsed.issues)}.`,
        );
    }
};

const validateToolOutput = async (
    tool: Tool,
    value: unknown,
): Promise<CallToolResult> => {
    const result = await parseCallToolResult({
        ...(asRecord(value) ?? {}),
        resultType: "complete",
    });
    if (tool.outputSchema === undefined || result.isError === true) return result;
    if (result.structuredContent === undefined) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            `Tool '${tool.name}' has an output schema but did not return structured content.`,
        );
    }
    const validator = fromJsonSchema(tool.outputSchema as JsonSchemaType);
    const parsed = await validator["~standard"].validate(result.structuredContent);
    if (parsed.issues !== undefined) {
        throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            `Tool '${tool.name}' returned invalid structured content: ${issueText(parsed.issues)}.`,
        );
    }
    return result;
};

const taskAwareToolLeg = async (
    channel: ExtensionChannel,
    tool: Tool,
    params: CallToolRequest["params"],
    signal: AbortSignal | undefined,
    timeout: number,
    onProgress: ((progress: Progress) => void) | undefined,
): Promise<CallToolResult | InputRequiredResult | CreateTaskResult> => {
    const value = await channel.request("tools/call", params, {
        signal,
        timeout,
        onProgress,
        cancelRequestOnSharedTransport: true,
        headers: mcpParamHeaders(tool, params.arguments ?? {}),
    });
    const resultType = asRecord(value)?.resultType;
    if (resultType === "task") {
        return {
            ...parseTask(value, "creation result"),
            resultType: "task",
        };
    }
    if (resultType === "input_required") return parseInputRequiredResult(value);
    return parseCallToolResult(value);
};

const remainingTimeout = (deadline: number, operation: string): number => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        throw new SdkError(
            SdkErrorCode.RequestTimeout,
            `MCP '${operation}' exceeded its operation timeout.`,
        );
    }
    return remaining;
};

const taskRequest = async (
    channel: ExtensionChannel,
    method: "tasks/get" | "tasks/update" | "tasks/cancel",
    params: Readonly<Record<string, unknown>>,
    timeout: number,
    signal?: AbortSignal,
): Promise<unknown> => channel.request(method, params, { signal, timeout });

const cancelTask = async (
    channel: ExtensionChannel,
    taskId: string,
    timeout: number,
): Promise<void> => {
    const result = asRecord(await taskRequest(channel, "tasks/cancel", { taskId }, timeout));
    if (result?.resultType !== "complete") {
        throw protocolShapeError("tasks/cancel result", "expected resultType 'complete'.");
    }
};

class TaskInbox {
    readonly #taskId: string;
    readonly #queue: unknown[] = [];
    #wake: (() => void) | undefined;

    constructor(taskId: string) {
        this.#taskId = taskId;
    }

    push(value: unknown): void {
        if (asRecord(value)?.taskId !== this.#taskId) return;
        this.#queue.push(value);
        this.#wake?.();
    }

    async next(waitMs: number, signal?: AbortSignal): Promise<unknown | undefined> {
        if (this.#queue.length > 0) return this.#queue.shift();
        const controller = new AbortController();
        const wake = Promise.withResolvers<void>();
        this.#wake = wake.resolve;
        const onAbort = (): void => controller.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            await Promise.race([
                wake.promise,
                delay(waitMs, undefined, { signal: controller.signal }).catch((cause: unknown) => {
                    if (!controller.signal.aborted) throw cause;
                }),
            ]);
        } finally {
            this.#wake = undefined;
            signal?.removeEventListener("abort", onAbort);
            controller.abort();
        }
        signal?.throwIfAborted();
        return this.#queue.shift();
    }
}

const driveTask = async (
    task: CreateTaskResult,
    options: TaskCallOptions,
    deadline: number,
): Promise<CallToolResult> => {
    const inbox = new TaskInbox(task.taskId);
    const stopWatching = options.channel.onTaskNotification((value) => inbox.push(value));
    const release = await options.subscriptions.selectTask(task.taskId);
    const answered = new Set<string>();
    let state: Task | DetailedTask = task;
    let terminal = false;
    try {
        while (true) {
            options.signal?.throwIfAborted();
            if (state.status === "completed" && "result" in state) {
                terminal = true;
                return validateToolOutput(options.tool, state.result);
            }
            if (state.status === "failed" && "error" in state) {
                terminal = true;
                throw ProtocolError.fromError(
                    state.error.code,
                    state.error.message,
                    state.error.data,
                );
            }
            if (state.status === "cancelled") {
                terminal = true;
                throw new Error(
                    `MCP task '${state.taskId}' was cancelled${state.statusMessage === undefined ? "." : `: ${state.statusMessage}`}`,
                );
            }
            if (state.status === "input_required" && "inputRequests" in state) {
                const fresh = Object.fromEntries(Object.entries(state.inputRequests)
                    .filter(([key]) => !answered.has(key)));
                if (Object.keys(fresh).length > 0) {
                    const responses = await resolveInputRequests({
                        server: options.server,
                        operation: "tasks/update",
                        inputRequests: fresh,
                        interact: options.interact,
                        arguments: { taskId: task.taskId },
                    });
                    options.signal?.throwIfAborted();
                    const update = asRecord(await taskRequest(
                        options.channel,
                        "tasks/update",
                        { taskId: task.taskId, inputResponses: responses },
                        remainingTimeout(deadline, "tasks/update"),
                        options.signal,
                    ));
                    if (update?.resultType !== "complete") {
                        throw protocolShapeError(
                            "tasks/update result",
                            "expected resultType 'complete'.",
                        );
                    }
                    for (const key of Object.keys(fresh)) answered.add(key);
                }
            }

            const interval = state.status === "working"
                || (state.status === "input_required" && "inputRequests" in state)
                ? Math.max(MINIMUM_POLL_INTERVAL_MS, state.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
                : 0;
            const remaining = remainingTimeout(deadline, "Task");
            const notification = await inbox.next(Math.min(interval, remaining), options.signal);
            if (notification !== undefined) {
                state = parseDetailedTask(notification, "notification", task.taskId);
                continue;
            }
            const result = await taskRequest(
                options.channel,
                "tasks/get",
                { taskId: task.taskId },
                remainingTimeout(deadline, "tasks/get"),
                options.signal,
            );
            state = parseDetailedTask(result, "tasks/get result", task.taskId);
        }
    } catch (cause) {
        if (!terminal) {
            try {
                await cancelTask(options.channel, task.taskId, options.timeout);
            } catch (cancellationFailure) {
                throw new AggregateError(
                    [cause, cancellationFailure],
                    `MCP task '${task.taskId}' failed and cancellation also failed.`,
                );
            }
        }
        throw cause;
    } finally {
        stopWatching();
        await release();
    }
};

export const serverSupportsTasks = (capabilities: unknown): boolean => {
    const extension = asRecord(asRecord(capabilities)?.extensions)?.[MCP_TASKS_EXTENSION_ID];
    return asRecord(extension) !== undefined;
};

export const callToolWithTasks = async (options: TaskCallOptions): Promise<CallToolResult> => {
    await validateToolInput(options.tool, options.args);
    const startedAt = Date.now();
    const initial = await runInputRequiredRequest<
        CallToolResult | CreateTaskResult,
        CallToolRequest["params"]
    >({
        server: options.server,
        operation: "tools/call",
        originalParams: { name: options.name, arguments: options.args },
        signal: options.signal,
        onProgress: options.onProgress,
        interact: options.interact,
        timeout: options.timeout,
        requestLeg: (params, requestOptions) => taskAwareToolLeg(
            options.channel,
            options.tool,
            params,
            requestOptions.signal,
            requestOptions.timeout,
            requestOptions.onprogress,
        ),
    });
    if ((initial as { resultType?: unknown }).resultType === "task") {
        return driveTask(initial as CreateTaskResult, options, startedAt + options.timeout);
    }
    return validateToolOutput(options.tool, initial);
};

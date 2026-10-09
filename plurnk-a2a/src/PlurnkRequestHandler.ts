import {
    TaskState,
    type AgentCard,
    type CancelTaskRequest,
    type GetTaskRequest,
    type ListTaskPushNotificationConfigsResponse,
    type ListTasksRequest,
    type ListTasksResponse,
    type SendMessageRequest,
    type StreamResponse,
    type SubscribeToTaskRequest,
    type Task,
    type TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
    ExtensionSupportRequiredError,
    PushNotificationNotSupportedError,
    RequestMalformedError,
    TaskNotCancelableError,
    TaskNotFoundError,
    UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type TaskAdmission from "./TaskAdmission.ts";
import type HostedTasks from "./HostedTasks.ts";
import TaskObservation, { type ObservationPort } from "./TaskObservation.ts";

export type RequestHandlerPort = ObservationPort & Pick<ApplicationPort, "cancelWorker">;

const historyLength = (length: number | undefined): void => {
    if (length !== undefined && (!Number.isInteger(length) || length < 0)) {
        throw new RequestMalformedError("historyLength must be a non-negative integer.");
    }
};

const history = (task: Task, length: number | undefined): Task => length === undefined ? task
    : { ...task, history: length === 0 ? [] : task.history.slice(-length) };

// {§a2a-inbound-exposure} The SDK owns the wire; Core owns execution and durable truth.
export default class PlurnkRequestHandler implements A2ARequestHandler {
    readonly #card: AgentCard;
    readonly #tasks: HostedTasks;
    readonly #admission: TaskAdmission;
    readonly #observation: TaskObservation;
    readonly #port: RequestHandlerPort;
    readonly #pending = new Set<Promise<unknown>>();
    #closed = false;

    constructor(card: AgentCard, tasks: HostedTasks, admission: TaskAdmission, port: RequestHandlerPort) {
        this.#card = card;
        this.#tasks = tasks;
        this.#admission = admission;
        this.#port = port;
        this.#observation = new TaskObservation(port, tasks);
    }

    async getAgentCard(): Promise<AgentCard> { return this.#card; }

    async close(): Promise<void> {
        this.#closed = true;
        try { await this.#observation.close(); }
        // Request failures go to their callers unchanged; shutdown joins their completion.
        finally { await Promise.allSettled(this.#pending); }
    }

    async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> {
        throw new UnsupportedOperationError("Agent does not support authenticated extended card.");
    }

    async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
        this.#validateSend(params, context);
        for await (const task of this.#observation.follow(() => this.#admission.admit(params), context)) {
            if (params.configuration?.returnImmediately === true || TaskObservation.terminal(task)) {
                return history(task, params.configuration?.historyLength);
            }
        }
        throw new Error("A2A observation ended without a Task result.");
    }

    async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
        this.#validateSend(params, context);
        yield* this.#stream(() => this.#admission.admit(params), context, params.configuration?.historyLength);
    }

    async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
        return this.#request(async () => {
            historyLength(params.historyLength);
            return history(await this.#task(params.id, context), params.historyLength);
        });
    }

    async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
        return this.#request(async () => {
            historyLength(params.historyLength);
            if (params.pageSize !== undefined && (!Number.isInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 100)) {
                throw new RequestMalformedError("pageSize must be between 1 and 100.");
            }
            if (!Number.isInteger(params.status) || params.status < TaskState.TASK_STATE_UNSPECIFIED || params.status > TaskState.TASK_STATE_AUTH_REQUIRED) {
                throw new RequestMalformedError("Invalid status filter.");
            }
            if (params.statusTimestampAfter !== undefined && Number.isNaN(Date.parse(params.statusTimestampAfter))) {
                throw new RequestMalformedError("statusTimestampAfter must be a valid ISO 8601 date string.");
            }
            const result = await this.#tasks.list(params, context);
            return { ...result, tasks: result.tasks.map((task) => history(task, params.historyLength)) };
        });
    }

    async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
        return this.#request(async () => {
            const task = await this.#task(params.id, context);
            if (task.status?.state === TaskState.TASK_STATE_CANCELED) return task;
            if (TaskObservation.terminal(task)) throw new TaskNotCancelableError(`Task not cancelable: ${params.id}`);
            const binding = await this.#tasks.binding(params.id);
            if (binding === null) throw new TaskNotFoundError(`Task not found: ${params.id}`);
            await this.#port.cancelWorker({ workspaceId: binding.workspaceId, workerId: binding.worker.id, reason: "A2A caller cancelled the Task" });
            const settled = await this.#task(params.id, context);
            if (settled.status?.state !== TaskState.TASK_STATE_CANCELED) throw new TaskNotCancelableError(`Task not cancelable: ${params.id}`);
            return settled;
        });
    }

    async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
        this.#validateContext(context);
        if (!params.id) throw new RequestMalformedError("Task id is required.");
        yield* this.#stream(async () => params.id, context, undefined, true);
    }

    async createTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> { throw new PushNotificationNotSupportedError(); }
    async getTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> { throw new PushNotificationNotSupportedError(); }
    async listTaskPushNotificationConfigs(): Promise<ListTaskPushNotificationConfigsResponse> { throw new PushNotificationNotSupportedError(); }
    async deleteTaskPushNotificationConfig(): Promise<void> { throw new PushNotificationNotSupportedError(); }

    async *#stream(start: () => Promise<string>, context: ServerCallContext, length?: number, resubscribe = false): AsyncGenerator<StreamResponse> {
        let previous: Task | null = null;
        const artifacts = new Set<string>();
        for await (const task of this.#observation.follow(start, context)) {
            if (previous === null) {
                if (resubscribe && TaskObservation.terminal(task)) {
                    throw new UnsupportedOperationError(`Task '${task.id}' is in a terminal state and cannot be subscribed to.`);
                }
                for (const artifact of task.artifacts) artifacts.add(artifact.artifactId);
                yield { payload: { $case: "task", value: history(task, length) } };
            } else {
                for (const artifact of task.artifacts) {
                    if (artifacts.has(artifact.artifactId)) continue;
                    artifacts.add(artifact.artifactId);
                    yield { payload: { $case: "artifactUpdate", value: {
                        taskId: task.id, contextId: task.contextId, artifact,
                        append: false, lastChunk: true, metadata: {},
                    } } };
                }
                if (JSON.stringify(task.status) !== JSON.stringify(previous.status)) {
                    yield { payload: { $case: "statusUpdate", value: {
                        taskId: task.id, contextId: task.contextId, status: task.status, metadata: {},
                    } } };
                }
            }
            previous = task;
        }
    }

    async #task(id: string, context: ServerCallContext): Promise<Task> {
        this.#validateContext(context);
        if (!id) throw new RequestMalformedError("Task id is required.");
        const task = await this.#tasks.load(id, context);
        if (task === undefined) throw new TaskNotFoundError(`Task not found: ${id}`);
        return task;
    }

    async #request<T>(work: () => Promise<T>): Promise<T> {
        if (this.#closed) throw new Error("A2A request handler is closed.");
        const result = work();
        this.#pending.add(result);
        try { return await result; }
        finally { this.#pending.delete(result); }
    }

    #validateContext(context: ServerCallContext): void {
        if ((context.tenant ?? "") !== "") throw new RequestMalformedError("This A2A exposure does not define tenant routing.");
    }

    #validateSend(params: SendMessageRequest, context: ServerCallContext): void {
        this.#validateContext(context);
        historyLength(params.configuration?.historyLength);
        const missing = (this.#card.capabilities?.extensions ?? [])
            .filter((extension) => extension.required && !context.requestedExtensions?.includes(extension.uri));
        if (missing.length > 0) {
            throw new ExtensionSupportRequiredError(`Client must declare support for required extensions: ${missing.map(({ uri }) => uri).join(", ")}`);
        }
    }
}

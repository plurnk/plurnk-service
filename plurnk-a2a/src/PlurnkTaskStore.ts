import {
    Role,
    TaskState,
    type Artifact,
    type Message,
    type Task,
} from "@a2a-js/sdk";
import {
    type ServerCallContext,
    type TaskStore,
} from "@a2a-js/sdk/server";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import type {
    ApplicationLoopProjection,
    ApplicationPort,
    ApplicationWorkerProjection,
    ClientInteractionProjection,
    LogEntryWire,
    OperationResult,
} from "@plurnk/plurnk-contracts";

export interface PlurnkTaskBinding {
    readonly context: ApplicationWorkerProjection;
    readonly task: ApplicationWorkerProjection;
    readonly loop: ApplicationLoopProjection | null;
}

interface LogRow extends LogEntryWire {
    readonly id?: unknown;
    readonly loop_id?: unknown;
    readonly op?: unknown;
    readonly rx?: unknown;
    readonly mimetype_rx?: unknown;
    readonly source?: unknown;
}

const nonempty = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

const message = (
    messageId: string,
    contextId: string,
    taskId: string,
    role: Role,
    content: string,
    mediaType = "text/plain",
): Message => ({
    messageId,
    contextId,
    taskId,
    role,
    parts: [{
        content: { $case: "text", value: content },
        filename: "",
        mediaType,
        metadata: {},
    }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
});

const messageIdFromSource = (source: unknown, fallback: string): string => {
    if (!nonempty(source)) return fallback;
    try {
        const segments = new URL(source).pathname.split("/").filter(Boolean);
        const marker = segments.lastIndexOf("messages");
        return marker >= 0 && nonempty(segments[marker + 1])
            ? decodeURIComponent(segments[marker + 1]!)
            : fallback;
    } catch {
        return fallback;
    }
};

const terminalArtifact = (result: OperationResult | null): Artifact[] => {
    if (result === null || result.status < 200 || result.status >= 400) return [];
    if (!nonempty(result.content)) return [];
    return [{
        artifactId: "result",
        name: "Result",
        description: "The terminal Plurnk SEND deliverable.",
        parts: [{
            content: { $case: "text", value: result.content },
            filename: "",
            mediaType: nonempty(result.mimetype) ? result.mimetype : "text/markdown",
            metadata: {},
        }],
        metadata: {},
        extensions: [],
    }];
};

export default class PlurnkTaskStore implements TaskStore {
    readonly #port: ApplicationPort;
    readonly #workspaceId: number;

    constructor(port: ApplicationPort, workspaceId: number) {
        this.#port = port;
        this.#workspaceId = workspaceId;
    }

    async binding(taskId: string): Promise<PlurnkTaskBinding | null> {
        const task = await this.#port.readWorker({
            workspaceId: this.#workspaceId,
            identity: { name: taskId },
        });
        if (task === null || task.origin !== "model" || task.parentWorkerId === null) return null;
        const context = await this.#port.readWorker({
            workspaceId: this.#workspaceId,
            identity: { id: task.parentWorkerId },
        });
        if (context === null || context.origin !== "model" || context.parentWorkerId !== null) {
            throw new Error(`A2A Task '${taskId}' has no unique root Context worker.`);
        }
        const loops = await this.#port.listWorkerLoops({
            workspaceId: this.#workspaceId,
            workerId: task.id,
        });
        const loop = loops
            .filter(({ promptSource }) => PlurnkTaskStore.#ownsSource(
                promptSource,
                context.name,
                task.name,
            ))
            .at(-1) ?? null;
        if (loop === null) return null;
        return { context, task, loop };
    }

    async ownsContext(context: ApplicationWorkerProjection): Promise<boolean> {
        if (context.origin !== "model" || context.parentWorkerId !== null) return false;
        const children = await this.#port.listWorkers(this.#workspaceId, {
            origin: "model",
            parentWorkerId: context.id,
        });
        for (const child of children) {
            if (await this.binding(child.name) !== null) return true;
        }
        return false;
    }

    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
        this.#assertTenant(context);
        const binding = await this.binding(taskId);
        return binding === null ? undefined : await this.#project(binding);
    }

    async save(task: Task, context: ServerCallContext): Promise<void> {
        this.#assertTenant(context);
        const binding = await this.binding(task.id);
        if (binding === null) {
            // The SDK turns an executor-side admission rejection into an
            // ephemeral FAILED Task event. It is protocol evidence, not
            // authority to create a second Task store or adopt a Worker.
            if (task.status?.state === TaskState.TASK_STATE_FAILED) return;
            throw new Error(`A2A Task '${task.id}' has no Plurnk worker.`);
        }
        if (binding.context.name !== task.contextId) {
            throw new Error(
                `A2A Task '${task.id}' belongs to Context '${binding.context.name}', not '${task.contextId}'.`,
            );
        }
        // Core state is authoritative. SDK merge writes validate identity but
        // never create a parallel Task lifecycle in this projection store.
        if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
            await this.#port.cancelWorker({
                workspaceId: this.#workspaceId,
                workerId: binding.task.id,
                reason: "A2A caller cancelled the Task",
            });
        }
    }

    async list(
        params: import("@a2a-js/sdk").ListTasksRequest,
        context: ServerCallContext,
    ): Promise<import("@a2a-js/sdk").ListTasksResponse> {
        this.#assertTenant(context);
        const pageSize = params.pageSize ?? 50;
        const offset = params.pageToken.length === 0 ? 0 : Number(params.pageToken);
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new RequestMalformedError("pageToken must be an empty string or a non-negative integer offset.");
        }

        let taskWorkers: ApplicationWorkerProjection[];
        if (params.contextId.length > 0) {
            const contextWorker = await this.#port.readWorker({
                workspaceId: this.#workspaceId,
                identity: { name: params.contextId },
            });
            if (
                contextWorker === null
                || contextWorker.origin !== "model"
                || contextWorker.parentWorkerId !== null
            ) {
                taskWorkers = [];
            } else {
                taskWorkers = await this.#port.listWorkers(this.#workspaceId, {
                    origin: "model",
                    parentWorkerId: contextWorker.id,
                });
            }
        } else {
            taskWorkers = (await this.#port.listWorkers(this.#workspaceId, { origin: "model" }))
                .filter(({ parentWorkerId }) => parentWorkerId !== null);
        }

        const projected = (await Promise.all(taskWorkers.map(({ name }) => this.load(name, context))))
            .filter((task): task is Task => task !== undefined)
            .filter((task) => params.status === TaskState.TASK_STATE_UNSPECIFIED
                || task.status?.state === params.status)
            .filter((task) => params.statusTimestampAfter === undefined
                || (task.status?.timestamp !== undefined
                    && Date.parse(task.status.timestamp) >= Date.parse(params.statusTimestampAfter)))
            .map((task) => params.includeArtifacts === true ? task : { ...task, artifacts: [] });
        const tasks = projected.slice(offset, offset + pageSize);
        const next = offset + tasks.length;
        return {
            tasks,
            nextPageToken: next < projected.length ? String(next) : "",
            pageSize,
            totalSize: projected.length,
        };
    }

    async #project(binding: PlurnkTaskBinding): Promise<Task> {
        const { context, task, loop } = binding;
        if (loop === null) {
            return {
                id: task.name,
                contextId: context.name,
                status: {
                    state: TaskState.TASK_STATE_SUBMITTED,
                    message: undefined,
                    timestamp: undefined,
                },
                artifacts: [],
                history: [],
                metadata: {},
            };
        }
        const [rows, interactions] = await Promise.all([
            this.#port.readLog({
                workspaceId: this.#workspaceId,
                workerId: task.id,
                loopId: loop.id,
                limit: 1000,
            }) as Promise<LogRow[]>,
            this.#port.pendingClientInteractions(this.#workspaceId),
        ]);
        const pending = interactions.find((candidate) =>
            candidate.workerId === task.id && candidate.loopId === loop.id) ?? null;
        const state = PlurnkTaskStore.#state(loop.status, pending);
        const statusMessage = PlurnkTaskStore.#statusMessage(
            context.name,
            task.name,
            loop.terminalResult,
            pending,
        );
        const history = rows
            .filter((row) => row.loop_id === loop.id && row.op === "prompt" && nonempty(row.rx))
            .toSorted((left, right) => Number(left.id) - Number(right.id))
            .map((row) => message(
                messageIdFromSource(row.source, `plurnk-log-${String(row.id)}`),
                context.name,
                task.name,
                Role.ROLE_USER,
                row.rx as string,
                nonempty(row.mimetype_rx) ? row.mimetype_rx : "text/markdown",
            ));
        return {
            id: task.name,
            contextId: context.name,
            status: {
                state,
                message: statusMessage,
                timestamp: loop.terminatedAt ?? undefined,
            },
            artifacts: terminalArtifact(loop.terminalResult),
            history,
            metadata: {},
        };
    }

    #assertTenant(context: ServerCallContext): void {
        if ((context.tenant ?? "") !== "") {
            throw new RequestMalformedError("This A2A exposure does not define tenant routing.");
        }
    }

    static #state(status: number, pending: ClientInteractionProjection | null): TaskState {
        if (pending !== null) return TaskState.TASK_STATE_INPUT_REQUIRED;
        if (status === 100) return TaskState.TASK_STATE_SUBMITTED;
        if (status === 102 || status === 202) return TaskState.TASK_STATE_WORKING;
        if (status === 200) return TaskState.TASK_STATE_COMPLETED;
        if (status === 499) return TaskState.TASK_STATE_CANCELED;
        return TaskState.TASK_STATE_FAILED;
    }

    static #statusMessage(
        contextId: string,
        taskId: string,
        result: OperationResult | null,
        pending: ClientInteractionProjection | null,
    ): Message | undefined {
        if (pending !== null) {
            return message(
                `plurnk-interaction-${pending.interactionId}`,
                contextId,
                taskId,
                Role.ROLE_AGENT,
                pending.request.message ?? `${pending.request.toolName} requires input.`,
            );
        }
        const detail = result?.problem?.detail;
        return nonempty(detail)
            ? message(`plurnk-terminal-${taskId}`, contextId, taskId, Role.ROLE_AGENT, detail)
            : undefined;
    }

    static #ownsSource(source: string | null, contextId: string, taskId: string): boolean {
        if (source === null) return false;
        try {
            const url = new URL(source);
            const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
            return url.protocol === "a2a:"
                && segments.length === 6
                && segments[0] === "contexts"
                && segments[1] === contextId
                && segments[2] === "tasks"
                && segments[3] === taskId
                && segments[4] === "messages"
                && segments[5]!.length > 0;
        } catch {
            return false;
        }
    }
}

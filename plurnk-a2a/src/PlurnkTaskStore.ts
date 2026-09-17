import { createHash } from "node:crypto";
import {
    Role,
    TaskState,
    type Artifact,
    Message,
    type Task,
} from "@a2a-js/sdk";
import {
    type ServerCallContext,
    type TaskStore,
} from "@a2a-js/sdk/server";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import {
    WORKER_NAME,
    type ApplicationLoopProjection,
    type ApplicationPort,
    type ApplicationWorkerProjection,
    type ClientInteractionProjection,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import type WorkspaceBinding from "./WorkspaceBinding.ts";

export interface PlurnkTaskBinding {
    readonly workspaceId: number;
    readonly context: ApplicationWorkerProjection;
    readonly task: ApplicationWorkerProjection;
    readonly loop: ApplicationLoopProjection | null;
}

const nonempty = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;

type TaskCursor = readonly [timestamp: number, id: string];

const taskCursor = (task: Task): TaskCursor => [
    task.status?.timestamp === undefined ? 0 : Date.parse(task.status.timestamp),
    task.id,
];

const compareCursor = (left: TaskCursor, right: TaskCursor): number =>
    right[0] - left[0] || (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0);

const decodeCursor = (token: string): TaskCursor | null => {
    if (token.length === 0) return null;
    try {
        const bytes = Buffer.from(token, "base64url");
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (bytes.toString("base64url") !== token
            || !Array.isArray(value) || value.length !== 2
            || !Number.isSafeInteger(value[0]) || value[0] < 0
            || !nonempty(value[1])) {
            throw new TypeError("Invalid Task cursor.");
        }
        return [value[0] as number, value[1]];
    } catch (cause) {
        throw new RequestMalformedError({ message: "pageToken is not a valid Task cursor.", cause });
    }
};

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

const terminalArtifact = (result: OperationResult | null, content: string | undefined): Artifact[] => {
    if (result === null || result.status < 200 || result.status >= 400) return [];
    if (!nonempty(content)) return [];
    return [{
        artifactId: "result",
        name: "Result",
        description: "The final delivered reply.",
        parts: [{
            content: { $case: "text", value: content },
            filename: "",
            mediaType: "text/markdown",
            metadata: {},
        }],
        metadata: {},
        extensions: [],
    }];
};

export default class PlurnkTaskStore implements TaskStore {
    readonly #port: ApplicationPort;
    readonly #workspace: WorkspaceBinding;

    constructor(port: ApplicationPort, workspace: WorkspaceBinding) {
        this.#port = port;
        this.#workspace = workspace;
    }

    async binding(taskId: string): Promise<PlurnkTaskBinding | null> {
        // This exposure only mints {§worker-name} identities. Other opaque A2A IDs
        // cannot identify one of its Tasks; they are not malformed Core calls.
        if (!WORKER_NAME.test(taskId)) return null;
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return null;
        const task = await this.#port.readWorker({
            workspaceId,
            identity: { name: taskId },
        });
        if (task === null || task.origin !== "model" || task.parentWorkerId === null) return null;
        const context = await this.#port.readWorker({
            workspaceId,
            identity: { id: task.parentWorkerId },
        });
        if (context === null || context.origin !== "model" || context.parentWorkerId !== null) {
            throw new Error(`A2A Task '${taskId}' has no unique root Context worker.`);
        }
        const loops = await this.#port.listWorkerLoops({
            workspaceId,
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
        return { workspaceId, context, task, loop };
    }

    async ownsContext(context: ApplicationWorkerProjection): Promise<boolean> {
        if (context.origin !== "model" || context.parentWorkerId !== null) return false;
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return false;
        const children = await this.#port.listWorkers(workspaceId, {
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
                workspaceId: binding.workspaceId,
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
        const cursor = decodeCursor(params.pageToken);
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };

        let taskWorkers: ApplicationWorkerProjection[];
        if (params.contextId.length > 0) {
            if (!WORKER_NAME.test(params.contextId)) {
                return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };
            }
            const contextWorker = await this.#port.readWorker({
                workspaceId,
                identity: { name: params.contextId },
            });
            if (
                contextWorker === null
                || contextWorker.origin !== "model"
                || contextWorker.parentWorkerId !== null
            ) {
                taskWorkers = [];
            } else {
                taskWorkers = await this.#port.listWorkers(workspaceId, {
                    origin: "model",
                    parentWorkerId: contextWorker.id,
                });
            }
        } else {
            taskWorkers = (await this.#port.listWorkers(workspaceId, { origin: "model" }))
                .filter(({ parentWorkerId }) => parentWorkerId !== null);
        }

        const projected = (await Promise.all(taskWorkers.map(({ name }) => this.load(name, context))))
            .filter((task): task is Task => task !== undefined)
            .filter((task) => params.status === TaskState.TASK_STATE_UNSPECIFIED
                || task.status?.state === params.status)
            .filter((task) => params.statusTimestampAfter === undefined
                || (task.status?.timestamp !== undefined
                    && Date.parse(task.status.timestamp) >= Date.parse(params.statusTimestampAfter)))
            .toSorted((left, right) => compareCursor(taskCursor(left), taskCursor(right)))
            .map((task) => params.includeArtifacts === true ? task : { ...task, artifacts: [] });
        const remaining = cursor === null
            ? projected
            : projected.filter((task) => compareCursor(taskCursor(task), cursor) > 0);
        const tasks = remaining.slice(0, pageSize);
        const last = tasks.at(-1);
        return {
            tasks,
            nextPageToken: last !== undefined && remaining.length > tasks.length
                ? Buffer.from(JSON.stringify(taskCursor(last))).toString("base64url")
                : "",
            pageSize,
            totalSize: projected.length,
        };
    }

    async #project(binding: PlurnkTaskBinding): Promise<Task> {
        const { workspaceId, context, task, loop } = binding;
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
            this.#port.readMessages({
                workspaceId,
                workerId: task.id,
            }),
            this.#port.pendingClientInteractions(workspaceId),
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
            .filter((row) => row.direction === "inbound"
                && typeof row.source === "string"
                && PlurnkTaskStore.#ownsSource(row.source, context.name, task.name))
            .map((row) => {
                if (row.envelope === undefined) throw new Error(`A2A message ${row.id} lost its protocol envelope.`);
                return Message.fromJSON(row.envelope);
            });
        const replies = rows.filter((row) => row.direction === "outbound"
            && row.answers.some((address) => PlurnkTaskStore.#ownsSource(address, context.name, task.name)));
        const artifacts: Artifact[] = replies
            .flatMap((row) => row.attachments.map((attachment, index) => ({
                artifactId: createHash("sha256").update(`${task.name}/${row.id}/${index}`).digest("hex").slice(0, 8),
                name: attachment.name,
                description: "",
                parts: [{ content: { $case: "raw" as const, value: Buffer.from(attachment.bytes) },
                    filename: attachment.name, mediaType: attachment.mediaType, metadata: {} }],
                metadata: {}, extensions: [],
            })));
        return {
            id: task.name,
            contextId: context.name,
            status: {
                state,
                message: statusMessage,
                timestamp: loop.terminatedAt ?? undefined,
            },
            artifacts: [...terminalArtifact(loop.terminalResult, replies.findLast((row) =>
                row.loopId === loop.id && nonempty(row.body))?.body), ...artifacts],
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

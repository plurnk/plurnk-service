import { createHash } from "node:crypto";
import {
    Role,
    TaskState,
    type Artifact,
    SendMessageRequest,
    type Message,
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
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import type WorkspaceBinding from "./WorkspaceBinding.ts";

// A2A ListTasks: a request that names no page size asks for fifty. The protocol's, not ours.
const UNSPECIFIED_PAGE = 50;

// {§a2a-inbound-exposure} A Task is a Loop of its Context worker.
export interface PlurnkTaskBinding {
    readonly workspaceId: number;
    readonly context: ApplicationWorkerProjection;
    readonly taskId: string;
    readonly loop: ApplicationLoopProjection;
}

const OPEN_LOOP = new Set([100, 102, 202]);

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

// The port functions the store calls.
export type TaskStorePort = Pick<ApplicationPort,
    "cancelWorker" | "listWorkerLoops" | "listWorkers" | "readMessages" | "readWorker">;

export default class PlurnkTaskStore implements TaskStore {
    readonly #port: TaskStorePort;
    readonly #workspace: WorkspaceBinding;

    constructor(port: TaskStorePort, workspace: WorkspaceBinding) {
        this.#port = port;
        this.#workspace = workspace;
    }

    // A Task is open while its Loop is queued, running, or parked.
    static open(loop: ApplicationLoopProjection): boolean {
        return OPEN_LOOP.has(loop.status);
    }

    async binding(taskId: string): Promise<PlurnkTaskBinding | null> {
        // Identities this exposure never mints cannot name one of its Tasks;
        // they are not malformed Core calls.
        if (!WORKER_NAME.test(taskId)) return null;
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return null;
        for (const context of await this.#contexts(workspaceId)) {
            const task = (await this.#tasks(workspaceId, context)).find((candidate) => candidate.taskId === taskId);
            if (task !== undefined) return task;
        }
        return null;
    }

    async ownsContext(context: ApplicationWorkerProjection): Promise<boolean> {
        if (context.origin !== "model" || context.parentWorkerId === null) return false;
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return false;
        return (await this.#tasks(workspaceId, context)).length > 0;
    }

    // {§a2a-inbound-exposure} A Context runs one Task at a time: its open Loop, if any.
    async openTask(workspaceId: number, context: ApplicationWorkerProjection): Promise<{ readonly taskId: string | null } | null> {
        const loops = await this.#port.listWorkerLoops({ workspaceId, workerId: context.id });
        const open = loops.find(({ status }) => OPEN_LOOP.has(status));
        return open === undefined ? null : { taskId: PlurnkTaskStore.#identity(open.promptSource)?.taskId ?? null };
    }

    // Model children are candidate Contexts; the A2A sources on their Loops decide.
    async #contexts(workspaceId: number): Promise<ApplicationWorkerProjection[]> {
        return (await this.#port.listWorkers(workspaceId, { origin: "model" }))
            .filter(({ parentWorkerId }) => parentWorkerId !== null);
    }

    // A Task's Loop is the newest Loop its own messages started.
    async #tasks(workspaceId: number, context: ApplicationWorkerProjection): Promise<PlurnkTaskBinding[]> {
        const byTask = new Map<string, ApplicationLoopProjection>();
        for (const loop of await this.#port.listWorkerLoops({ workspaceId, workerId: context.id })) {
            const identity = PlurnkTaskStore.#identity(loop.promptSource);
            if (identity?.contextId === context.name) byTask.set(identity.taskId, loop);
        }
        return [...byTask].map(([taskId, loop]) => ({ workspaceId, context, taskId, loop }));
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
            throw new Error(`A2A Task '${task.id}' has no Plurnk loop.`);
        }
        if (binding.context.name !== task.contextId) {
            throw new Error(
                `A2A Task '${task.id}' belongs to Context '${binding.context.name}', not '${task.contextId}'.`,
            );
        }
        // Core state is authoritative. SDK merge writes validate identity but
        // never create a parallel Task lifecycle in this projection store.
        if (task.status?.state === TaskState.TASK_STATE_CANCELED && OPEN_LOOP.has(binding.loop.status)) {
            await this.#port.cancelWorker({
                workspaceId: binding.workspaceId,
                workerId: binding.context.id,
                reason: "A2A caller cancelled the Task",
            });
        }
    }

    async list(
        params: import("@a2a-js/sdk").ListTasksRequest,
        context: ServerCallContext,
    ): Promise<import("@a2a-js/sdk").ListTasksResponse> {
        this.#assertTenant(context);
        const pageSize = params.pageSize ?? UNSPECIFIED_PAGE;
        const cursor = decodeCursor(params.pageToken);
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };

        let contexts: ApplicationWorkerProjection[];
        if (params.contextId.length > 0) {
            if (!WORKER_NAME.test(params.contextId)) {
                return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };
            }
            const contextWorker = await this.#port.readWorker({
                workspaceId,
                identity: { name: params.contextId },
            });
            contexts = contextWorker === null
                || contextWorker.origin !== "model"
                || contextWorker.parentWorkerId === null
                ? []
                : [contextWorker];
        } else {
            contexts = await this.#contexts(workspaceId);
        }

        const bindings = (await Promise.all(contexts.map((worker) => this.#tasks(workspaceId, worker)))).flat();
        const projected = (await Promise.all(bindings.map((binding) => this.#project(binding))))
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
        const { workspaceId, context, taskId, loop } = binding;
        // The Context worker holds every Task's messages; each Task projects its own.
        const rows = await this.#port.readMessages({
            workspaceId,
            workerId: context.id,
        });
        const state = PlurnkTaskStore.#state(loop.status);
        const statusMessage = PlurnkTaskStore.#statusMessage(
            context.name,
            taskId,
            loop.terminalResult,
        );
        const history = rows
            .filter((row) => row.direction === "inbound"
                && typeof row.source === "string"
                && PlurnkTaskStore.#ownsSource(row.source, context.name, taskId))
            .map((row) => {
                if (row.envelope === undefined) throw new Error(`A2A message ${row.id} lost its protocol envelope.`);
                const admitted = SendMessageRequest.fromJSON(row.envelope).message;
                if (admitted === undefined) throw new Error(`A2A request for message ${row.id} lost its Message.`);
                return admitted;
            });
        const replies = rows.filter((row) => row.direction === "outbound"
            && row.answers.some((address) => PlurnkTaskStore.#ownsSource(address, context.name, taskId)));
        const artifacts: Artifact[] = replies
            .flatMap((row) => row.attachments.map((attachment, index) => ({
                artifactId: createHash("sha256").update(`${taskId}/${row.id}/${index}`).digest("hex").slice(0, 8),
                name: attachment.name,
                description: "",
                parts: [{ content: { $case: "raw" as const, value: Buffer.from(attachment.bytes) },
                    filename: attachment.name, mediaType: attachment.mediaType, metadata: {} }],
                metadata: {}, extensions: [],
            })));
        return {
            id: taskId,
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

    static #state(status: number): TaskState {
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
    ): Message | undefined {
        const detail = result?.problem?.detail;
        return nonempty(detail)
            ? message(`plurnk-terminal-${taskId}`, contextId, taskId, Role.ROLE_AGENT, detail)
            : undefined;
    }

    // {§a2a-inbound-exposure} An A2A message source names its Context and Task.
    static #identity(source: string | null): { readonly contextId: string; readonly taskId: string } | null {
        if (source === null) return null;
        try {
            const url = new URL(source);
            const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
            return url.protocol === "a2a:"
                && segments.length === 6
                && segments[0] === "contexts"
                && segments[2] === "tasks"
                && segments[4] === "messages"
                && segments[5]!.length > 0
                ? { contextId: segments[1]!, taskId: segments[3]! }
                : null;
        } catch {
            return null;
        }
    }

    static #ownsSource(source: string | null, contextId: string, taskId: string): boolean {
        const identity = PlurnkTaskStore.#identity(source);
        return identity?.contextId === contextId && identity.taskId === taskId;
    }
}

import { createHash } from "node:crypto";
import {
    Role,
    TaskState,
    type Artifact,
    SendMessageRequest,
    type Message,
    type Task,
} from "@a2a-js/sdk";
import type { ServerCallContext } from "@a2a-js/sdk/server";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import {
    WORKER_NAME,
    type ApplicationMessage,
    type ApplicationLoopProjection,
    type ApplicationPort,
    type ApplicationWorkerProjection,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import type WorkspaceBinding from "./WorkspaceBinding.ts";

// A2A ListTasks: a request that names no page size asks for fifty. The protocol's, not ours.
const UNSPECIFIED_PAGE = 50;

// {§a2a-inbound-exposure} Protocol identity comes from retained messages, not log placement.
export interface HostedTaskBinding {
    readonly workspaceId: number;
    readonly contextId: string;
    readonly worker: ApplicationWorkerProjection;
    readonly taskId: string;
    readonly loop: ApplicationLoopProjection;
    readonly firstLoopId: number;
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

// The read-only projection boundary.
export type HostedTasksPort = Pick<ApplicationPort,
    "listWorkerLoops" | "listWorkers" | "readMessages">;

export default class HostedTasks {
    readonly #port: HostedTasksPort;
    readonly #workspace: WorkspaceBinding;

    constructor(port: HostedTasksPort, workspace: WorkspaceBinding) {
        this.#port = port;
        this.#workspace = workspace;
    }

    // A Task is open while its Loop is queued, running, or parked.
    static open(loop: ApplicationLoopProjection): boolean {
        return OPEN_LOOP.has(loop.status);
    }

    async binding(taskId: string): Promise<HostedTaskBinding | null> {
        // Identities this exposure never mints cannot name one of its Tasks;
        // they are not malformed Core calls.
        if (!WORKER_NAME.test(taskId)) return null;
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return null;
        return (await HostedTasks.bindings(this.#port, workspaceId)).find((task) => task.taskId === taskId) ?? null;
    }

    static async bindings(port: HostedTasksPort, workspaceId: number): Promise<HostedTaskBinding[]> {
        const byTask = new Map<string, HostedTaskBinding>();
        const workers = await port.listWorkers(workspaceId, { origin: "model" });
        for (const worker of workers) {
            if (worker.parentWorkerId === null) continue;
            for (const loop of await port.listWorkerLoops({ workspaceId, workerId: worker.id })) {
                const identity = HostedTasks.#identity(loop.promptSource);
                if (identity === null) continue;
                const previous = byTask.get(identity.taskId);
                if (previous !== undefined && (previous.contextId !== identity.contextId || previous.worker.id !== worker.id)) {
                    throw new Error(`A2A Task '${identity.taskId}' has conflicting durable ownership.`);
                }
                byTask.set(identity.taskId, {
                    workspaceId, ...identity, worker,
                    loop: previous !== undefined && previous.loop.id > loop.id ? previous.loop : loop,
                    firstLoopId: Math.min(previous?.firstLoopId ?? loop.id, loop.id),
                });
            }
        }
        return [...byTask.values()].toSorted((left, right) => left.firstLoopId - right.firstLoopId);
    }

    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
        this.#assertTenant(context);
        const binding = await this.binding(taskId);
        return binding === null ? undefined : await HostedTasks.project(this.#port, binding);
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

        const bindings = (await HostedTasks.bindings(this.#port, workspaceId))
            .filter((binding) => params.contextId.length === 0 || binding.contextId === params.contextId);
        const projected = (await Promise.all(bindings.map((binding) => HostedTasks.project(this.#port, binding))))
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

    static async project(port: HostedTasksPort, binding: HostedTaskBinding): Promise<Task> {
        const rows = await port.readMessages({ workspaceId: binding.workspaceId, workerId: binding.worker.id });
        return HostedTasks.#project(binding, rows);
    }

    static #project(binding: HostedTaskBinding, rows: readonly ApplicationMessage[]): Task {
        const { contextId, taskId, loop } = binding;
        const state = HostedTasks.#state(loop.status);
        const statusMessage = HostedTasks.#statusMessage(
            contextId,
            taskId,
            loop.terminalResult,
        );
        const history = rows
            .filter((row) => row.direction === "inbound"
                && typeof row.source === "string"
                && HostedTasks.#ownsSource(row.source, contextId, taskId))
            .map((row) => {
                if (row.envelope === undefined) throw new Error(`A2A message ${row.id} lost its protocol envelope.`);
                const admitted = SendMessageRequest.fromJSON(row.envelope).message;
                if (admitted === undefined) throw new Error(`A2A request for message ${row.id} lost its Message.`);
                return admitted;
            });
        const replies = rows.filter((row) => row.direction === "outbound"
            && row.answers.some((address) => HostedTasks.#ownsSource(address, contextId, taskId)));
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
            contextId,
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

    // {§a2a-context-resource} Conversation includes every delivered reply, not just the final artifact.
    static async conversation(port: HostedTasksPort, binding: HostedTaskBinding): Promise<Task> {
        const rows = await port.readMessages({ workspaceId: binding.workspaceId, workerId: binding.worker.id });
        const task = HostedTasks.#project(binding, rows);
        const incoming = new Map(task.history.map((item) => [item.messageId, item]));
        const history: Message[] = [];
        for (const row of rows) {
            if (row.direction === "inbound") {
                if (!HostedTasks.#ownsSource(row.source, task.contextId, task.id)) continue;
                const admitted = SendMessageRequest.fromJSON(row.envelope).message;
                if (admitted !== undefined && incoming.has(admitted.messageId)) history.push(admitted);
            } else if (row.answers.some((address) => HostedTasks.#ownsSource(address, task.contextId, task.id))) {
                const reply = message(createHash("sha256").update(`${task.id}/reply/${row.id}`).digest("hex").slice(0, 8),
                    task.contextId, task.id, Role.ROLE_AGENT, row.body, "text/markdown");
                reply.metadata = { answers: [...row.answers] };
                reply.parts.push(...row.attachments.map((attachment) => ({
                    content: { $case: "raw" as const, value: Buffer.from(attachment.bytes) },
                    filename: attachment.name, mediaType: attachment.mediaType, metadata: {},
                })));
                history.push(reply);
            }
        }
        return { ...task, history };
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
        const identity = HostedTasks.#identity(source);
        return identity?.contextId === contextId && identity.taskId === taskId;
    }
}

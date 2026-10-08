import {
    TaskState,
    SendMessageRequest,
    type Message,
    type Task,
} from "@a2a-js/sdk";
import {
    AgentEvent,
    ServerCallContext,
    type AgentExecutor,
    type ExecutionEventBus,
    type RequestContext,
} from "@a2a-js/sdk/server";
import {
    ContentTypeNotSupportedError,
    RequestMalformedError,
    TaskNotCancelableError,
    UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import {
    Validator,
    WORKER_NAME,
    type ApplicationPort,
    type ApplicationWorkerProjection,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import PlurnkTaskStore from "./PlurnkTaskStore.ts";
import type WorkspaceBinding from "./WorkspaceBinding.ts";

// {§a2a-inbound-exposure} The Loop a Task started or continued, on its Context worker.
interface StartedTask {
    readonly context: ApplicationWorkerProjection;
    readonly loopId: number;
}

const taskSnapshot = (request: RequestContext): Task => ({
    id: request.taskId,
    contextId: request.contextId,
    status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: undefined,
    },
    artifacts: [],
    history: request.task?.history ?? [request.userMessage],
    metadata: {},
});

const statusEvent = (task: Task) => ({
    taskId: task.id,
    contextId: task.contextId,
    status: task.status,
    metadata: {},
});

const textOf = (message: Message): string => {
    if (message.parts.length === 0) throw new RequestMalformedError("The A2A Message has no Parts.");
    const text = message.parts.flatMap(({ content }) => {
        if (content === undefined) throw new ContentTypeNotSupportedError("A Message Part has no content.");
        switch (content.$case) {
            case "text": return [content.value];
            case "data": return [JSON.stringify(content.value, null, 2)];
            case "url": return [content.value];
            case "raw": return [];
        }
    }).join("\n");
    if (text.trim().length === 0 && !message.parts.some((part) => part.content?.$case === "raw")) {
        throw new RequestMalformedError("The A2A Message has no non-empty content.");
    }
    return text;
};

// The port functions the executor calls.
export type ExecutorPort = Pick<ApplicationPort,
    | "cancelWorker" | "createConversationWorker"
    | "readWorker" | "ensureRuntimeWorker" | "runLoop" | "subscribeToEvents">;

export default class PlurnkAgentExecutor implements AgentExecutor {
    readonly #port: ExecutorPort;
    readonly #workspace: WorkspaceBinding;
    readonly #store: PlurnkTaskStore;
    readonly #parentWorker: string;
    readonly #contextLocks = new Map<string, Promise<void>>();
    readonly #ownedContexts = new Set<string>();
    readonly #activeTasks = new Set<string>();

    constructor(port: ExecutorPort, workspace: WorkspaceBinding, store: PlurnkTaskStore, parentWorker: string) {
        this.#port = port;
        this.#workspace = workspace;
        this.#store = store;
        this.#parentWorker = parentWorker;
    }

    async validateMessage(message: Message | undefined): Promise<void> {
        if (message === undefined) return; // The SDK owns required envelope fields.
        textOf(message);
        // A new Task in a Context that is still working is refused before execution.
        if (message.taskId.length > 0 || !WORKER_NAME.test(message.contextId)) return;
        const workspaceId = await this.#workspace.existingId();
        if (workspaceId === null) return;
        const context = await this.#port.readWorker({ workspaceId, identity: { name: message.contextId } });
        if (context !== null && (this.#ownedContexts.has(context.name) || await this.#store.ownsContext(context))) {
            await this.#assertIdle(workspaceId, context);
        }
    }

    async execute(request: RequestContext, events: ExecutionEventBus): Promise<void> {
        this.#activeTasks.add(request.taskId);
        try {
            const workspaceId = await this.#workspace.id();
            const snapshot = request.task ?? taskSnapshot(request);

            await this.#observe(workspaceId, () => this.#start(workspaceId, request, async (context) => {
                const envelope = SendMessageRequest.toJSON({
                    ...request.request,
                    message: { ...request.userMessage, contextId: request.contextId, taskId: request.taskId },
                }) as Record<string, unknown>;
                const text = textOf(request.userMessage);
                const modes = request.request.configuration?.acceptedOutputModes ?? [];
                const body = modes.length === 0 ? text
                    : [text, `Accepted output media types: ${JSON.stringify(modes)}`].filter(Boolean).join("\n\n");
                const started = await this.#port.runLoop({
                    workspaceId,
                    workerId: context.id,
                    prompt: body,
                    envelope,
                    attachments: request.userMessage.parts.flatMap((part) => part.content?.$case === "raw" ? [{
                        name: part.filename,
                        mediaType: part.mediaType || "application/octet-stream",
                        bytes: part.content.value,
                    }] : []),
                    source: PlurnkAgentExecutor.#source(request),
                    messageAddress: PlurnkAgentExecutor.#source(request),
                });
                return started.loopId;
            }), () => {
                events.publish(AgentEvent.task(snapshot));
                const working: Task = {
                    ...snapshot,
                    status: {
                        state: TaskState.TASK_STATE_WORKING,
                        message: undefined,
                        timestamp: undefined,
                    },
                };
                events.publish(AgentEvent.statusUpdate(statusEvent(working)));
            });

            const projected = await this.#store.load(request.taskId, request.context);
            if (projected === undefined) {
                throw new Error(`A2A Task '${request.taskId}' disappeared after Plurnk execution.`);
            }
            for (const artifact of projected.artifacts) {
                events.publish(AgentEvent.artifactUpdate({
                    taskId: projected.id,
                    contextId: projected.contextId,
                    artifact,
                    append: false,
                    lastChunk: true,
                    metadata: {},
                }));
            }
            events.publish(AgentEvent.statusUpdate(statusEvent(projected)));
        } finally {
            this.#activeTasks.delete(request.taskId);
        }
    }

    async cancelTask(taskId: string, events: ExecutionEventBus): Promise<void> {
        const binding = await this.#store.binding(taskId);
        if (binding === null) throw new Error(`A2A Task '${taskId}' has no Plurnk loop.`);
        const { workspaceId, context, loop } = binding;
        if (!PlurnkTaskStore.open(loop)) throw new TaskNotCancelableError(`A2A Task '${taskId}' has already finished.`);
        const activeExecutorWillPublish = this.#activeTasks.has(taskId);
        // One Task at a time: cancelling its Context's work cancels exactly that Task.
        const result = await this.#observe(workspaceId, async () => {
            await this.#port.cancelWorker({
                workspaceId,
                workerId: context.id,
                reason: "A2A caller cancelled the Task",
            });
            return { context, loopId: loop.id };
        }, () => {});
        if (result.status !== 499) {
            throw new Error(`A2A Task '${taskId}' did not terminate as cancelled.`);
        }
        const projected = await this.#store.load(taskId, new ServerCallContext());
        if (projected === undefined || projected.status?.state !== TaskState.TASK_STATE_CANCELED) {
            throw new Error(`A2A Task '${taskId}' did not enter the cancelled state.`);
        }
        if (!activeExecutorWillPublish) {
            events.publish(AgentEvent.statusUpdate(statusEvent(projected)));
        }
    }

    // {§a2a-inbound-exposure} Resolve the Context and start or continue the Task's Loop under the
    // Context's lock, so two Tasks of one Context can never start together.
    async #start(
        workspaceId: number,
        request: RequestContext,
        run: (context: ApplicationWorkerProjection) => Promise<number>,
    ): Promise<StartedTask> {
        if (!WORKER_NAME.test(request.contextId)) {
            throw new RequestMalformedError(`Context identity '${request.contextId}' cannot name a Plurnk worker.`);
        }
        if (!WORKER_NAME.test(request.taskId)) {
            throw new RequestMalformedError(`Task identity '${request.taskId}' is not one this exposure mints.`);
        }
        let started: StartedTask | null = null;
        await this.#serialize(request.contextId, async () => {
            const context = await this.#context(workspaceId, request);
            started = { context, loopId: await run(context) };
        });
        if (started === null) throw new Error(`A2A Task '${request.taskId}' did not start.`);
        return started;
    }

    async #context(workspaceId: number, request: RequestContext): Promise<ApplicationWorkerProjection> {
        if (request.task !== undefined) {
            // A continuation folds into its Task's own open Loop.
            const binding = await this.#store.binding(request.taskId);
            if (binding === null) throw new RequestMalformedError(`A2A Task '${request.taskId}' has no Plurnk loop.`);
            if (binding.context.name !== request.contextId) {
                throw new RequestMalformedError(
                    `A2A Task '${request.taskId}' does not belong to Context '${request.contextId}'.`,
                );
            }
            if (!PlurnkTaskStore.open(binding.loop)) {
                throw new UnsupportedOperationError(
                    `A2A Task '${request.taskId}' has finished; start a new Task in its Context.`,
                );
            }
            this.#ownedContexts.add(request.contextId);
            return binding.context;
        }
        const existing = await this.#port.readWorker({ workspaceId, identity: { name: request.contextId } });
        if (existing === null) {
            const created = await this.#port.createConversationWorker({
                workspaceId,
                name: request.contextId,
                parentWorkerId: await this.#parent(workspaceId),
            });
            const projected = await this.#port.readWorker({ workspaceId, identity: { id: created.workerId } });
            if (projected === null) throw new Error(`A2A Context '${request.contextId}' was not visible after creation.`);
            this.#ownedContexts.add(request.contextId);
            return projected;
        }
        if (existing.origin !== "model" || existing.parentWorkerId === null) {
            throw new RequestMalformedError(`A2A Context '${request.contextId}' is not a child model Worker.`);
        }
        if (!this.#ownedContexts.has(request.contextId) && !await this.#store.ownsContext(existing)) {
            throw new RequestMalformedError(`A2A Context '${request.contextId}' is not owned by this exposure.`);
        }
        this.#ownedContexts.add(request.contextId);
        await this.#assertIdle(workspaceId, existing);
        return existing;
    }

    // {§a2a-inbound-exposure} A Context is one conversation, and it runs one Task at a time.
    async #assertIdle(workspaceId: number, context: ApplicationWorkerProjection): Promise<void> {
        const open = await this.#store.openTask(workspaceId, context);
        if (open === null) return;
        throw new UnsupportedOperationError(open.taskId === null
            ? `A2A Context '${context.name}' is still working; wait for it to finish.`
            : `A2A Context '${context.name}' is still working on Task '${open.taskId}'. `
                + "Continue that Task, wait for it to finish, or cancel it.");
    }

    async #parent(workspaceId: number): Promise<number> {
        if (this.#parentWorker === "_plurnk") return this.#port.ensureRuntimeWorker(workspaceId);
        const parent = await this.#port.readWorker({ workspaceId, identity: { name: this.#parentWorker } });
        if (parent === null) throw new RequestMalformedError(`Configured A2A parent Worker '${this.#parentWorker}' does not exist.`);
        return parent.id;
    }

    // Subscribes before starting, so a fast Loop's termination is never missed.
    async #observe(
        workspaceId: number,
        start: () => Promise<StartedTask>,
        started: () => void,
    ): Promise<OperationResult> {
        const terminated = new Map<string, unknown>();
        let target: string | null = null;
        const settled = Promise.withResolvers<OperationResult>();
        const unsubscribe = this.#port.subscribeToEvents((eventWorkspace, method, params) => {
            if (eventWorkspace !== workspaceId || method !== "loop/terminated" || typeof params !== "object" || params === null) return;
            const candidate = params as Record<string, unknown>;
            const key = `${String(candidate.workerId)}/${String(candidate.loopId)}`;
            if (key === target) settled.resolve(Validator.assertOperationResult(candidate.result as OperationResult));
            else terminated.set(key, candidate.result);
        });
        try {
            const { context, loopId } = await start();
            target = `${context.id}/${loopId}`;
            if (terminated.has(target)) {
                settled.resolve(Validator.assertOperationResult(terminated.get(target) as OperationResult));
            }
            started();
            return await settled.promise;
        } finally {
            unsubscribe();
        }
    }

    async #serialize(key: string, action: () => Promise<void>): Promise<void> {
        const prior = this.#contextLocks.get(key) ?? Promise.resolve();
        const current = prior.catch(() => {}).then(action);
        this.#contextLocks.set(key, current);
        try {
            await current;
        } finally {
            if (this.#contextLocks.get(key) === current) this.#contextLocks.delete(key);
        }
    }

    static #source(request: RequestContext): string {
        return `a2a://anonymous/contexts/${encodeURIComponent(request.contextId)}`
            + `/tasks/${encodeURIComponent(request.taskId)}`
            + `/messages/${encodeURIComponent(request.userMessage.messageId)}`;
    }
}

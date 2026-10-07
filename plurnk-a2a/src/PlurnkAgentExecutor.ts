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
} from "@a2a-js/sdk/errors";
import {
    Validator,
    WORKER_NAME,
    type ApplicationPort,
    type ApplicationWorkerProjection,
    type ClientInteractionProjection,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import PlurnkTaskStore, { type PlurnkTaskBinding } from "./PlurnkTaskStore.ts";
import type WorkspaceBinding from "./WorkspaceBinding.ts";

type ExecutionOutcome =
    | { readonly kind: "terminated"; readonly result: OperationResult }
    | { readonly kind: "interaction"; readonly interaction: ClientInteractionProjection };

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
    | "cancelWorker" | "createConversationWorker" | "forkWorker" | "pendingClientInteractions"
    | "readWorker" | "ensureRuntimeWorker" | "resolveClientInteraction" | "runLoop" | "subscribeToEvents">;

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
        const binding = message.taskId.length > 0 ? await this.#store.binding(message.taskId) : null;
        const pending = binding === null ? undefined
            : (await this.#port.pendingClientInteractions(binding.workspaceId))
                .find((interaction) => interaction.workerId === binding.task.id
                    && interaction.loopId === binding.loop?.id
                    && interaction.recipient === PlurnkTaskStore.replyAddress(binding));
        if (pending !== undefined) this.#interactionPayload(message, pending);
        else textOf(message);
    }

    async execute(request: RequestContext, events: ExecutionEventBus): Promise<void> {
        this.#activeTasks.add(request.taskId);
        try {
            const workspaceId = await this.#workspace.id();
            const binding = await this.#ensureBinding(request);
            const snapshot = request.task ?? taskSnapshot(request);

            const pending = (await this.#port.pendingClientInteractions(workspaceId))
                .find((interaction) => interaction.workerId === binding.task.id
                    && interaction.recipient === PlurnkTaskStore.replyAddress(binding)) ?? null;
            const outcome = await this.#observe(binding, async () => {
                const envelope = SendMessageRequest.toJSON({
                    ...request.request,
                    message: { ...request.userMessage, contextId: request.contextId, taskId: request.taskId },
                }) as Record<string, unknown>;
                const text = textOf(request.userMessage);
                const modes = request.request.configuration?.acceptedOutputModes ?? [];
                const body = modes.length === 0 ? text
                    : [text, `Accepted output media types: ${JSON.stringify(modes)}`].filter(Boolean).join("\n\n");
                if (pending !== null) {
                    await this.#port.resolveClientInteraction(
                        pending.interactionId,
                        { status: "resolved", payload: this.#interactionPayload(request.userMessage, pending) },
                        { workspaceId, address: PlurnkTaskStore.replyAddress(binding) },
                        { body, source: PlurnkAgentExecutor.#source(request), envelope },
                    );
                    return;
                }
                await this.#port.runLoop({
                    workspaceId,
                    workerId: binding.task.id,
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
            }, () => {
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
            if (outcome.kind === "interaction") {
                if (projected.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
                    throw new Error(`A2A Task '${request.taskId}' did not project its pending interaction.`);
                }
                events.publish(AgentEvent.statusUpdate(statusEvent(projected)));
                return;
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
        if (binding === null) throw new Error(`A2A Task '${taskId}' has no Plurnk worker.`);
        const { workspaceId } = binding;
        const activeExecutorWillPublish = this.#activeTasks.has(taskId);
        const outcome = await this.#observe(binding, async () => {
            await this.#port.cancelWorker({
                workspaceId,
                workerId: binding.task.id,
                reason: "A2A caller cancelled the Task",
            });
        }, () => {});
        if (outcome.kind !== "terminated" || outcome.result.status !== 499) {
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

    async #ensureBinding(request: RequestContext): Promise<PlurnkTaskBinding> {
        const workspaceId = await this.#workspace.id();
        for (const [label, value] of [["Context", request.contextId], ["Task", request.taskId]] as const) {
            if (!WORKER_NAME.test(value)) {
                throw new RequestMalformedError(`${label} identity '${value}' cannot name a Plurnk worker.`);
            }
        }
        let resolved: PlurnkTaskBinding | null = null;
        await this.#serialize(request.contextId, async () => {
            const existingTask = await this.#store.binding(request.taskId);
            if (existingTask !== null) {
                if (existingTask.context.name !== request.contextId) {
                    throw new RequestMalformedError(
                        `A2A Task '${request.taskId}' does not belong to Context '${request.contextId}'.`,
                    );
                }
                this.#ownedContexts.add(request.contextId);
                resolved = existingTask;
                return;
            }
            if (request.task !== undefined) {
                throw new RequestMalformedError(`A2A Task '${request.taskId}' has no Plurnk binding.`);
            }

            const existingContext = await this.#port.readWorker({
                workspaceId,
                identity: { name: request.contextId },
            });
            let context: ApplicationWorkerProjection;
            if (existingContext === null) {
                if (request.task !== undefined) {
                    throw new RequestMalformedError(`A2A Context '${request.contextId}' does not exist.`);
                }
                const created = await this.#port.createConversationWorker({
                    workspaceId,
                    name: request.contextId,
                    parentWorkerId: await this.#parent(workspaceId),
                });
                const projected = await this.#port.readWorker({ workspaceId, identity: { id: created.workerId } });
                if (projected === null) throw new Error(`A2A Context '${request.contextId}' was not visible after creation.`);
                context = projected;
                this.#ownedContexts.add(request.contextId);
            } else {
                if (existingContext.origin !== "model" || existingContext.parentWorkerId === null) {
                    throw new RequestMalformedError(
                        `A2A Context '${request.contextId}' is not a child model Worker.`,
                    );
                }
                if (
                    !this.#ownedContexts.has(request.contextId)
                    && !await this.#store.ownsContext(existingContext)
                ) {
                    throw new RequestMalformedError(
                        `A2A Context '${request.contextId}' is not owned by this exposure.`,
                    );
                }
                this.#ownedContexts.add(request.contextId);
                context = existingContext;
            }

            const created = await this.#port.forkWorker({
                workspaceId,
                workerId: context.id,
                name: request.taskId,
            });
            const task = await this.#port.readWorker({
                workspaceId,
                identity: { id: created.workerId },
            });
            if (task === null) throw new Error(`A2A Task '${request.taskId}' was not visible after creation.`);
            resolved = { workspaceId, context, task, loop: null };
        });
        if (resolved === null) throw new Error(`A2A Task '${request.taskId}' has no Plurnk binding.`);
        return resolved;
    }

    async #parent(workspaceId: number): Promise<number> {
        if (this.#parentWorker === "_plurnk") return this.#port.ensureRuntimeWorker(workspaceId);
        const parent = await this.#port.readWorker({ workspaceId, identity: { name: this.#parentWorker } });
        if (parent === null) throw new RequestMalformedError(`Configured A2A parent Worker '${this.#parentWorker}' does not exist.`);
        return parent.id;
    }

    async #observe(
        binding: PlurnkTaskBinding,
        action: () => Promise<void>,
        started: () => void,
    ): Promise<ExecutionOutcome> {
        const settled = Promise.withResolvers<ExecutionOutcome>();
        const unsubscribe = this.#port.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId !== binding.workspaceId || typeof params !== "object" || params === null) return;
            const candidate = params as Record<string, unknown>;
            if (candidate.workerId !== binding.task.id) return;
            if (method === "loop/terminated") {
                settled.resolve({
                    kind: "terminated",
                    result: Validator.assertOperationResult(candidate.result as OperationResult),
                });
            } else if (method === "loop/interaction" && candidate.recipient === PlurnkTaskStore.replyAddress(binding)) {
                settled.resolve({
                    kind: "interaction",
                    interaction: candidate as unknown as ClientInteractionProjection,
                });
            }
        });
        try {
            await action();
            started();
            return await settled.promise;
        } finally {
            unsubscribe();
        }
    }

    #interactionPayload(message: Message, interaction: ClientInteractionProjection): unknown {
        const data = message.parts.filter(({ content }) => content?.$case === "data");
        let candidate: unknown = data.length === 1 && message.parts.length === 1
            ? data[0]!.content?.value
            : textOf(message);
        let admitted = Validator.validateJsonSchemaInstance(interaction.request.responseSchema, candidate);
        if (!admitted.valid) {
            const schema = interaction.request.responseSchema;
            const properties = schema.properties;
            const required = schema.required;
            if (
                schema.type === "object"
                && typeof properties === "object"
                && properties !== null
                && !Array.isArray(properties)
                && Array.isArray(required)
                && required.length === 1
                && typeof required[0] === "string"
            ) {
                candidate = { [required[0]]: candidate };
                admitted = Validator.validateJsonSchemaInstance(interaction.request.responseSchema, candidate);
            }
        }
        if (!admitted.valid) {
            throw new RequestMalformedError(
                `The A2A Message does not satisfy the pending '${interaction.request.toolName}' response schema.`,
            );
        }
        return candidate;
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

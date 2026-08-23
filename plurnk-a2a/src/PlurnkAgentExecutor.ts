import {
    TaskState,
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
    const unsupported = message.parts.find(({ content }) => content?.$case !== "text");
    if (unsupported !== undefined) {
        throw new ContentTypeNotSupportedError(
            "This Plurnk A2A exposure currently accepts text Message parts only.",
        );
    }
    const text = message.parts
        .flatMap((part) => part.content?.$case === "text" ? [part.content.value] : [])
        .join("\n")
        .trim();
    if (text.length === 0) throw new RequestMalformedError("The A2A Message has no non-empty text content.");
    return text;
};

export default class PlurnkAgentExecutor implements AgentExecutor {
    readonly #port: ApplicationPort;
    readonly #workspace: WorkspaceBinding;
    readonly #store: PlurnkTaskStore;
    readonly #contextLocks = new Map<string, Promise<void>>();
    readonly #ownedContexts = new Set<string>();
    readonly #activeTasks = new Set<string>();

    constructor(port: ApplicationPort, workspace: WorkspaceBinding, store: PlurnkTaskStore) {
        this.#port = port;
        this.#workspace = workspace;
        this.#store = store;
    }

    async execute(request: RequestContext, events: ExecutionEventBus): Promise<void> {
        this.#activeTasks.add(request.taskId);
        try {
            const workspaceId = await this.#workspace.id();
            const binding = await this.#ensureBinding(request);
            const snapshot = request.task ?? taskSnapshot(request);

            const pending = (await this.#port.pendingClientInteractions(workspaceId))
                .find((interaction) => interaction.workerId === binding.task.id) ?? null;
            const outcome = await this.#observe(binding.task.id, async () => {
                if (pending !== null) {
                    await this.#port.resolveClientInteraction(
                        pending.interactionId,
                        { status: "resolved", payload: this.#interactionPayload(request.userMessage, pending) },
                    );
                    return;
                }
                await this.#port.runLoop({
                    workspaceId,
                    workerId: binding.task.id,
                    prompt: textOf(request.userMessage),
                    source: PlurnkAgentExecutor.#source(request),
                    flags: { noProposals: true },
                });
            }, workspaceId, () => {
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
        const workspaceId = await this.#workspace.id();
        const binding = await this.#store.binding(taskId);
        if (binding === null) throw new Error(`A2A Task '${taskId}' has no Plurnk worker.`);
        const activeExecutorWillPublish = this.#activeTasks.has(taskId);
        const outcome = await this.#observe(binding.task.id, async () => {
            await this.#port.cancelWorker({
                workspaceId,
                workerId: binding.task.id,
                reason: "A2A caller cancelled the Task",
            });
        }, workspaceId, () => {});
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
                });
                context = {
                    id: created.workerId,
                    name: created.workerName,
                    created_at: "",
                    origin: "model",
                    parentWorkerId: null,
                };
                this.#ownedContexts.add(request.contextId);
            } else {
                if (existingContext.origin !== "model" || existingContext.parentWorkerId !== null) {
                    throw new RequestMalformedError(
                        `A2A Context '${request.contextId}' is not a root model Worker.`,
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
            await this.#port.setWorkerSettings({
                workspaceId,
                workerId: task.id,
                settings: { requestUserInput: true },
            });
            resolved = { context, task, loop: null };
        });
        if (resolved === null) throw new Error(`A2A Task '${request.taskId}' has no Plurnk binding.`);
        return resolved;
    }

    async #observe(
        workerId: number,
        action: () => Promise<void>,
        boundWorkspaceId: number,
        started: () => void,
    ): Promise<ExecutionOutcome> {
        const settled = Promise.withResolvers<ExecutionOutcome>();
        const unsubscribe = this.#port.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId !== boundWorkspaceId || typeof params !== "object" || params === null) return;
            const candidate = params as Record<string, unknown>;
            if (candidate.workerId !== workerId) return;
            if (method === "loop/terminated") {
                settled.resolve({
                    kind: "terminated",
                    result: Validator.assertOperationResult(candidate.result as OperationResult),
                });
            } else if (method === "loop/interaction") {
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

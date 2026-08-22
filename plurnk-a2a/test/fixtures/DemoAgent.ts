import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
    A2A_PROTOCOL_VERSION,
    AGENT_CARD_PATH,
    Role,
    type AgentCard,
    TaskState,
    type Artifact,
    type Message,
    type Task,
} from "@a2a-js/sdk";
import {
    AgentEvent,
    DefaultRequestHandler,
    InMemoryTaskStore,
    type AgentExecutor,
    type ExecutionEventBus,
    type RequestContext,
} from "@a2a-js/sdk/server";
import {
    UserBuilder,
    agentCardHandler,
    restHandler,
} from "@a2a-js/sdk/server/express";
import express from "express";

type DemoMode =
    | "complete"
    | "direct-message"
    | "input-required"
    | "multiple-artifacts"
    | "wait-for-cancel";

const extractText = (request: RequestContext): string => request.userMessage.parts
    .flatMap((part) => part.content?.$case === "text" ? [part.content.value] : [])
    .join("\n");

const agentMessage = (
    contextId: string,
    text: string,
    taskId = "",
): Message => ({
    messageId: randomUUID(),
    role: Role.ROLE_AGENT,
    parts: [{
        content: { $case: "text", value: text },
        filename: "",
        mediaType: "text/plain",
        metadata: {},
    }],
    taskId,
    contextId,
    extensions: [],
    metadata: {},
    referenceTaskIds: [],
});

const artifact = (name: string, value: string): Artifact => ({
    artifactId: randomUUID(),
    name,
    description: `Deterministic ${name} A2A witness result`,
    parts: [{
        content: { $case: "text", value },
        filename: `${name}.txt`,
        mediaType: "text/plain",
        metadata: {},
    }],
    metadata: {},
    extensions: [],
});

class DemoAgentExecutor implements AgentExecutor {
    readonly received: RequestContext[] = [];
    readonly #mode: DemoMode;
    readonly #release = new Map<string, () => void>();

    constructor(mode: DemoMode) {
        this.#mode = mode;
    }

    async execute(request: RequestContext, events: ExecutionEventBus): Promise<void> {
        this.received.push(request);
        const { contextId, taskId, userMessage } = request;
        if (this.#mode === "direct-message") {
            events.publish(AgentEvent.message(agentMessage(
                contextId,
                `direct: ${extractText(request)}`,
            )));
            return;
        }

        const task: Task = request.task ?? {
            id: taskId,
            contextId,
            status: {
                state: TaskState.TASK_STATE_SUBMITTED,
                timestamp: new Date().toISOString(),
                message: undefined,
            },
            artifacts: [],
            history: [userMessage],
            metadata: {},
        };
        events.publish(AgentEvent.task(task));

        let cancellation: Promise<void> | undefined;
        if (this.#mode === "wait-for-cancel") {
            cancellation = new Promise((resolve) => {
                this.#release.set(taskId, resolve);
            });
        }

        events.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
                state: TaskState.TASK_STATE_WORKING,
                timestamp: new Date().toISOString(),
                message: undefined,
            },
            metadata: {},
        }));

        if (cancellation !== undefined) {
            await cancellation;
            this.#release.delete(taskId);
            return;
        }

        if (
            this.#mode === "input-required"
            && request.task?.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED
        ) {
            events.publish(AgentEvent.statusUpdate({
                taskId,
                contextId,
                status: {
                    state: TaskState.TASK_STATE_INPUT_REQUIRED,
                    timestamp: new Date().toISOString(),
                    message: agentMessage(
                        contextId,
                        "Which origin and destination?",
                        taskId,
                    ),
                },
                metadata: {},
            }));
            return;
        }

        const artifacts = this.#mode === "multiple-artifacts"
            ? [
                artifact("summary", `summary: ${extractText(request)}`),
                artifact("evidence", `evidence: ${extractText(request)}`),
            ]
            : [artifact("answer", `received: ${extractText(request)}`)];
        for (const produced of artifacts) {
            events.publish(AgentEvent.artifactUpdate({
                taskId,
                contextId,
                artifact: produced,
                append: false,
                lastChunk: true,
                metadata: {},
            }));
        }
        events.publish(AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
                state: TaskState.TASK_STATE_COMPLETED,
                timestamp: new Date().toISOString(),
                message: undefined,
            },
            metadata: {},
        }));
    }

    async cancelTask(taskId: string, events: ExecutionEventBus): Promise<void> {
        const request = this.received.find((candidate) => candidate.taskId === taskId);
        const release = this.#release.get(taskId);
        if (request === undefined || release === undefined) {
            throw new Error(`A2A witness task ${taskId} is not awaiting cancellation`);
        }
        events.publish(AgentEvent.statusUpdate({
            taskId,
            contextId: request.contextId,
            status: {
                state: TaskState.TASK_STATE_CANCELED,
                timestamp: new Date().toISOString(),
                message: undefined,
            },
            metadata: {},
        }));
        release();
    }
}

export interface DemoAgent {
    baseUrl: string;
    endpoint: string;
    card: AgentCard;
    executor: DemoAgentExecutor;
    close(): Promise<void>;
}

const listen = (server: Server): Promise<void> => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
    });
});

const close = (server: Server): Promise<void> => new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
});

export const startDemoAgent = async (mode: DemoMode = "complete"): Promise<DemoAgent> => {
    const app = express();
    const server = createServer(app);
    const executor = new DemoAgentExecutor(mode);
    const card: AgentCard = {
        name: "Plurnk A2A protocol witness",
        description: "Independent deterministic A2A v1 test agent",
        supportedInterfaces: [{
            url: "",
            protocolBinding: "HTTP+JSON",
            protocolVersion: A2A_PROTOCOL_VERSION,
            tenant: "",
        }],
        provider: {
            organization: "Plurnk",
            url: "https://plurnk.xyz",
        },
        version: "1.0.0",
        capabilities: {
            streaming: true,
            pushNotifications: false,
            extensions: [],
            extendedAgentCard: false,
        },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [{
            id: "echo",
            name: "Echo",
            description: "Returns deterministic evidence for protocol tests",
            tags: ["test"],
            examples: ["hello"],
            inputModes: ["text/plain"],
            outputModes: ["text/plain"],
            securityRequirements: [],
        }],
        documentationUrl: "",
        signatures: [],
    };
    const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
    app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
    app.use("/a2a", restHandler({
        requestHandler: handler,
        userBuilder: UserBuilder.noAuthentication,
    }));

    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
        await close(server);
        throw new Error("A2A witness did not receive a TCP address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const endpoint = `${baseUrl}/a2a`;
    card.supportedInterfaces[0]!.url = endpoint;
    return {
        baseUrl,
        endpoint,
        card,
        executor,
        close: () => close(server),
    };
};
